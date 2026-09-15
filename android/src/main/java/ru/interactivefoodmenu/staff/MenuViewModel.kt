package ru.interactivefoodmenu.staff

import android.app.Application
import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.tasks.await
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.FirebaseNetworkException
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.functions.FirebaseFunctionsException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import ru.interactivefoodmenu.staff.data.MenuRepository
import ru.interactivefoodmenu.staff.model.MenuCategory
import ru.interactivefoodmenu.staff.model.MenuItem
import ru.interactivefoodmenu.staff.model.MenuOcrParser
import ru.interactivefoodmenu.staff.model.CsvMenuParser
import ru.interactivefoodmenu.staff.model.MenuSnapshot
import ru.interactivefoodmenu.staff.model.Validation

enum class AppScreen { LOGIN, MENU, MANAGE }

data class UiState(
    val screen: AppScreen = AppScreen.LOGIN,
    val initializing: Boolean = true,
    val configMissing: Boolean = false,
    val venueCode: String = "",
    val pin: String = "",
    val venueId: String? = null,
    val menu: MenuSnapshot = MenuSnapshot(),
    val menuError: String? = null,
    val availabilityErrors: Map<String, String> = emptyMap(),
    val query: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val message: String? = null,
    val displayUrl: String = "",
    val ocrBusy: Boolean = false,
    val ocrPreview: String? = null,
)

class MenuViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as MenuApplication
    private val repository: MenuRepository? = app.repository
    private val _state = MutableStateFlow(UiState(configMissing = repository == null))
    val state: StateFlow<UiState> = _state.asStateFlow()
    private var menuJob: Job? = null
    private val pendingAvailability = mutableMapOf<String, Boolean>()

    init {
        viewModelScope.launch {
            val savedCode = app.preferences.venueCode.first()
            _state.update { it.copy(venueCode = savedCode) }
            val restored = runCatching { repository?.restoredVenueId() }.getOrNull()
            if (restored != null) attach(restored) else _state.update { it.copy(initializing = false) }
        }
    }

    fun setVenueCode(value: String) = _state.update { it.copy(venueCode = value.lowercase().filter { char -> char.isLetterOrDigit() || char == '-' }, error = null) }
    fun setPin(value: String) = _state.update { it.copy(pin = value.filter(Char::isDigit).take(6), error = null) }
    fun setQuery(value: String) = _state.update { it.copy(query = value) }
    fun showMenu() = _state.update { it.copy(screen = AppScreen.MENU, error = null) }
    fun showManage() = _state.update { it.copy(screen = AppScreen.MANAGE, error = null) }
    fun clearMessage() = _state.update { it.copy(message = null) }
    fun closeOcrPreview() = _state.update { it.copy(ocrPreview = null) }

    fun importMenuPhoto(uri: Uri) {
        viewModelScope.launch {
            _state.update { it.copy(ocrBusy = true, error = null) }
            runCatching {
                val image = InputImage.fromFilePath(getApplication(), uri)
                val result = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS).process(image).await()
                MenuOcrParser.parse(result.text).joinToString("\\n") { row ->
                    listOfNotNull(row.category?.let { "[$it]" }, row.name, row.price?.let { "$it ₽" }).joinToString(" — ")
                }.ifBlank { result.text }
            }.onSuccess { preview -> _state.update { it.copy(ocrBusy = false, ocrPreview = preview) } }
                .onFailure { error -> _state.update { it.copy(ocrBusy = false, error = "Не удалось распознать фото: ${error.message ?: "проверьте качество снимка"}") } }
        }
    }

    fun importCsv(uri: Uri) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            runCatching {
                val content = getApplication<Application>().contentResolver.openInputStream(uri)
                    ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
                    ?: error("Не удалось прочитать CSV-файл.")
                val rows = CsvMenuParser.parse(content)
                repository?.importItems(_state.value.venueId ?: error("Сначала войдите в заведение."), _state.value.menu.categories, _state.value.menu.items, rows)
                rows.size
            }.onSuccess { count -> _state.update { it.copy(busy = false, message = "Импортировано позиций: $count") } }
                .onFailure { error -> _state.update { it.copy(busy = false, error = "Не удалось импортировать CSV: ${error.message ?: "проверьте файл"}") } }
        }
    }

    fun login() {
        val current = _state.value
        if (current.venueCode.length !in 3..32 || current.pin.length != 6 || repository == null) {
            _state.update { it.copy(error = "Введите код заведения и шестизначный PIN.") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            runCatching {
                val installationId = app.preferences.installationId()
                repository.login(current.venueCode, current.pin, installationId)
            }.onSuccess { venueId ->
                app.preferences.saveVenueCode(current.venueCode)
                _state.update { it.copy(pin = "", busy = false) }
                attach(venueId)
            }.onFailure { error ->
                _state.update { it.copy(busy = false, error = readable(error)) }
            }
        }
    }

    private fun attach(venueId: String) {
        menuJob?.cancel()
        _state.update { it.copy(venueId = venueId, screen = AppScreen.MENU, initializing = false, menuError = null, error = null) }
        menuJob = viewModelScope.launch {
            repository?.observeMenu(venueId)
                ?.catch { error ->
                    _state.update { it.copy(menuError = readable(error)) }
                }
                ?.collect { menu ->
                    val visibleMenu = menu.copy(items = menu.items.map { item ->
                        pendingAvailability[item.id]?.let { item.copy(isAvailable = it) } ?: item
                    })
                    _state.update { it.copy(menu = visibleMenu, menuError = null) }
                }
        }
    }

    fun retryMenu() {
        _state.value.venueId?.let(::attach)
    }

    fun toggle(item: MenuItem, unavailable: Boolean) {
        val currentItem = _state.value.menu.items.firstOrNull { it.id == item.id } ?: item
        val nextAvailability = !unavailable
        pendingAvailability[item.id] = nextAvailability
        _state.update { state ->
            state.copy(
                menu = state.menu.copy(items = state.menu.items.map { current ->
                    if (current.id == item.id) current.copy(isAvailable = nextAvailability) else current
                }),
                availabilityErrors = state.availabilityErrors - item.id,
            )
        }
        viewModelScope.launch {
            runCatching {
                (repository ?: error("Firebase не настроен.")).setAvailability(currentItem, nextAvailability)
            }.onSuccess {
                if (pendingAvailability[item.id] == nextAvailability) pendingAvailability.remove(item.id)
            }.onFailure { error ->
                if (pendingAvailability[item.id] == nextAvailability) pendingAvailability.remove(item.id)
                _state.update { state ->
                    state.copy(
                        menu = state.menu.copy(items = state.menu.items.map { current ->
                            if (current.id == item.id && current.isAvailable == nextAvailability) currentItem else current
                        }),
                        availabilityErrors = state.availabilityErrors + (item.id to readable(error)),
                    )
                }
            }
        }
    }

    fun saveCategory(existing: MenuCategory?, name: String) {
        val valid = Validation.categoryName(name) ?: return fail("Название категории должно содержать от 1 до 50 символов.")
        mutate("Категория сохранена") {
            val state = _state.value
            repository?.saveCategory(state.venueId!!, existing?.id, valid, existing?.sortOrder ?: state.menu.categories.size)
        }
    }

    fun deleteCategory(category: MenuCategory) = mutate("Категория удалена") { repository?.deleteCategory(_state.value.venueId!!, category.id) }

    fun saveItem(existing: MenuItem?, categoryId: String, name: String, price: String) {
        val validName = Validation.itemName(name) ?: return fail("Название позиции должно содержать от 1 до 80 символов.")
        val priceMinor = Validation.priceToMinor(price) ?: return fail("Введите цену от 0 до 999 999,99 ₽, не более двух знаков после запятой.")
        if (categoryId.isBlank()) return fail("Выберите категорию.")
        mutate("Позиция сохранена") {
            val current = _state.value
            val sameCategory = current.menu.items.filter { it.categoryId == categoryId }
            repository?.saveItem(current.venueId!!, existing?.id, categoryId, validName, priceMinor, existing?.sortOrder ?: sameCategory.size, existing?.isAvailable ?: true)
        }
    }

    fun deleteItem(item: MenuItem) = mutate("Позиция удалена") { repository?.deleteItem(item.id) }

    fun moveCategory(category: MenuCategory, delta: Int) {
        val sorted = _state.value.menu.categories.sortedBy { it.sortOrder }.toMutableList()
        val from = sorted.indexOfFirst { it.id == category.id }
        val to = (from + delta).coerceIn(0, sorted.lastIndex)
        if (from < 0 || from == to) return
        sorted.add(to, sorted.removeAt(from))
        mutate(null) { repository?.reorderCategories(sorted) }
    }

    fun moveItem(item: MenuItem, delta: Int) {
        val sorted = _state.value.menu.items.filter { it.categoryId == item.categoryId }.sortedBy { it.sortOrder }.toMutableList()
        val from = sorted.indexOfFirst { it.id == item.id }
        val to = (from + delta).coerceIn(0, sorted.lastIndex)
        if (from < 0 || from == to) return
        sorted.add(to, sorted.removeAt(from))
        mutate(null) { repository?.reorderItems(sorted) }
    }

    fun saveVenue(name: String, background: String, accent: String, duration: Int, displayScalePercent: Int) {
        val validName = Validation.itemName(name) ?: return fail("Введите название точки до 80 символов.")
        val validBackground = Validation.hexColor(background) ?: return fail("Фон должен быть цветом вида #F7F4EE.")
        val validAccent = Validation.hexColor(accent) ?: return fail("Акцент должен быть цветом вида #9C3D24.")
        if (duration !in 5..60) return fail("Смена страниц — от 5 до 60 секунд.")
        if (displayScalePercent !in 80..160) return fail("Масштаб меню — от 80 до 160%.")
        mutate("Настройки сохранены") { repository?.updateVenue(_state.value.venueId!!, validName, validBackground, validAccent, duration, displayScalePercent) }
    }

    fun uploadLogo(uri: Uri) {
        val resolver = getApplication<Application>().contentResolver
        val size = runCatching { resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } }.getOrNull() ?: -1
        if (size > 2 * 1024 * 1024) return fail("Размер логотипа не должен превышать 2 МБ.")
        if (resolver.getType(uri) !in setOf("image/png", "image/jpeg", "image/webp")) {
            return fail("Поддерживаются логотипы PNG, JPEG и WebP.")
        }
        mutate("Логотип загружен") { repository?.uploadLogo(_state.value.venueId!!, uri) }
    }

    fun rotateDisplayLink() = mutate("Новая ссылка готова") {
        val url = repository?.rotateDisplayLink().orEmpty()
        _state.update { it.copy(displayUrl = url) }
    }

    fun logout() {
        viewModelScope.launch {
            repository?.logout()
            menuJob?.cancel()
            _state.update { it.copy(screen = AppScreen.LOGIN, venueId = null, menu = MenuSnapshot(), menuError = null, error = null, pin = "", displayUrl = "") }
        }
    }

    private fun mutate(success: String?, block: suspend () -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(error = null) }
            runCatching { block() }
                .onSuccess { if (success != null) _state.update { it.copy(message = success) } }
                .onFailure { _state.update { state -> state.copy(error = readable(it)) } }
        }
    }

    private fun fail(message: String) { _state.update { it.copy(error = message) } }

    private fun readable(error: Throwable): String = when (error) {
        is FirebaseFirestoreException -> when (error.code) {
            FirebaseFirestoreException.Code.PERMISSION_DENIED ->
                "Firebase отклонил запрос. Проверьте, что вы вошли как сотрудник и у вас есть доступ к этому заведению."
            FirebaseFirestoreException.Code.UNAUTHENTICATED -> "Сессия завершилась. Войдите в приложение заново."
            FirebaseFirestoreException.Code.UNAVAILABLE,
            FirebaseFirestoreException.Code.DEADLINE_EXCEEDED ->
                "Не удалось связаться с Firebase. Проверьте интернет или запущенные локальные эмуляторы."
            else -> "Не удалось сохранить изменение в Firebase. Попробуйте ещё раз."
        }
        is FirebaseFunctionsException -> when (error.code) {
            FirebaseFunctionsException.Code.UNAUTHENTICATED ->
                error.message ?: "Неверный код заведения или PIN."
            FirebaseFunctionsException.Code.INVALID_ARGUMENT ->
                error.message ?: "Проверьте код заведения и шестизначный PIN."
            FirebaseFunctionsException.Code.RESOURCE_EXHAUSTED ->
                error.message ?: "Слишком много попыток. Повторите через 5 минут."
            FirebaseFunctionsException.Code.NOT_FOUND ->
                error.message ?: "Заведение не настроено."
            FirebaseFunctionsException.Code.INTERNAL ->
                "Не удалось выполнить вход: backend вернул внутреннюю ошибку. Проверьте, что Firebase эмуляторы запущены и точка my-cafe создана."
            else -> error.message ?: "Не удалось выполнить операцию."
        }
        is FirebaseNetworkException ->
            "Не удалось подключиться к Firebase. Проверьте интернет или запущенные локальные эмуляторы."
        else -> error.message?.substringAfterLast(": ") ?: "Не удалось выполнить операцию."
    }
}

package ru.interactivefoodmenu.staff

import android.app.Application
import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.tasks.await
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import java.io.IOException
import ru.interactivefoodmenu.staff.model.CsvMenuRow
import ru.interactivefoodmenu.staff.model.ApiRequestFailure
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
    val csvRetryRows: List<CsvMenuRow> = emptyList(),
)

class MenuViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as MenuApplication
    private val repository: MenuRepository? = app.repository
    private val _state = MutableStateFlow(UiState(configMissing = repository == null))
    val state: StateFlow<UiState> = _state.asStateFlow()
    private var menuJob: Job? = null
    private var mutating = false
    private var sessionEpoch = 0

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
                .onFailure { error ->
                    app.clientLogger?.error("photo_import_failed", error)
                    _state.update { it.copy(ocrBusy = false, error = "Не удалось распознать фото: ${error.message ?: "проверьте качество снимка"}") }
                }
        }
    }

    fun importCsv(uri: Uri) {
        if (mutating) return
        mutating = true
        val epoch = sessionEpoch
        _state.update { it.copy(busy = true, error = null, csvRetryRows = emptyList()) }
        viewModelScope.launch {
            try {
                val content = getApplication<Application>().contentResolver.openInputStream(uri)
                    ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: error("Не удалось прочитать CSV-файл.")
                executeCsvImport(CsvMenuParser.parse(content), epoch)
            } catch (cause: CancellationException) { throw cause }
            catch (cause: Exception) { if (epoch == sessionEpoch) handleFailure(cause) }
            finally { if (epoch == sessionEpoch) { mutating = false; _state.update { it.copy(busy = false) } } }
        }
    }
    fun retryCsvImport() {
        val rows = _state.value.csvRetryRows
        if (mutating || rows.isEmpty()) return
        mutating = true
        val epoch = sessionEpoch
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try { executeCsvImport(rows, epoch) }
            catch (cause: CancellationException) { throw cause }
            catch (cause: Exception) { if (epoch == sessionEpoch) handleFailure(cause) }
            finally { if (epoch == sessionEpoch) { mutating = false; _state.update { it.copy(busy = false) } } }
        }
    }
    private suspend fun executeCsvImport(rows: List<CsvMenuRow>, epoch: Int) {
        val result = (repository ?: error("Backend API не настроен.")).importItems(rows)
        if (epoch != sessionEpoch) return
        _state.update { it.copy(csvRetryRows = result.failures.map { failure -> failure.row }, message = "Импортировано позиций: ${result.imported}", error = result.failures.takeIf { failures -> failures.isNotEmpty() }?.let { failures -> "Импорт завершён частично: ошибок ${failures.size}. " + failures.take(10).joinToString("; ") { failure -> "Строка ${failure.line}: ${failure.message}" } }) }
        val fresh = repository.menu()
        if (epoch == sessionEpoch) _state.update { it.copy(menu = fresh) }
    }

    fun login() {
        if (mutating) return
        val current = _state.value
        if (current.venueCode.length !in 3..32 || current.pin.length != 6 || repository == null) {
            _state.update { it.copy(error = "Введите код заведения и шестизначный PIN.") }
            return
        }
        mutating = true
        val epoch = ++sessionEpoch
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            runCatching {
                val installationId = app.preferences.installationId()
                repository.login(current.venueCode, current.pin, installationId)
            }.onSuccess { venueId ->
                if (epoch != sessionEpoch) return@onSuccess
                mutating = false
                app.preferences.saveVenueCode(current.venueCode)
                _state.update { it.copy(pin = "", busy = false) }
                attach(venueId)
            }.onFailure { error ->
                if (epoch != sessionEpoch) return@onFailure
                mutating = false
                app.clientLogger?.error("staff_login_failed", error)
                _state.update { it.copy(busy = false, error = readable(error)) }
            }
        }
    }

    private fun attach(venueId: String) {
        menuJob?.cancel()
        _state.update { it.copy(venueId = venueId, screen = AppScreen.MENU, initializing = false, menuError = null, error = null) }
        val epoch = sessionEpoch
        menuJob = viewModelScope.launch {
            repository?.observeMenu(venueId)
                ?.catch { error ->
                    if (epoch != sessionEpoch) return@catch
                    if (error is ApiRequestFailure && error.status == 401) { handleFailure(error); return@catch }
                    app.clientLogger?.error("menu_subscription_failed", error, mapOf("venueId" to venueId))
                    _state.update { it.copy(menuError = readable(error)) }
                }
                ?.collect { menu ->
                    if (epoch == sessionEpoch && !mutating) _state.update { it.copy(menu = menu, menuError = null) }
                }
        }
    }

    fun retryMenu() {
        _state.value.venueId?.let(::attach)
    }

    fun toggle(item: MenuItem, unavailable: Boolean) {
        if (item.stockQuantity != null) return fail("Для этой позиции измените количество штук.")
        mutate(null) { (repository ?: error("Backend API не настроен.")).setAvailability(item, !unavailable) }
    }
    fun adjustStock(item: MenuItem, delta: Int) {
        if (item.stockQuantity == null || delta !in listOf(-1, 1)) return
        mutate("Остаток изменён") { repository?.adjustStock(item, delta) }
    }
    fun saveStock(item: MenuItem, value: String) {
        val quantity = value.takeIf { it.matches(Regex("[0-9]+")) }?.toLongOrNull()
        if (quantity == null || quantity !in 0..2_000_000_000L) return fail("Количество — целое число от 0 до 2000000000.")
        mutate("Остаток сохранён") { repository?.setStock(item, quantity.toInt()) }
    }

    fun saveCategory(existing: MenuCategory?, name: String) {
        val valid = Validation.categoryName(name) ?: return fail("Название категории должно содержать от 1 до 50 символов.")
        mutate("Категория сохранена") {
            val state = _state.value
            repository?.saveCategory(state.venueId!!, existing?.id, valid, existing?.sortOrder ?: state.menu.categories.size)
        }
    }

    fun deleteCategory(category: MenuCategory) = mutate("Категория удалена") { repository?.deleteCategory(_state.value.venueId!!, category.id) }

    fun saveItem(existing: MenuItem?, categoryId: String, name: String, price: String, quantityText: String) {
        val validName = Validation.itemName(name) ?: return fail("Название позиции должно содержать от 1 до 80 символов.")
        val priceMinor = Validation.priceToMinor(price) ?: return fail("Введите цену от 0 до 999 999,99 ₽, не более двух знаков после запятой.")
        if (categoryId.isBlank()) return fail("Выберите категорию.")
        val quantity = quantityText.takeIf { it.matches(Regex("[0-9]+")) }?.toLongOrNull()
        if ((existing == null || quantityText.isNotBlank() || existing.stockQuantity != null) && (quantity == null || quantity !in 0..2_000_000_000L)) return fail("Количество — целое число от 0 до 2000000000.")
        val changedQuantity = quantity?.toInt()?.takeIf { existing?.stockQuantity != it }
        mutate("Позиция сохранена") {
            val current = _state.value
            val sameCategory = current.menu.items.filter { it.categoryId == categoryId }
            repository?.saveItem(current.venueId!!, existing?.id, categoryId, validName, priceMinor, existing?.sortOrder ?: sameCategory.size, existing?.available ?: true, changedQuantity)
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

    fun rotateDisplayLink() {
        val epoch = sessionEpoch
        mutate("Новая ссылка готова") {
            val url = repository?.rotateDisplayLink().orEmpty()
            if (epoch == sessionEpoch) _state.update { it.copy(displayUrl = url) }
        }
    }

    fun logout() {
        sessionEpoch++
        mutating = false
        menuJob?.cancel()
        viewModelScope.launch { repository?.logout() }
        _state.update { UiState(initializing = false, configMissing = repository == null, venueCode = it.venueCode) }
    }

    private fun mutate(success: String?, block: suspend () -> Unit) {
        if (mutating) return
        mutating = true
        val epoch = sessionEpoch
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                block()
                val fresh = repository?.menu()
                if (epoch == sessionEpoch) _state.update { it.copy(menu = fresh ?: it.menu, message = success ?: it.message) }
            } catch (cause: CancellationException) { throw cause }
            catch (cause: Exception) {
                if (cause is IOException) {
                    val fresh = runCatching { repository?.menu() }.getOrNull()
                    if (epoch == sessionEpoch && fresh != null) _state.update { it.copy(menu = fresh) }
                }
                if (epoch == sessionEpoch) {
                    app.clientLogger?.error("menu_mutation_failed", cause)
                    handleFailure(cause)
                }
            } finally { if (epoch == sessionEpoch) { mutating = false; _state.update { it.copy(busy = false) } } }
        }
    }

    private fun handleFailure(cause: Throwable) {
        if (cause is ApiRequestFailure && cause.status == 401) { logout(); _state.update { it.copy(error = "Сессия завершилась. Войдите снова.") } }
        else _state.update { it.copy(error = readable(cause)) }
    }

    private fun fail(message: String) { _state.update { it.copy(error = message) } }

    private fun readable(error: Throwable): String = error.message?.substringAfterLast(": ")
        ?: "Не удалось выполнить операцию. Проверьте соединение с сервером меню."
}

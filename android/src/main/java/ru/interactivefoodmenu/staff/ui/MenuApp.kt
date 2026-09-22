package ru.interactivefoodmenu.staff.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.spring
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.core.graphics.createBitmap
import androidx.core.graphics.set
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.launch
import ru.interactivefoodmenu.staff.AppScreen
import ru.interactivefoodmenu.staff.MenuViewModel
import ru.interactivefoodmenu.staff.UiState
import ru.interactivefoodmenu.staff.model.MenuCategory
import ru.interactivefoodmenu.staff.model.MenuItem
import ru.interactivefoodmenu.staff.model.Validation
import ru.interactivefoodmenu.staff.model.groupedMenu
import java.text.NumberFormat
import java.util.Locale

@Composable
fun MenuApp(viewModel: MenuViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val venue = state.menu.venue
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(state.error, state.message) {
        val text = state.error ?: state.message
        if (text != null) {
            snackbar.showSnackbar(text)
            if (state.message != null) viewModel.clearMessage()
        }
    }
    MenuTheme(venue?.backgroundColor ?: "#F7F4EE", venue?.accentColor ?: "#9C3D24") {
        Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                when {
                    state.initializing -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                    state.configMissing -> ConfigurationMissing()
                    state.screen == AppScreen.LOGIN -> LoginScreen(state, viewModel)
                    state.screen == AppScreen.MENU -> MenuScreen(state, viewModel, snackbar)
                    state.screen == AppScreen.MANAGE -> ManageScreen(state, viewModel)
                }
            }
        }
    }
}

@Composable
private fun ConfigurationMissing() = Column(
    Modifier.fillMaxSize().padding(32.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
) {
    Text("Backend API не настроен", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(12.dp))
    Text("Добавьте android/google-services.json и пересоберите приложение.")
}

@Composable
private fun LoginScreen(state: UiState, viewModel: MenuViewModel) = Column(
    Modifier.fillMaxSize().padding(28.dp),
    verticalArrangement = Arrangement.Center,
) {
    Text("Меню в наличии", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
    Text("Вход сотрудника", style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(24.dp))
    OutlinedTextField(
        value = state.venueCode,
        onValueChange = viewModel::setVenueCode,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("Код заведения") },
        singleLine = true,
    )
    Spacer(Modifier.height(12.dp))
    OutlinedTextField(
        value = state.pin,
        onValueChange = viewModel::setPin,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("PIN-код") },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        singleLine = true,
    )
    Spacer(Modifier.height(20.dp))
    Button(onClick = viewModel::login, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
        if (state.busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Text("Войти")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MenuScreen(state: UiState, viewModel: MenuViewModel, snackbar: SnackbarHostState) {
    val scope = rememberCoroutineScope()
    val grouped = remember(state.menu.categories, state.menu.items, state.query) {
        groupedMenu(state.menu.categories, state.menu.items, state.query)
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Column { Text(state.menu.venue?.name ?: "Меню"); SyncStatus(state) } },
                actions = {
                    IconButton(viewModel::showManage) { Icon(Icons.Default.Settings, "Управление меню") }
                    IconButton(viewModel::logout) { Icon(Icons.AutoMirrored.Filled.Logout, "Выйти") }
                },
            )
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp)) {
            item {
                OutlinedTextField(
                    value = state.query,
                    onValueChange = viewModel::setQuery,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
                    label = { Text("Поиск позиции") },
                    singleLine = true,
                )
            }
            state.menuError?.let { message ->
                item(key = "menu-load-error") {
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    ) {
                        Column(Modifier.padding(16.dp)) {
                            Text("Не удалось обновить меню", fontWeight = FontWeight.SemiBold)
                            Text(message, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 4.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 12.dp)) {
                                FilledTonalButton(onClick = viewModel::retryMenu) { Text("Повторить") }
                                TextButton(onClick = viewModel::logout) { Text("Войти заново") }
                            }
                        }
                    }
                }
            }
            grouped.forEach { group ->
                item(key = "category-${group.category.id}") {
                    Text(group.category.name, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 18.dp, bottom = 6.dp))
                }
                items(group.items, key = { it.id }) { item ->
                    MenuAvailabilityRow(item, state.availabilityErrors[item.id], modifier = Modifier.animateItem(placementSpec = spring())) { checked ->
                        viewModel.toggle(item, checked)
                        scope.launch {
                            val result = snackbar.showSnackbar(
                                if (checked) "${item.name}: нет в наличии" else "${item.name}: снова в наличии",
                                actionLabel = "Отменить",
                            )
                            if (result == SnackbarResult.ActionPerformed) viewModel.toggle(item, !checked)
                        }
                    }
                    HorizontalDivider()
                }
            }
            if (grouped.isEmpty()) item { Text("Позиции не найдены", Modifier.padding(24.dp)) }
        }
    }
}

@Composable
private fun MenuAvailabilityRow(item: MenuItem, availabilityError: String?, modifier: Modifier = Modifier, onUnavailableChange: (Boolean) -> Unit) {
    val unavailable = !item.isAvailable
    val textColor by animateColorAsState(
        if (unavailable) MaterialTheme.colorScheme.onSurface.copy(alpha = .64f) else MaterialTheme.colorScheme.onSurface,
        animationSpec = spring(), label = "itemTextColor",
    )
    Row(
        modifier.fillMaxWidth().padding(vertical = 7.dp).animateContentSize(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(item.name, color = textColor, fontWeight = FontWeight.Medium, textDecoration = if (unavailable) TextDecoration.LineThrough else null)
            Text(formatPrice(item.priceMinor), color = textColor, style = MaterialTheme.typography.bodyMedium, textDecoration = if (unavailable) TextDecoration.LineThrough else null)
            availabilityError?.let {
                Text(
                    "Не сохранено: $it",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
        Text(
            "Нет в наличии",
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Medium,
            color = if (unavailable) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(end = 8.dp),
        )
        OutOfStockCheckbox(unavailable, onUnavailableChange, item.name)
    }
}

@Composable
private fun OutOfStockCheckbox(
    unavailable: Boolean,
    onUnavailableChange: (Boolean) -> Unit,
    itemName: String,
) {
    Surface(
        color = if (unavailable) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.surface,
        contentColor = if (unavailable) MaterialTheme.colorScheme.onError else MaterialTheme.colorScheme.onSurfaceVariant,
        shape = MaterialTheme.shapes.extraSmall,
        border = BorderStroke(
            1.dp,
            if (unavailable) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.outline,
        ),
        tonalElevation = 0.dp,
        modifier = Modifier
            .size(32.dp)
            .toggleable(
                value = unavailable,
                role = Role.Checkbox,
                onValueChange = onUnavailableChange,
            )
            .semantics { contentDescription = "Нет в наличии: $itemName" },
    ) {
        Box(contentAlignment = Alignment.Center) {
            if (unavailable) Icon(Icons.Default.Close, contentDescription = null)
        }
    }
}

@Composable
private fun SyncStatus(state: UiState) {
    val text = when {
        state.menuError != null -> "Ошибка загрузки меню"
        state.menu.pendingWrites -> "Синхронизация…"
        state.menu.fromCache -> "Офлайн · изменения будут отправлены позже"
        else -> "Все изменения сохранены"
    }
    Text(text, style = MaterialTheme.typography.labelSmall, color = if (state.menu.fromCache || state.menuError != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
}

private enum class ManageTab { CATEGORIES, ITEMS, SETTINGS }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ManageScreen(state: UiState, viewModel: MenuViewModel) {
    var tab by rememberSaveable { mutableStateOf(ManageTab.CATEGORIES) }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Управление") },
            navigationIcon = { IconButton(viewModel::showMenu) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Назад") } },
        )
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            PrimaryTabRow(tab.ordinal) {
                Tab(tab == ManageTab.CATEGORIES, { tab = ManageTab.CATEGORIES }, text = { Text("Категории") })
                Tab(tab == ManageTab.ITEMS, { tab = ManageTab.ITEMS }, text = { Text("Позиции") })
                Tab(tab == ManageTab.SETTINGS, { tab = ManageTab.SETTINGS }, text = { Text("Экран") })
            }
            when (tab) {
                ManageTab.CATEGORIES -> CategoriesEditor(state, viewModel)
                ManageTab.ITEMS -> ItemsEditor(state, viewModel)
                ManageTab.SETTINGS -> VenueSettings(state, viewModel)
            }
        }
    }
}

@Composable
private fun CategoriesEditor(state: UiState, viewModel: MenuViewModel) {
    var editing by remember { mutableStateOf<MenuCategory?>(null) }
    var adding by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<MenuCategory?>(null) }
    val sorted = state.menu.categories.sortedBy { it.sortOrder }
    LazyColumn(Modifier.fillMaxSize().padding(16.dp)) {
        item { Button({ adding = true }, Modifier.fillMaxWidth()) { Icon(Icons.Default.Add, null); Text("Добавить категорию") } }
        items(sorted, key = { it.id }) { category ->
            Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(category.name, Modifier.weight(1f), fontWeight = FontWeight.Medium)
                IconButton({ viewModel.moveCategory(category, -1) }, enabled = category != sorted.firstOrNull()) { Icon(Icons.Default.ArrowUpward, "Выше") }
                IconButton({ viewModel.moveCategory(category, 1) }, enabled = category != sorted.lastOrNull()) { Icon(Icons.Default.ArrowDownward, "Ниже") }
                IconButton({ editing = category }) { Icon(Icons.Default.Edit, "Изменить") }
                IconButton({ deleting = category }) { Icon(Icons.Default.Delete, "Удалить") }
            }
            HorizontalDivider()
        }
    }
    if (adding || editing != null) CategoryDialog(editing, { adding = false; editing = null }) { viewModel.saveCategory(editing, it); adding = false; editing = null }
    deleting?.let { target -> ConfirmDelete("Удалить категорию «${target.name}»?") { confirmed -> if (confirmed) viewModel.deleteCategory(target); deleting = null } }
}

@Composable
private fun CategoryDialog(existing: MenuCategory?, dismiss: () -> Unit, save: (String) -> Unit) {
    var name by remember(existing?.id) { mutableStateOf(existing?.name.orEmpty()) }
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text(if (existing == null) "Новая категория" else "Изменить категорию") },
        text = { OutlinedTextField(name, { name = it }, label = { Text("Название") }, singleLine = true) },
        confirmButton = { TextButton({ save(name) }) { Text("Сохранить") } },
        dismissButton = { TextButton(dismiss) { Text("Отмена") } },
    )
}

@Composable
private fun ItemsEditor(state: UiState, viewModel: MenuViewModel) {
    var editing by remember { mutableStateOf<MenuItem?>(null) }
    var adding by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<MenuItem?>(null) }
    val ocrPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri -> if (uri != null) viewModel.importMenuPhoto(uri) }
    val csvPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if (uri != null) viewModel.importCsv(uri) }
    val groups = groupedMenu(state.menu.categories, state.menu.items)
    LazyColumn(Modifier.fillMaxSize().padding(16.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Button({ adding = true }, enabled = state.menu.categories.isNotEmpty(), modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.Add, null); Text("Добавить позицию") }
                OutlinedButton({ csvPicker.launch(arrayOf("text/csv", "text/comma-separated-values", "application/csv", "text/plain")) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text(if (state.busy) "Импорт…" else "Импортировать CSV") }
                Text("Столбцы: Категория, Название, Цена, В наличии (Да/Нет). Импорт добавляет позиции.", style = MaterialTheme.typography.bodySmall)
                OutlinedButton({ ocrPicker.launch("image/*") }, modifier = Modifier.fillMaxWidth()) { Text(if (state.ocrBusy) "Распознавание…" else "Импортировать меню по фото") }
            }
        }
        groups.forEach { group ->
            item { Text(group.category.name, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 18.dp)) }
            items(group.items, key = { it.id }) { item ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) { Text(item.name); Text(formatPrice(item.priceMinor), style = MaterialTheme.typography.bodySmall) }
                    IconButton({ viewModel.moveItem(item, -1) }, enabled = item != group.items.firstOrNull()) { Icon(Icons.Default.ArrowUpward, "Выше") }
                    IconButton({ viewModel.moveItem(item, 1) }, enabled = item != group.items.lastOrNull()) { Icon(Icons.Default.ArrowDownward, "Ниже") }
                    IconButton({ editing = item }) { Icon(Icons.Default.Edit, "Изменить") }
                    IconButton({ deleting = item }) { Icon(Icons.Default.Delete, "Удалить") }
                }
                HorizontalDivider()
            }
        }
    }
    if (adding || editing != null) ItemDialog(editing, state.menu.categories, { adding = false; editing = null }) { category, name, price ->
        viewModel.saveItem(editing, category, name, price); adding = false; editing = null
    }
    deleting?.let { target -> ConfirmDelete("Удалить позицию «${target.name}»?") { confirmed -> if (confirmed) viewModel.deleteItem(target); deleting = null } }
    state.ocrPreview?.let { preview ->
        AlertDialog(
            onDismissRequest = viewModel::closeOcrPreview,
            title = { Text("Распознанное меню") },
            text = { OutlinedTextField(preview, {}, readOnly = true, minLines = 6, modifier = Modifier.fillMaxWidth()) },
            confirmButton = { TextButton(viewModel::closeOcrPreview) { Text("Понятно") } },
        )
    }
}

@Composable
private fun ItemDialog(existing: MenuItem?, categories: List<MenuCategory>, dismiss: () -> Unit, save: (String, String, String) -> Unit) {
    var name by remember(existing?.id) { mutableStateOf(existing?.name.orEmpty()) }
    var price by remember(existing?.id) { mutableStateOf(existing?.let { Validation.minorToInput(it.priceMinor) }.orEmpty()) }
    var categoryId by remember(existing?.id) { mutableStateOf(existing?.categoryId ?: categories.minByOrNull { it.sortOrder }?.id.orEmpty()) }
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text(if (existing == null) "Новая позиция" else "Изменить позицию") },
        text = {
            Column {
                OutlinedTextField(name, { name = it }, label = { Text("Название") }, singleLine = true)
                OutlinedTextField(price, { price = it }, label = { Text("Цена, ₽") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), singleLine = true)
                Text("Категория", Modifier.padding(top = 12.dp), fontWeight = FontWeight.Bold)
                categories.sortedBy { it.sortOrder }.forEach { category ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(categoryId == category.id, { categoryId = category.id })
                        Text(category.name)
                    }
                }
            }
        },
        confirmButton = { TextButton({ save(categoryId, name, price) }) { Text("Сохранить") } },
        dismissButton = { TextButton(dismiss) { Text("Отмена") } },
    )
}

@Composable
private fun ConfirmDelete(text: String, result: (Boolean) -> Unit) = AlertDialog(
    onDismissRequest = { result(false) },
    title = { Text("Подтверждение") },
    text = { Text(text) },
    confirmButton = { TextButton({ result(true) }) { Text("Удалить") } },
    dismissButton = { TextButton({ result(false) }) { Text("Отмена") } },
)

@Composable
private fun VenueSettings(state: UiState, viewModel: MenuViewModel) {
    val venue = state.menu.venue ?: return
    var name by remember(venue) { mutableStateOf(venue.name) }
    var background by remember(venue) { mutableStateOf(venue.backgroundColor) }
    var accent by remember(venue) { mutableStateOf(venue.accentColor) }
    var duration by remember(venue) { mutableIntStateOf(venue.pageDurationSeconds) }
    var displayScale by remember(venue) { mutableIntStateOf(venue.displayScalePercent.coerceIn(80, 160)) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri -> if (uri != null) viewModel.uploadLogo(uri) }
    val context = LocalContext.current
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(name, { name = it }, label = { Text("Название точки") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(background, { background = it }, label = { Text("Цвет фона (#RRGGBB)") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(accent, { accent = it }, label = { Text("Акцентный цвет (#RRGGBB)") }, modifier = Modifier.fillMaxWidth())
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Смена страниц: $duration сек.", Modifier.weight(1f))
            IconButton({ duration = (duration - 1).coerceAtLeast(5) }) { Text("−") }
            IconButton({ duration = (duration + 1).coerceAtMost(60) }) { Text("+") }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Масштаб меню ТВ: $displayScale%", Modifier.weight(1f))
            IconButton({ displayScale = (displayScale - 5).coerceAtLeast(80) }) { Text("−") }
            IconButton({ displayScale = (displayScale + 5).coerceAtMost(160) }) { Text("+") }
        }
        Button({ viewModel.saveVenue(name, background, accent, duration, displayScale) }, Modifier.fillMaxWidth()) { Text("Сохранить оформление") }
        OutlinedButton({ picker.launch("image/*") }, Modifier.fillMaxWidth()) { Text("Выбрать логотип (до 2 МБ)") }
        HorizontalDivider(Modifier.padding(vertical = 6.dp))
        Text("Экран телевизора", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text("Перевыпуск сразу отключит предыдущую ссылку.")
        Button(viewModel::rotateDisplayLink, Modifier.fillMaxWidth()) { Text(if (state.displayUrl.isBlank()) "Создать новую ссылку" else "Перевыпустить ссылку") }
        if (state.displayUrl.isNotBlank()) {
            val bitmap = remember(state.displayUrl) { qrBitmap(state.displayUrl) }
            Image(bitmap.asImageBitmap(), "QR-код экрана", Modifier.size(240.dp).align(Alignment.CenterHorizontally).semantics { contentDescription = "QR-код экрана" })
            FilledTonalButton({
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("Ссылка экрана", state.displayUrl))
            }, Modifier.fillMaxWidth()) { Icon(Icons.Default.ContentCopy, null); Text("Копировать ссылку") }
        }
        Spacer(Modifier.height(24.dp))
    }
}

private fun formatPrice(minor: Long): String = NumberFormat.getCurrencyInstance(Locale.forLanguageTag("ru-RU")).format(minor / 100.0)

private fun qrBitmap(value: String, size: Int = 768): Bitmap {
    val matrix = QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, size, size)
    return createBitmap(size, size).apply {
        for (x in 0 until size) for (y in 0 until size) this[x, y] = if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE
    }
}

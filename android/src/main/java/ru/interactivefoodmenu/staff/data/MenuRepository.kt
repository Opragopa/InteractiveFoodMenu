package ru.interactivefoodmenu.staff.data

import android.net.Uri
import kotlinx.coroutines.delay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import ru.interactivefoodmenu.staff.model.CsvMenuRow
import ru.interactivefoodmenu.staff.model.CsvImporter
import ru.interactivefoodmenu.staff.model.CsvImportTarget
import ru.interactivefoodmenu.staff.model.CsvImportResult
import java.io.IOException
import ru.interactivefoodmenu.staff.model.ApiRequestFailure
import ru.interactivefoodmenu.staff.model.MenuCategory
import ru.interactivefoodmenu.staff.model.MenuItem
import ru.interactivefoodmenu.staff.model.MenuSnapshot
import ru.interactivefoodmenu.staff.model.Venue

/** Android client for the neutral backend API. No Appwrite or Firebase token is exposed here. */
class MenuRepository(private val apiUrl: String) {
    private var token: String? = null
    private var venueId: String? = null
    private var authEpoch = 0

    suspend fun restoredVenueId(): String? = venueId

    suspend fun login(venueCode: String, pin: String, installationId: String): String {
        val epoch = authEpoch
        val result = call("/auth/staff", "POST", JSONObject().put("venueCode", venueCode.trim().lowercase()).put("pin", pin))
        if (epoch != authEpoch) throw CancellationException("Сессия завершилась.")
        authEpoch++
        token = result.getString("token")
        return result.getString("venueId").also { venueId = it }
    }

    fun observeMenu(ignoredVenueId: String): Flow<MenuSnapshot> = flow {
        while (true) {
            emit(menu())
            delay(3_000)
        }
    }

    suspend fun menu(): MenuSnapshot {
        val result = call("/menu")
        return MenuSnapshot(parseVenue(result.getJSONObject("venue")), parseCategories(result.getJSONArray("categories")), parseItems(result.getJSONArray("items")))
    }
    suspend fun setStock(item: MenuItem, quantity: Int): MenuItem = parseItem(call("/items/${item.id}", "PATCH", JSONObject().put("stockQuantity", quantity)).getJSONObject("item"))
    suspend fun adjustStock(item: MenuItem, delta: Int): MenuItem = parseItem(call("/items/${item.id}/stock/adjust", "POST", JSONObject().put("delta", delta)).getJSONObject("item"))
    suspend fun setAvailability(item: MenuItem, available: Boolean) { call("/items/${item.id}", "PATCH", JSONObject().put("isAvailable", available)) }
    suspend fun saveCategory(venueId: String, categoryId: String?, name: String, sortOrder: Int) {
        if (categoryId == null) call("/categories", "POST", JSONObject().put("name", name).put("sortOrder", sortOrder))
        else call("/categories/$categoryId", "PATCH", JSONObject().put("name", name).put("sortOrder", sortOrder))
    }
    suspend fun deleteCategory(venueId: String, categoryId: String) { call("/categories/$categoryId", "DELETE") }
    suspend fun saveItem(venueId: String, itemId: String?, categoryId: String, name: String, priceMinor: Long, sortOrder: Int, available: Boolean, stockQuantity: Int? = null) {
        val body = JSONObject().put("name", name).put("priceMinor", priceMinor).put("sortOrder", sortOrder)
        if (itemId == null) { body.put("categoryId", categoryId); if (stockQuantity == null) body.put("isAvailable", available) }
        if (stockQuantity != null) body.put("stockQuantity", stockQuantity)
        if (itemId == null) call("/items", "POST", body) else call("/items/$itemId", "PATCH", body)
    }
    suspend fun importItems(rows: List<CsvMenuRow>): CsvImportResult {
        val epoch = authEpoch
        fun checkSession() { if (epoch != authEpoch) throw CancellationException("Сессия завершилась.") }
        return CsvImporter.run(rows, object : CsvImportTarget {
        override suspend fun menu(): MenuSnapshot { checkSession(); return this@MenuRepository.menu() }
        override suspend fun category(name: String, order: Int): MenuCategory { checkSession(); return parseCategory(call("/categories", "POST", JSONObject().put("name", name).put("sortOrder", order)).getJSONObject("category")) }
        override suspend fun create(row: CsvMenuRow, categoryId: String, order: Int): MenuItem { checkSession(); return parseItem(call("/items", "POST", JSONObject().put("categoryId", categoryId).put("name", row.name).put("priceMinor", row.priceMinor).put("sortOrder", order).put("stockQuantity", row.stockQuantity)).getJSONObject("item")) }
        override suspend fun stock(item: MenuItem, quantity: Int): MenuItem { checkSession(); return setStock(item, quantity) }
        })
    }
    suspend fun deleteItem(itemId: String) { call("/items/$itemId", "DELETE") }
    suspend fun reorderCategories(categories: List<MenuCategory>) { categories.forEachIndexed { index, value -> saveCategory(value.venueId, value.id, value.name, index) } }
    suspend fun reorderItems(items: List<MenuItem>) { items.forEachIndexed { index, value -> call("/items/${value.id}", "PATCH", JSONObject().put("sortOrder", index)) } }
    suspend fun updateVenue(venueId: String, name: String, backgroundColor: String, accentColor: String, duration: Int, displayScalePercent: Int) = call("/venue", "PATCH", JSONObject().put("name", name).put("backgroundColor", backgroundColor).put("accentColor", accentColor).put("pageDurationSeconds", duration).put("displayScalePercent", displayScalePercent))
    suspend fun uploadLogo(venueId: String, uri: Uri) { throw UnsupportedOperationException("Загрузка логотипа ещё не перенесена на backend API.") }
    suspend fun rotateDisplayLink(): String = call("/display/rotate", "POST").getString("displayUrl")
    suspend fun logout() { authEpoch++; token = null; venueId = null }
    suspend fun log(level: String, message: String, details: Map<String, Any>) { if (token != null) call("/client-logs", "POST", JSONObject().put("level", level).put("message", message).put("details", JSONObject(details))) }

    private suspend fun call(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val requestToken = token
        val connection = (URL(apiUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method; connectTimeout = 15_000; readTimeout = 15_000
            setRequestProperty("Accept", "application/json")
            requestToken?.let { setRequestProperty("Authorization", "Bearer $it") }
        }
        try {
            if (body != null) { connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json"); connection.outputStream.use { it.write(body.toString().toByteArray()) } }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status !in 200..299) throw ApiRequestFailure(status, runCatching { JSONObject(text).optString("message") }.getOrDefault("HTTP $status"))
            if (text.isBlank()) JSONObject() else JSONObject(text)
        } catch (cause: IOException) {
            if (method != "GET") throw IOException("Результат записи неизвестен. Проверьте данные перед повтором; автоматического повтора нет.", cause)
            throw cause
        } finally { connection.disconnect() }
    }

    private fun parseVenue(row: JSONObject) = Venue(row.optString("name", "Меню в наличии"), row.optString("currency", "RUB"), row.optString("backgroundColor", "#F7F4EE"), row.optString("accentColor", "#9C3D24"), "", row.optInt("pageDurationSeconds", 10), row.optInt("displayScalePercent", 100), row.optInt("displayVersion", 1), row.optInt("staffVersion", 1))
    private fun parseCategories(rows: JSONArray) = List(rows.length()) { parseCategory(rows.getJSONObject(it)) }
    private fun parseCategory(row: JSONObject) = MenuCategory(row.optString("id"), row.optString("venueId"), row.optString("name"), row.optInt("sortOrder"))
    private fun parseItem(row: JSONObject) = MenuItem(row.optString("id"), row.optString("venueId"), row.optString("categoryId"), row.optString("name"), row.optLong("priceMinor"), row.optInt("sortOrder"), row.optBoolean("isAvailable", true), if (row.isNull("stockQuantity")) null else row.optInt("stockQuantity"))
    private fun parseItems(rows: JSONArray) = List(rows.length()) { parseItem(rows.getJSONObject(it)) }
}

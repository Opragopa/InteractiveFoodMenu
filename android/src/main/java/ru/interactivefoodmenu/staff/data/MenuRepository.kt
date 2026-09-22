package ru.interactivefoodmenu.staff.data

import android.net.Uri
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import ru.interactivefoodmenu.staff.model.CsvMenuRow
import ru.interactivefoodmenu.staff.model.MenuCategory
import ru.interactivefoodmenu.staff.model.MenuItem
import ru.interactivefoodmenu.staff.model.MenuSnapshot
import ru.interactivefoodmenu.staff.model.Venue

/** Android client for the neutral backend API. No Appwrite or Firebase token is exposed here. */
class MenuRepository(private val apiUrl: String) {
    private var token: String? = null
    private var venueId: String? = null

    suspend fun restoredVenueId(): String? = venueId

    suspend fun login(venueCode: String, pin: String, installationId: String): String {
        val result = call("/auth/staff", "POST", JSONObject().put("venueCode", venueCode.trim().lowercase()).put("pin", pin))
        token = result.getString("token")
        return result.getString("venueId").also { venueId = it }
    }

    fun observeMenu(ignoredVenueId: String): Flow<MenuSnapshot> = flow {
        while (true) {
            val result = call("/menu")
            emit(MenuSnapshot(parseVenue(result.getJSONObject("venue")), parseCategories(result.getJSONArray("categories")), parseItems(result.getJSONArray("items"))))
            delay(3_000)
        }
    }

    suspend fun setAvailability(item: MenuItem, available: Boolean) { call("/items/${item.id}", "PATCH", JSONObject().put("isAvailable", available)) }
    suspend fun saveCategory(venueId: String, categoryId: String?, name: String, sortOrder: Int) {
        if (categoryId == null) call("/categories", "POST", JSONObject().put("name", name).put("sortOrder", sortOrder))
        else call("/categories/$categoryId", "PATCH", JSONObject().put("name", name).put("sortOrder", sortOrder))
    }
    suspend fun deleteCategory(venueId: String, categoryId: String) { call("/categories/$categoryId", "DELETE") }
    suspend fun saveItem(venueId: String, itemId: String?, categoryId: String, name: String, priceMinor: Long, sortOrder: Int, available: Boolean) {
        val body = JSONObject().put("categoryId", categoryId).put("name", name).put("priceMinor", priceMinor).put("sortOrder", sortOrder).put("isAvailable", available)
        if (itemId == null) call("/items", "POST", body) else call("/items/$itemId", "PATCH", body)
    }
    suspend fun importItems(venueId: String, existingCategories: List<MenuCategory>, existingItems: List<MenuItem>, rows: List<CsvMenuRow>) {
        val categories = existingCategories.associateBy { it.name.trim().lowercase() }.toMutableMap()
        rows.map { it.category }.distinctBy { it.trim().lowercase() }.forEachIndexed { index, name ->
            val key = name.trim().lowercase()
            if (key !in categories) {
                val row = call("/categories", "POST", JSONObject().put("name", name).put("sortOrder", categories.size + index)).getJSONObject("category")
                categories[key] = parseCategory(row)
            }
        }
        val orders = existingItems.groupBy { it.categoryId }.mapValues { it.value.size }.toMutableMap()
        rows.forEach { row ->
            val category = categories.getValue(row.category.trim().lowercase())
            val order = orders.getOrDefault(category.id, 0); orders[category.id] = order + 1
            saveItem(venueId, null, category.id, row.name, row.priceMinor, order, row.isAvailable)
        }
    }
    suspend fun deleteItem(itemId: String) { call("/items/$itemId", "DELETE") }
    suspend fun reorderCategories(categories: List<MenuCategory>) { categories.forEachIndexed { index, value -> saveCategory(value.venueId, value.id, value.name, index) } }
    suspend fun reorderItems(items: List<MenuItem>) { items.forEachIndexed { index, value -> call("/items/${value.id}", "PATCH", JSONObject().put("sortOrder", index)) } }
    suspend fun updateVenue(venueId: String, name: String, backgroundColor: String, accentColor: String, duration: Int, displayScalePercent: Int) = call("/venue", "PATCH", JSONObject().put("name", name).put("backgroundColor", backgroundColor).put("accentColor", accentColor).put("pageDurationSeconds", duration).put("displayScalePercent", displayScalePercent))
    suspend fun uploadLogo(venueId: String, uri: Uri) { throw UnsupportedOperationException("Загрузка логотипа ещё не перенесена на backend API.") }
    suspend fun rotateDisplayLink(): String = call("/display/rotate", "POST").getString("displayUrl")
    suspend fun logout() { token = null; venueId = null }
    suspend fun log(level: String, message: String, details: Map<String, Any>) { if (token != null) call("/client-logs", "POST", JSONObject().put("level", level).put("message", message).put("details", JSONObject(details))) }

    private suspend fun call(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val connection = (URL(apiUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method; connectTimeout = 15_000; readTimeout = 15_000
            setRequestProperty("Accept", "application/json")
            token?.let { setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) { doOutput = true; setRequestProperty("Content-Type", "application/json"); outputStream.use { it.write(body.toString().toByteArray()) } }
        }
        val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (connection.responseCode !in 200..299) throw IllegalStateException(runCatching { JSONObject(text).optString("message") }.getOrDefault("HTTP ${connection.responseCode}"))
        if (text.isBlank()) JSONObject() else JSONObject(text)
    }

    private fun parseVenue(row: JSONObject) = Venue(row.optString("name", "Меню в наличии"), row.optString("currency", "RUB"), row.optString("backgroundColor", "#F7F4EE"), row.optString("accentColor", "#9C3D24"), "", row.optInt("pageDurationSeconds", 10), row.optInt("displayScalePercent", 100), row.optInt("displayVersion", 1), row.optInt("staffVersion", 1))
    private fun parseCategories(rows: JSONArray) = List(rows.length()) { parseCategory(rows.getJSONObject(it)) }
    private fun parseCategory(row: JSONObject) = MenuCategory(row.optString("id"), row.optString("venueId"), row.optString("name"), row.optInt("sortOrder"))
    private fun parseItems(rows: JSONArray) = List(rows.length()) { row -> rows.getJSONObject(row).let { MenuItem(it.optString("id"), it.optString("venueId"), it.optString("categoryId"), it.optString("name"), it.optLong("priceMinor"), it.optInt("sortOrder"), it.optBoolean("isAvailable", true)) } }
}

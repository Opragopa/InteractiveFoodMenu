package ru.interactivefoodmenu.staff.model

import java.io.IOException
import java.util.Locale
import kotlinx.coroutines.CancellationException

data class CsvImportFailure(val line: Int, val row: CsvMenuRow, val message: String)
data class CsvImportResult(val imported: Int, val failures: List<CsvImportFailure>)
interface CsvImportTarget {
    suspend fun menu(): MenuSnapshot
    suspend fun category(name: String, order: Int): MenuCategory
    suspend fun create(row: CsvMenuRow, categoryId: String, order: Int): MenuItem
    suspend fun stock(item: MenuItem, quantity: Int): MenuItem
}
object CsvImporter {
    fun key(value: String) = value.trim().replace(Regex("\\s+"), " ").lowercase(Locale.ROOT)
    suspend fun run(rows: List<CsvMenuRow>, target: CsvImportTarget): CsvImportResult {
        val fresh = target.menu()
        val categories = fresh.categories.toMutableList()
        val items = fresh.items.toMutableList()
        val failures = mutableListOf<CsvImportFailure>()
        var imported = 0
        for ((index, row) in rows.withIndex()) {
            try {
                val matches = categories.filter { key(it.name) == key(row.category) }
                require(matches.size <= 1) { "Найдено несколько категорий «${row.category}»." }
                val category = matches.singleOrNull() ?: target.category(row.category, categories.size).also(categories::add)
                val existing = items.filter { it.categoryId == category.id && key(it.name) == key(row.name) }
                require(existing.size <= 1) { "Найдено несколько позиций «${row.name}»." }
                if (existing.isEmpty()) items += target.create(row, category.id, items.count { it.categoryId == category.id })
                else {
                    val current = existing.single()
                    val updated = target.stock(current, row.stockQuantity)
                    items[items.indexOfFirst { it.id == current.id }] = updated
                }
                imported++
            } catch (cause: CancellationException) { throw cause }
            catch (cause: Exception) {
                if (cause is ApiRequestFailure && cause.status == 401) throw cause
                failures += CsvImportFailure(index + 2, row, cause.message ?: "Не удалось сохранить строку.")
                if (cause is IOException) {
                    rows.drop(index + 1).forEachIndexed { offset, pending -> failures += CsvImportFailure(index + offset + 3, pending, "Не обработано после потери связи; проверьте данные перед повтором.") }
                    break
                }
            }
        }
        return CsvImportResult(imported, failures)
    }
}

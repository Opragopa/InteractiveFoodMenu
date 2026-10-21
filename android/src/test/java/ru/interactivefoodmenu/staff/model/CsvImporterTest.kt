package ru.interactivefoodmenu.staff.model

import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class CsvImporterTest {
    private class Target : CsvImportTarget {
        val categories = mutableListOf(MenuCategory("c", "v", "Food", 0))
        val items = mutableListOf<MenuItem>()
        var creates = 0
        var failName: String? = null
        var unauthorized = false
        override suspend fun menu() = MenuSnapshot(categories = categories.toList(), items = items.toList())
        override suspend fun category(name: String, order: Int) = MenuCategory("c${categories.size}", "v", name, order).also(categories::add)
        override suspend fun create(row: CsvMenuRow, categoryId: String, order: Int): MenuItem {
            if (unauthorized) throw ApiRequestFailure(401, "Сессия завершилась")
            if (row.name == failName) throw IOException("Response lost")
            creates++
            return MenuItem("i$creates", "v", categoryId, row.name, row.priceMinor, order, stockQuantity = row.stockQuantity).also(items::add)
        }
        override suspend fun stock(item: MenuItem, quantity: Int) = item.copy(stockQuantity = quantity).also { updated -> items[items.indexOfFirst { it.id == item.id }] = updated }
    }
    @Test fun `repeated normalized rows update stock without duplicating or changing price`() = runBlocking {
        val target = Target()
        CsvImporter.run(listOf(CsvMenuRow("Food", "Green soup", 25000, 3)), target)
        val result = CsvImporter.run(listOf(CsvMenuRow(" food ", " GREEN  SOUP ", 99900, 0)), target)
        assertEquals(1, result.imported); assertTrue(result.failures.isEmpty()); assertEquals(1, target.creates)
        assertEquals(25000L, target.items.single().priceMinor); assertFalse(target.items.single().available)
    }
    @Test fun `ambiguous normalized item does not update either row`() = runBlocking {
        val target = Target()
        target.items += MenuItem("1", "v", "c", "Soup", stockQuantity = 1)
        target.items += MenuItem("2", "v", "c", "SOUP", stockQuantity = 2)
        val result = CsvImporter.run(listOf(CsvMenuRow("Food", "Soup", 25000, 8)), target)
        assertEquals(0, result.imported); assertEquals(2, result.failures.single().line)
        assertEquals(listOf(1, 2), target.items.map { it.stockQuantity })
    }
    @Test fun `network loss retains unsuccessful rows and retry reconciles earlier successes`() = runBlocking {
        val target = Target(); target.failName = "Tea"
        val rows = listOf("Soup", "Tea", "Cake").map { CsvMenuRow("Food", it, 25000, 3) }
        val partial = CsvImporter.run(rows, target)
        assertEquals(1, partial.imported); assertEquals(listOf("Tea", "Cake"), partial.failures.map { it.row.name })
        assertEquals(1, target.creates)
        target.failName = null
        val retry = CsvImporter.run(partial.failures.map { it.row }, target)
        assertEquals(2, retry.imported); assertTrue(retry.failures.isEmpty()); assertEquals(3, target.items.size)
    }
    @Test fun `revoked sessions stop the whole import immediately`() = runBlocking {
        val target = Target(); target.unauthorized = true
        try {
            CsvImporter.run(listOf("Soup", "Tea").map { CsvMenuRow("Food", it, 100, 1) }, target)
            fail("Authentication failure must stop import")
        } catch (cause: ApiRequestFailure) { assertEquals(401, cause.status) }
        assertEquals(0, target.creates)
    }
    @Test fun `explicit stock always determines effective availability`() {
        assertFalse(MenuItem(isAvailable = true, stockQuantity = 0).available)
        assertTrue(MenuItem(isAvailable = false, stockQuantity = 1).available)
        assertFalse(MenuItem(isAvailable = false).available)
    }
}

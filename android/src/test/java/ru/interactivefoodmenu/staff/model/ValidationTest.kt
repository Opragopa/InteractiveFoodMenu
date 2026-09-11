package ru.interactivefoodmenu.staff.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ValidationTest {
    @Test fun parsesRussianPriceWithoutFloatingPoint() {
        assertEquals(12345L, Validation.priceToMinor("123,45"))
        assertEquals(100L, Validation.priceToMinor("1"))
    }

    @Test fun rejectsOutOfRangeAndOverPrecisePrices() {
        assertNull(Validation.priceToMinor("-1"))
        assertNull(Validation.priceToMinor("1000000"))
        assertNull(Validation.priceToMinor("1,001"))
    }

    @Test fun groupsAndSortsFilteredItems() {
        val categories = listOf(
            MenuCategory("b", "v", "Бар", 2),
            MenuCategory("a", "v", "Кухня", 1),
        )
        val items = listOf(
            MenuItem("2", "v", "a", "Суп", 10000, 2),
            MenuItem("1", "v", "a", "Салат", 9000, 1),
        )
        val result = groupedMenu(categories, items, "са")
        assertEquals("Кухня", result.single().category.name)
        assertEquals("Салат", result.single().items.single().name)
    }
}


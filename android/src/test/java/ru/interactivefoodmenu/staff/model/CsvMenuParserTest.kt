package ru.interactivefoodmenu.staff.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CsvMenuParserTest {
    @Test fun `parses semicolon csv with Russian headers`() {
        val rows = CsvMenuParser.parse("Категория;Название;Цена;В наличии\nНапитки;\"Чай, мята\";150,50;Нет")
        assertEquals(1, rows.size)
        assertEquals("Напитки", rows[0].category)
        assertEquals("Чай, мята", rows[0].name)
        assertEquals(15050, rows[0].priceMinor)
        assertFalse(rows[0].isAvailable)
    }

    @Test fun `defaults availability to true and accepts English headers`() {
        val row = CsvMenuParser.parse("category,name,price\nFood,Soup,250").single()
        assertEquals("Food", row.category)
        assertTrue(row.isAvailable)
    }

    @Test fun `keeps a quoted comma in a comma-delimited item name`() {
        val row = CsvMenuParser.parse("category,name,price\nMain,\"Potatoes, mushrooms\",275").single()
        assertEquals("Potatoes, mushrooms", row.name)
        assertEquals(27500, row.priceMinor)
    }
}

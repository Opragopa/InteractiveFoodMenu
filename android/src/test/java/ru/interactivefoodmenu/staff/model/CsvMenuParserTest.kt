package ru.interactivefoodmenu.staff.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CsvMenuParserTest {
    @Test(expected = IllegalArgumentException::class) fun `rejects legacy files without quantity`() { CsvMenuParser.parse("category,name,price\nFood,Soup,250") }
    @Test(expected = IllegalArgumentException::class) fun `rejects quantity above the API limit`() { CsvMenuParser.parse("category,name,price,quantity\nFood,Soup,250,2000000001") }
    @Test(expected = IllegalArgumentException::class) fun `rejects fractional quantity`() { CsvMenuParser.parse("category;name;price;quantity\nFood;Soup;250;1.5") }

    @Test fun `zero quantity from the web format is unavailable`() {
        val row = CsvMenuParser.parse("Категория;Название;Цена;Количество\nЕда;Суп;250;0").single()
        assertFalse(row.isAvailable)
    }

    @Test fun `parses semicolon csv with Russian headers`() {
        val rows = CsvMenuParser.parse("Категория;Название;Цена;Количество\nНапитки;\"Чай, мята\";150,50;0")
        assertEquals(1, rows.size)
        assertEquals("Напитки", rows[0].category)
        assertEquals("Чай, мята", rows[0].name)
        assertEquals(15050, rows[0].priceMinor)
        assertFalse(rows[0].isAvailable)
    }

    @Test fun `accepts English quantity headers`() {
        val row = CsvMenuParser.parse("category,name,price,quantity\nFood,Soup,250,3").single()
        assertEquals("Food", row.category)
        assertTrue(row.isAvailable)
    }

    @Test fun `keeps a quoted comma in a comma-delimited item name`() {
        val row = CsvMenuParser.parse("category,name,price,quantity\nMain,\"Potatoes, mushrooms\",275,2").single()
        assertEquals("Potatoes, mushrooms", row.name)
        assertEquals(27500, row.priceMinor)
    }
}

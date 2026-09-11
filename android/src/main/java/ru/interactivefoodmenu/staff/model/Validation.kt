package ru.interactivefoodmenu.staff.model

import java.math.BigDecimal
import java.math.RoundingMode

object Validation {
    private val colorPattern = Regex("^#[0-9A-Fa-f]{6}$")

    fun categoryName(value: String): String? = value.trim().takeIf { it.isNotEmpty() && it.length <= 50 }
    fun itemName(value: String): String? = value.trim().takeIf { it.isNotEmpty() && it.length <= 80 }
    fun hexColor(value: String): String? = value.trim().uppercase().takeIf(colorPattern::matches)

    fun priceToMinor(value: String): Long? = runCatching {
        val normalized = value.trim().replace(',', '.')
        val amount = BigDecimal(normalized).setScale(2, RoundingMode.UNNECESSARY)
        if (amount < BigDecimal.ZERO || amount > BigDecimal("999999.99")) null
        else amount.movePointRight(2).longValueExact()
    }.getOrNull()

    fun minorToInput(value: Long): String = BigDecimal(value).movePointLeft(2).stripTrailingZeros().toPlainString().replace('.', ',')
}

fun groupedMenu(categories: List<MenuCategory>, items: List<MenuItem>, query: String = ""): List<GroupedMenu> {
    val needle = query.trim().lowercase()
    return categories.sortedWith(compareBy<MenuCategory> { it.sortOrder }.thenBy { it.name })
        .mapNotNull { category ->
            val matches = items.asSequence()
                .filter { it.categoryId == category.id }
                .filter { needle.isEmpty() || it.name.lowercase().contains(needle) }
                .sortedWith(compareBy<MenuItem> { it.sortOrder }.thenBy { it.name })
                .toList()
            matches.takeIf { it.isNotEmpty() }?.let { GroupedMenu(category, it) }
        }
}


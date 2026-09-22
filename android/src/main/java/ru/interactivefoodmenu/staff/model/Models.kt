package ru.interactivefoodmenu.staff.model


data class Venue(
    val name: String = "Меню в наличии",
    val currency: String = "RUB",
    val backgroundColor: String = "#F7F4EE",
    val accentColor: String = "#9C3D24",
    val logoPath: String = "",
    val pageDurationSeconds: Int = 10,
    val displayScalePercent: Int = 100,
    val displayVersion: Int = 1,
    val staffVersion: Int = 1,
)

data class MenuCategory(
    val id: String = "",
    val venueId: String = "",
    val name: String = "",
    val sortOrder: Int = 0,
)

data class MenuItem(
    val id: String = "",
    val venueId: String = "",
    val categoryId: String = "",
    val name: String = "",
    val priceMinor: Long = 0,
    val sortOrder: Int = 0,
    var isAvailable: Boolean = true,
)

data class MenuSnapshot(
    val venue: Venue? = null,
    val categories: List<MenuCategory> = emptyList(),
    val items: List<MenuItem> = emptyList(),
    val pendingWrites: Boolean = false,
    val fromCache: Boolean = false,
)

data class GroupedMenu(val category: MenuCategory, val items: List<MenuItem>)

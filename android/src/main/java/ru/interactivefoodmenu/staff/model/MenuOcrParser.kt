package ru.interactivefoodmenu.staff.model

data class OcrMenuRow(val category: String?, val name: String, val price: String?)

object MenuOcrParser {
    private val priceRegex = Regex("(?i)(\\d{1,6}(?:[,.]\\d{1,2})?)\\s*(?:₽|руб\\.?|р\\.?)")
    private val priceOnlyRegex = Regex("^\\s*(\\d{1,6}(?:[,.]\\d{1,2})?)\\s*$")

    fun parse(text: String): List<OcrMenuRow> {
        var category: String? = null
        return text.lines().mapNotNull { raw ->
            val line = raw.replace(Regex("\\s+"), " ").trim()
            if (line.length !in 2..100) return@mapNotNull null
            if (priceOnlyRegex.matches(line)) return@mapNotNull null
            val price = priceRegex.find(line)?.groupValues?.getOrNull(1)
            val name = line.replace(priceRegex, "").replace(Regex("\\s{2,}"), " ").trim(' ', '-', '—', ':')
            if (price == null && name.length <= 45 && !name.any(Char::isDigit)) {
                category = name
                return@mapNotNull null
            }
            if (name.length < 2 || name.any { it == '%' }) null else OcrMenuRow(category, name, price)
        }
    }
}

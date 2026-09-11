package ru.interactivefoodmenu.staff.model

data class CsvMenuRow(
    val category: String,
    val name: String,
    val priceMinor: Long,
    val isAvailable: Boolean,
)

/** Parses a spreadsheet-exported menu without requiring a third-party CSV library. */
object CsvMenuParser {
    private val categoryHeaders = setOf("категория", "category", "раздел")
    private val nameHeaders = setOf("название", "позиция", "блюдо", "name", "item")
    private val priceHeaders = setOf("цена", "price", "стоимость")
    private val availabilityHeaders = setOf("в наличии", "наличие", "available", "availability")

    fun parse(content: String): List<CsvMenuRow> {
        val lines = records(content.removePrefix("\uFEFF")).filter { line -> line.any { !it.isWhitespace() } }
        require(lines.isNotEmpty()) { "CSV-файл пуст." }
        val delimiter = detectDelimiter(lines.first())
        val header = split(lines.first(), delimiter).map(::normalizeHeader)
        val categoryIndex = header.indexOfFirst { it in categoryHeaders }
        val nameIndex = header.indexOfFirst { it in nameHeaders }
        val priceIndex = header.indexOfFirst { it in priceHeaders }
        val availabilityIndex = header.indexOfFirst { it in availabilityHeaders }
        require(categoryIndex >= 0 && nameIndex >= 0 && priceIndex >= 0) {
            "Нужны столбцы: Категория, Название, Цена."
        }

        return lines.drop(1).mapIndexed { index, line ->
            val row = split(line, delimiter)
            fun field(column: Int) = row.getOrElse(column) { "" }.trim()
            val category = Validation.categoryName(field(categoryIndex))
                ?: throw IllegalArgumentException("Строка ${index + 2}: укажите категорию.")
            val name = Validation.itemName(field(nameIndex))
                ?: throw IllegalArgumentException("Строка ${index + 2}: укажите название позиции.")
            val price = Validation.priceToMinor(field(priceIndex))
                ?: throw IllegalArgumentException("Строка ${index + 2}: некорректная цена.")
            CsvMenuRow(category, name, price, availabilityIndex < 0 || available(field(availabilityIndex), index + 2))
        }
    }

    private fun normalizeHeader(value: String) = value.trim().lowercase().replace(Regex("\\s+"), " ")

    private fun available(value: String, line: Int): Boolean = when (normalizeHeader(value)) {
        "", "да", "yes", "true", "1", "в наличии" -> true
        "нет", "no", "false", "0", "нет в наличии" -> false
        else -> throw IllegalArgumentException("Строка $line: значение наличия должно быть Да или Нет.")
    }

    private fun detectDelimiter(header: String): Char = if (header.count { it == ';' } > header.count { it == ',' }) ';' else ','

    private fun records(content: String): List<String> {
        val result = mutableListOf<String>()
        val record = StringBuilder()
        var quoted = false
        var i = 0
        while (i < content.length) {
            val char = content[i]
            if (char == '"') {
                if (quoted && content.getOrNull(i + 1) == '"') { record.append("\"\""); i++ }
                else { quoted = !quoted; record.append(char) }
            } else if ((char == '\n' || char == '\r') && !quoted) {
                if (char == '\r' && content.getOrNull(i + 1) == '\n') i++
                result += record.toString(); record.clear()
            } else record.append(char)
            i++
        }
        if (quoted) throw IllegalArgumentException("CSV содержит незакрытую кавычку.")
        if (record.isNotEmpty()) result += record.toString()
        return result
    }

    private fun split(line: String, delimiter: Char): List<String> {
        val result = mutableListOf<String>()
        val value = StringBuilder()
        var quoted = false
        var i = 0
        while (i < line.length) {
            val char = line[i]
            when {
                char == '"' && quoted && line.getOrNull(i + 1) == '"' -> { value.append(char); i++ }
                char == '"' -> quoted = !quoted
                char == delimiter && !quoted -> { result += value.toString(); value.clear() }
                else -> value.append(char)
            }
            i++
        }
        if (quoted) throw IllegalArgumentException("CSV содержит незакрытую кавычку.")
        result += value.toString()
        return result
    }
}

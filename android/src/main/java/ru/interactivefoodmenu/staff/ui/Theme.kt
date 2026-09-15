package ru.interactivefoodmenu.staff.ui

import androidx.core.graphics.toColorInt
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import ru.interactivefoodmenu.staff.R
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance

private fun color(value: String, fallback: Long) = runCatching { Color(value.toColorInt()) }.getOrDefault(Color(fallback))

private val Onest = FontFamily(Font(R.font.onest_variable, weight = FontWeight.Normal))
private val OnestTypography = Typography().let { base ->
    base.copy(
        displayLarge = base.displayLarge.copy(fontFamily = Onest),
        displayMedium = base.displayMedium.copy(fontFamily = Onest),
        displaySmall = base.displaySmall.copy(fontFamily = Onest),
        headlineLarge = base.headlineLarge.copy(fontFamily = Onest),
        headlineMedium = base.headlineMedium.copy(fontFamily = Onest),
        headlineSmall = base.headlineSmall.copy(fontFamily = Onest),
        titleLarge = base.titleLarge.copy(fontFamily = Onest),
        titleMedium = base.titleMedium.copy(fontFamily = Onest),
        titleSmall = base.titleSmall.copy(fontFamily = Onest),
        bodyLarge = base.bodyLarge.copy(fontFamily = Onest),
        bodyMedium = base.bodyMedium.copy(fontFamily = Onest),
        bodySmall = base.bodySmall.copy(fontFamily = Onest),
        labelLarge = base.labelLarge.copy(fontFamily = Onest),
        labelMedium = base.labelMedium.copy(fontFamily = Onest),
        labelSmall = base.labelSmall.copy(fontFamily = Onest),
    )
}

@Composable
fun MenuTheme(background: String = "#F7F4EE", accent: String = "#9C3D24", content: @Composable () -> Unit) {
    val backgroundColor = color(background, 0xFFF7F4EE)
    val accentColor = color(accent, 0xFF9C3D24)
    MaterialTheme(
        typography = OnestTypography,
        colorScheme = lightColorScheme(
            primary = accentColor,
            onPrimary = if (accentColor.luminance() > .5f) Color.Black else Color.White,
            background = backgroundColor,
            surface = backgroundColor,
            onBackground = if (backgroundColor.luminance() > .5f) Color(0xFF24211D) else Color.White,
            onSurface = if (backgroundColor.luminance() > .5f) Color(0xFF24211D) else Color.White,
        ),
        content = content,
    )
}

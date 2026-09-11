package ru.interactivefoodmenu.staff.ui

import androidx.core.graphics.toColorInt
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance

private fun color(value: String, fallback: Long) = runCatching { Color(value.toColorInt()) }.getOrDefault(Color(fallback))

@Composable
fun MenuTheme(background: String = "#F7F4EE", accent: String = "#9C3D24", content: @Composable () -> Unit) {
    val backgroundColor = color(background, 0xFFF7F4EE)
    val accentColor = color(accent, 0xFF9C3D24)
    MaterialTheme(
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

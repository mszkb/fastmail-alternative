package net.fma.mail.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.lerp
import net.fma.mail.ui.theme.FmaTokens

// Theme from the shared design tokens (#141, packages/design-tokens): the
// same colors as the PWA's daisyUI themes "fma-light" / "fma-dark".
// Muted text (onSurfaceVariant) mixes like the PWA's --fma-muted.

private val Light = with(FmaTokens.Light) {
    lightColorScheme(
        primary = primary,
        onPrimary = primaryContent,
        primaryContainer = lerp(base100, primary, 0.14f),
        onPrimaryContainer = baseContent,
        secondary = secondary,
        onSecondary = secondaryContent,
        tertiary = accent,
        onTertiary = accentContent,
        background = base200,
        onBackground = baseContent,
        surface = base100,
        onSurface = baseContent,
        surfaceVariant = base200,
        onSurfaceVariant = lerp(base100, baseContent, 0.68f),
        surfaceContainer = base200,
        outline = lerp(base100, baseContent, 0.30f),
        outlineVariant = lerp(base100, baseContent, 0.16f),
        error = error,
        onError = errorContent,
        errorContainer = lerp(base100, error, 0.13f),
        onErrorContainer = baseContent,
    )
}

private val Dark = with(FmaTokens.Dark) {
    darkColorScheme(
        primary = primary,
        onPrimary = primaryContent,
        primaryContainer = lerp(base100, primary, 0.14f),
        onPrimaryContainer = baseContent,
        secondary = secondary,
        onSecondary = secondaryContent,
        tertiary = accent,
        onTertiary = accentContent,
        background = base100,
        onBackground = baseContent,
        surface = base100,
        onSurface = baseContent,
        surfaceVariant = base200,
        onSurfaceVariant = lerp(base100, baseContent, 0.68f),
        surfaceContainer = base200,
        outline = lerp(base100, baseContent, 0.30f),
        outlineVariant = lerp(base100, baseContent, 0.16f),
        error = error,
        onError = errorContent,
        errorContainer = lerp(base100, error, 0.13f),
        onErrorContainer = baseContent,
    )
}

private val FmaShapes = Shapes(
    extraSmall = RoundedCornerShape(FmaTokens.Radius.selector),
    small = RoundedCornerShape(FmaTokens.Radius.field),
    medium = RoundedCornerShape(FmaTokens.Radius.box),
)

@Composable
fun FmaTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) Dark else Light, shapes = FmaShapes, content = content)
}

import SwiftUI

/// Persisted theme selection key shared by the settings sheet and the app root.
enum ThemePreference {
    static let storageKey = "omp.theme"
}

/// Maps semantic UI roles onto one Catppuccin flavor.
struct AppTheme: Sendable, Equatable {
    let flavor: CatppuccinFlavor

    static let `default` = AppTheme(flavor: .default)

    var palette: CatppuccinPalette { flavor.palette }
    var colorScheme: ColorScheme { flavor.colorScheme }

    // MARK: Surfaces

    /// Main chat/list background.
    var background: Color { palette.base }
    /// Sidebar, sheets, and navigation bars.
    var secondaryBackground: Color { palette.mantle }
    /// Bubbles, cards, tool rows, and the composer.
    var elevatedSurface: Color { palette.surface0 }
    /// Hairlines and dividers.
    var separator: Color { palette.surface1 }

    // MARK: Text

    var primaryText: Color { palette.text }
    var secondaryText: Color { palette.subtext0 }
    var tertiaryText: Color { palette.overlay1 }

    // MARK: Accents

    var accent: Color { palette.mauve }
    /// Text and icons drawn on top of `accent`.
    var accentForeground: Color { flavor.isDark ? palette.crust : palette.base }

    /// Muted on purpose: a full-strength accent bubble is glaring on dark flavors.
    var userBubble: Color { palette.surface1 }
    var userBubbleForeground: Color { palette.text }

    /// Working / busy indicator.
    var working: Color { palette.yellow }
    /// Unread session dot.
    var unread: Color { palette.green }
    /// Connected session status.
    var connected: Color { palette.green }
    /// Connecting / reconnecting status.
    var pending: Color { palette.yellow }
    var error: Color { palette.red }
    var errorForeground: Color { flavor.isDark ? palette.crust : palette.base }

    // MARK: Components

    var toolSurface: Color { palette.surface0 }
    var toolIcon: Color { palette.blue }
    var codeBackground: Color { palette.crust }
    var link: Color { palette.blue }
    var inlineCodeBackground: Color { palette.surface0 }
    var inlineCodeForeground: Color { palette.peach }
    var terminalBackground: Color { palette.crust }
    var terminalForeground: Color { palette.text }
}

// MARK: - Environment

private struct AppThemeKey: EnvironmentKey {
    static let defaultValue = AppTheme.default
}

extension EnvironmentValues {
    var appTheme: AppTheme {
        get { self[AppThemeKey.self] }
        set { self[AppThemeKey.self] = newValue }
    }
}

extension View {
    /// Installs the palette plus the matching system color scheme and tint.
    func appTheme(_ theme: AppTheme) -> some View {
        self
            .environment(\.appTheme, theme)
            .preferredColorScheme(theme.colorScheme)
            .tint(theme.accent)
    }
}

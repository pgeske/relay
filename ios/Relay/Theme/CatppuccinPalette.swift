import SwiftUI

/// The four official Catppuccin flavors.
///
/// Raw values are persisted in `UserDefaults`, so they must stay stable.
enum CatppuccinFlavor: String, CaseIterable, Identifiable, Sendable {
    case latte
    case frappe
    case macchiato
    case mocha

    static let `default`: CatppuccinFlavor = .frappe

    var id: String { rawValue }

    var title: String {
        switch self {
        case .latte: "Latte"
        case .frappe: "Frappé"
        case .macchiato: "Macchiato"
        case .mocha: "Mocha"
        }
    }

    var isDark: Bool {
        switch self {
        case .latte: false
        case .frappe, .macchiato, .mocha: true
        }
    }

    var colorScheme: ColorScheme {
        isDark ? .dark : .light
    }

    var palette: CatppuccinPalette {
        switch self {
        case .latte: .latte
        case .frappe: .frappe
        case .macchiato: .macchiato
        case .mocha: .mocha
        }
    }
}

/// One flavor's complete set of named Catppuccin colors.
///
/// Hex values come from the official palette:
/// https://github.com/catppuccin/palette/blob/main/palette.json (v1.8.0).
struct CatppuccinPalette: Sendable, Equatable {
    let rosewater: Color
    let flamingo: Color
    let pink: Color
    let mauve: Color
    let red: Color
    let maroon: Color
    let peach: Color
    let yellow: Color
    let green: Color
    let teal: Color
    let sky: Color
    let sapphire: Color
    let blue: Color
    let lavender: Color

    let text: Color
    let subtext1: Color
    let subtext0: Color
    let overlay2: Color
    let overlay1: Color
    let overlay0: Color

    let surface2: Color
    let surface1: Color
    let surface0: Color

    let base: Color
    let mantle: Color
    let crust: Color

    static let latte = CatppuccinPalette(
        rosewater: Color(hex: 0xdc8a78),
        flamingo: Color(hex: 0xdd7878),
        pink: Color(hex: 0xea76cb),
        mauve: Color(hex: 0x8839ef),
        red: Color(hex: 0xd20f39),
        maroon: Color(hex: 0xe64553),
        peach: Color(hex: 0xfe640b),
        yellow: Color(hex: 0xdf8e1d),
        green: Color(hex: 0x40a02b),
        teal: Color(hex: 0x179299),
        sky: Color(hex: 0x04a5e5),
        sapphire: Color(hex: 0x209fb5),
        blue: Color(hex: 0x1e66f5),
        lavender: Color(hex: 0x7287fd),
        text: Color(hex: 0x4c4f69),
        subtext1: Color(hex: 0x5c5f77),
        subtext0: Color(hex: 0x6c6f85),
        overlay2: Color(hex: 0x7c7f93),
        overlay1: Color(hex: 0x8c8fa1),
        overlay0: Color(hex: 0x9ca0b0),
        surface2: Color(hex: 0xacb0be),
        surface1: Color(hex: 0xbcc0cc),
        surface0: Color(hex: 0xccd0da),
        base: Color(hex: 0xeff1f5),
        mantle: Color(hex: 0xe6e9ef),
        crust: Color(hex: 0xdce0e8)
    )

    static let frappe = CatppuccinPalette(
        rosewater: Color(hex: 0xf2d5cf),
        flamingo: Color(hex: 0xeebebe),
        pink: Color(hex: 0xf4b8e4),
        mauve: Color(hex: 0xca9ee6),
        red: Color(hex: 0xe78284),
        maroon: Color(hex: 0xea999c),
        peach: Color(hex: 0xef9f76),
        yellow: Color(hex: 0xe5c890),
        green: Color(hex: 0xa6d189),
        teal: Color(hex: 0x81c8be),
        sky: Color(hex: 0x99d1db),
        sapphire: Color(hex: 0x85c1dc),
        blue: Color(hex: 0x8caaee),
        lavender: Color(hex: 0xbabbf1),
        text: Color(hex: 0xc6d0f5),
        subtext1: Color(hex: 0xb5bfe2),
        subtext0: Color(hex: 0xa5adce),
        overlay2: Color(hex: 0x949cbb),
        overlay1: Color(hex: 0x838ba7),
        overlay0: Color(hex: 0x737994),
        surface2: Color(hex: 0x626880),
        surface1: Color(hex: 0x51576d),
        surface0: Color(hex: 0x414559),
        base: Color(hex: 0x303446),
        mantle: Color(hex: 0x292c3c),
        crust: Color(hex: 0x232634)
    )

    static let macchiato = CatppuccinPalette(
        rosewater: Color(hex: 0xf4dbd6),
        flamingo: Color(hex: 0xf0c6c6),
        pink: Color(hex: 0xf5bde6),
        mauve: Color(hex: 0xc6a0f6),
        red: Color(hex: 0xed8796),
        maroon: Color(hex: 0xee99a0),
        peach: Color(hex: 0xf5a97f),
        yellow: Color(hex: 0xeed49f),
        green: Color(hex: 0xa6da95),
        teal: Color(hex: 0x8bd5ca),
        sky: Color(hex: 0x91d7e3),
        sapphire: Color(hex: 0x7dc4e4),
        blue: Color(hex: 0x8aadf4),
        lavender: Color(hex: 0xb7bdf8),
        text: Color(hex: 0xcad3f5),
        subtext1: Color(hex: 0xb8c0e0),
        subtext0: Color(hex: 0xa5adcb),
        overlay2: Color(hex: 0x939ab7),
        overlay1: Color(hex: 0x8087a2),
        overlay0: Color(hex: 0x6e738d),
        surface2: Color(hex: 0x5b6078),
        surface1: Color(hex: 0x494d64),
        surface0: Color(hex: 0x363a4f),
        base: Color(hex: 0x24273a),
        mantle: Color(hex: 0x1e2030),
        crust: Color(hex: 0x181926)
    )

    static let mocha = CatppuccinPalette(
        rosewater: Color(hex: 0xf5e0dc),
        flamingo: Color(hex: 0xf2cdcd),
        pink: Color(hex: 0xf5c2e7),
        mauve: Color(hex: 0xcba6f7),
        red: Color(hex: 0xf38ba8),
        maroon: Color(hex: 0xeba0ac),
        peach: Color(hex: 0xfab387),
        yellow: Color(hex: 0xf9e2af),
        green: Color(hex: 0xa6e3a1),
        teal: Color(hex: 0x94e2d5),
        sky: Color(hex: 0x89dceb),
        sapphire: Color(hex: 0x74c7ec),
        blue: Color(hex: 0x89b4fa),
        lavender: Color(hex: 0xb4befe),
        text: Color(hex: 0xcdd6f4),
        subtext1: Color(hex: 0xbac2de),
        subtext0: Color(hex: 0xa6adc8),
        overlay2: Color(hex: 0x9399b2),
        overlay1: Color(hex: 0x7f849c),
        overlay0: Color(hex: 0x6c7086),
        surface2: Color(hex: 0x585b70),
        surface1: Color(hex: 0x45475a),
        surface0: Color(hex: 0x313244),
        base: Color(hex: 0x1e1e2e),
        mantle: Color(hex: 0x181825),
        crust: Color(hex: 0x11111b)
    )
}

extension Color {
    /// Creates an sRGB color from a 24-bit RGB hex literal.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

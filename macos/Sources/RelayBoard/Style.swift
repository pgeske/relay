import AppKit
import SwiftUI

extension Color {
    /// A color with its own shade for light and dark mode, readable as text on a faint fill of itself.
    fileprivate static func adaptive(light: UInt32, dark: UInt32) -> Color {
        func rgb(_ hex: UInt32) -> NSColor {
            NSColor(srgbRed: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
        return Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? rgb(dark) : rgb(light)
        })
    }

    static let boardGreen = adaptive(light: 0x1A7F37, dark: 0x3FB950)
    static let boardRed = adaptive(light: 0xCF222E, dark: 0xFF6B63)
    static let boardAmber = adaptive(light: 0x9A6700, dark: 0xE3B341)
    static let boardOrange = adaptive(light: 0xBC4C00, dark: 0xFF9F43)
    static let boardBlue = adaptive(light: 0x0969DA, dark: 0x58A6FF)
    static let boardPurple = adaptive(light: 0x8250DF, dark: 0xBC8CFF)
}

extension Tone {
    var color: Color {
        switch self {
        case .ok: .boardGreen
        case .bad: .boardRed
        case .wait: .boardAmber
        case .warn: .boardOrange
        case .link: .boardBlue
        case .muted, .ghost: .secondary
        }
    }
}

extension Lane {
    var symbol: String {
        switch id {
        case "draft": "pencil.line"
        case "agent-review": "sparkle.magnifyingglass"
        case "human-review": "person.2.fill"
        case "approved-blocked": "hand.raised.fill"
        case "ready": "checkmark.seal.fill"
        case "merged": "arrow.triangle.merge"
        default: "circle.fill"
        }
    }

    var tint: Color {
        switch id {
        case "draft": .gray
        case "agent-review": .boardPurple
        case "human-review": .boardBlue
        case "approved-blocked": .boardOrange
        case "ready": .boardGreen
        case "merged": .indigo
        default: .secondary
        }
    }
}

extension Tone {
    /// A value's text in its tone; neutral tones read as secondary text.
    var textStyle: AnyShapeStyle {
        self == .muted || self == .ghost ? AnyShapeStyle(.secondary) : AnyShapeStyle(color)
    }
}

extension Row {
    /// The symbol beside the row's label.
    var symbol: String {
        switch kind {
        case "ci": "checklist"
        case "agent": "sparkles"
        case "approvals": "person.2"
        case "slack": "bubble.left"
        default: "circle"
        }
    }
}

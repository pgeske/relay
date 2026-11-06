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

extension BoardAction {
    /// The symbol on a step's button, or beside a control in the card's menu.
    var symbol: String {
        switch action {
        case "review": "sparkle.magnifyingglass"
        case "ask-approval": "person.badge.plus"
        case "bump": "bell"
        case "merge": "arrow.triangle.merge"
        case "fix-ci": "wrench.and.screwdriver"
        case "start": "play.fill"
        case "approve-plan": "checkmark.circle.fill"
        case "ship": "paperplane.fill"
        case "send-back": "arrow.uturn.backward"
        case "open", "open-session": "terminal"
        case "track": "plus.circle"
        case "dismiss": "eye.slash"
        case "close-session": "xmark.circle"
        case "done": "paperplane"
        case "reopen": "arrow.uturn.backward"
        case "delete": "trash"
        case "skip-review": "forward"
        case "require-review": "arrow.uturn.backward"
        default: "arrow.right"
        }
    }

    /// A step's button color: its lane's, or a warning once its request stopped without a result.
    var tint: Color {
        if stalled == true { return .boardOrange }
        return switch action {
        case "review": .boardPurple
        case "merge", "approve-plan", "ship": .boardGreen
        default: .boardBlue
        }
    }
}

extension TaskLane {
    var symbol: String {
        switch id {
        case "needs-you": "bell.badge.fill"
        case "ship": "shippingbox.fill"
        case "working": "sparkles"
        case "waiting": "hourglass"
        case "paused": "pause.circle.fill"
        case "untracked": "questionmark.circle"
        case "ideas": "lightbulb.fill"
        case "done": "checkmark.seal.fill"
        default: "circle.fill"
        }
    }

    var tint: Color {
        switch id {
        case "needs-you": .boardOrange
        case "ship": .boardGreen
        case "working": .boardPurple
        case "waiting": .boardBlue
        case "ideas": .boardAmber
        case "done": .boardGreen
        default: .gray
        }
    }
}

/// A task's color, by the hue the server gave it, so its card and its PRs' chips match.
func taskColor(_ hue: Int) -> Color {
    let palette: [Color] = [.blue, .purple, .pink, .orange, .teal, .green, .indigo, .brown]
    return palette[((hue % palette.count) + palette.count) % palette.count]
}

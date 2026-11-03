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

extension Tag {
    /// The symbol leading the tag; running tags show a spinner instead.
    var symbol: String? {
        switch (kind, tone) {
        case ("ci", .ok): "checkmark.circle.fill"
        case ("ci", .bad): "xmark.circle.fill"
        case ("ci", _): "clock.fill"
        case ("ci-fix", _): "wrench.adjustable"
        case ("gate", _): "lock.fill"
        case ("changes-requested", _): "exclamationmark.bubble.fill"
        case ("agent-review", _): "sparkles"
        case ("approval", _): "bubble.left.and.text.bubble.right.fill"
        case ("merged", _): "arrow.triangle.merge"
        case (_, .warn): "exclamationmark.triangle.fill"
        default: nil
        }
    }
}

/// Lays its views out in rows, wrapping to a new row when one is full.
struct FlowLayout: Layout {
    var spacing: CGFloat = 5
    var rowSpacing: CGFloat = 5

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(subviews, width: proposal.width ?? .infinity).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let frames = arrange(subviews, width: bounds.width).frames
        for (subview, frame) in zip(subviews, frames) {
            subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> (frames: [CGRect], size: CGSize) {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(.unspecified)
            if size.width > width { size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil)) }
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + rowSpacing
                rowHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            widest = max(widest, x + size.width)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return (frames, CGSize(width: widest, height: y + rowHeight))
    }
}

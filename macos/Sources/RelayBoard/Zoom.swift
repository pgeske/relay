import SwiftUI

/// The board's text size, set with ⌘+ / ⌘− / ⌘0 and remembered between launches. macOS doesn't
/// scale app text on its own, so the board's fonts are built from these sizes times the zoom.
@MainActor @Observable
final class Zoom {
    static let shared = Zoom()

    static let steps: [Double] = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2]
    private static let key = "zoom"

    private(set) var scale: Double {
        didSet { UserDefaults.standard.set(scale, forKey: Self.key) }
    }

    private init() {
        let saved = UserDefaults.standard.double(forKey: Self.key)
        scale = Self.steps.contains(saved) ? saved : 1
    }

    var canZoomIn: Bool { scale < Self.steps.last! }
    var canZoomOut: Bool { scale > Self.steps.first! }

    func zoomIn() { if let next = Self.steps.first(where: { $0 > scale }) { scale = next } }
    func zoomOut() { if let next = Self.steps.last(where: { $0 < scale }) { scale = next } }
    func reset() { scale = 1 }
}

/// macOS's text-style sizes in points, at 100%.
enum BoardTextStyle: CGFloat {
    case caption = 10
    case subheadline = 11
    case callout = 12
    case body = 13
    case title3 = 15
    case title2 = 17
}

extension Font {
    /// A text style at the board's zoom. Views that read it redraw when the zoom changes,
    /// because reading `Zoom.shared.scale` inside a view's body is tracked by Observation.
    @MainActor static func zoomed(_ style: BoardTextStyle) -> Font {
        .system(size: style.rawValue * Zoom.shared.scale)
    }

    /// macOS's headline: body size, bold.
    @MainActor static var zoomedHeadline: Font { zoomed(.body).weight(.bold) }

    /// A fixed point size at the board's zoom, for small glyphs like chevrons.
    @MainActor static func zoomed(size: CGFloat, weight: Font.Weight) -> Font {
        .system(size: size * Zoom.shared.scale, weight: weight)
    }
}

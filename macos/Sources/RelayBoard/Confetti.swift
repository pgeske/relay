import SwiftUI

/// Confetti shot up from the window's bottom corners, fluttering back down and fading out, for
/// shipping a task. It draws over the window without taking clicks; show a new one per shipment.
struct ConfettiBurst: View {
    static let duration: TimeInterval = 3.2

    @State private var started = Date.now
    @State private var pieces = (0..<160).map { Piece(fromLeft: $0.isMultiple(of: 2)) }

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let t = timeline.date.timeIntervalSince(started)
                guard t < Self.duration else { return }
                for piece in pieces { draw(piece, at: t, in: &context, size: size) }
            }
        }
        .allowsHitTesting(false)
    }

    /// Where a piece is `t` seconds in. Air drag slows its launch (`k`) and caps its fall at a
    /// gentle flutter (`fall`), so it rises fast, hangs, and drifts down.
    private func draw(_ piece: Piece, at t: TimeInterval, in context: inout GraphicsContext, size: CGSize) {
        let k = 1.6
        let fall = 160.0
        let slowed = (1 - exp(-k * t)) / k
        let side: CGFloat = piece.fromLeft ? 1 : -1
        let x = (piece.fromLeft ? 0 : size.width) + side * piece.across * size.width * k * slowed + sin(t * piece.sway) * 10
        let y = size.height + fall * t - (piece.up * size.height * k + fall) * slowed

        var layer = context
        layer.opacity = min(1, (Self.duration - t) / 0.8)
        layer.translateBy(x: x, y: y)
        layer.rotate(by: .radians(piece.spin * t + piece.phase))
        // Turning over in the air: it narrows and widens.
        layer.scaleBy(x: cos(piece.flip * t + piece.phase), y: 1)
        let rect = CGRect(x: -piece.size.width / 2, y: -piece.size.height / 2, width: piece.size.width, height: piece.size.height)
        layer.fill(Path(roundedRect: rect, cornerRadius: 1.5), with: .color(piece.color))
    }

    struct Piece {
        let fromLeft: Bool
        /// How far across and how high it flies, as fractions of the window.
        let across = Double.random(in: 0.12...0.6)
        let up = Double.random(in: 0.45...0.95)
        let size = CGSize(width: .random(in: 5...9), height: .random(in: 8...14))
        let color = [Color.boardGreen, .boardBlue, .boardPurple, .boardAmber, .boardOrange, .boardRed].randomElement()!
        let spin = Double.random(in: -6...6)
        let flip = Double.random(in: 4...11)
        let sway = Double.random(in: 2...5)
        let phase = Double.random(in: 0...(2 * .pi))
    }
}

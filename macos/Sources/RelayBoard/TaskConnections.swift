import SwiftUI

/// Resolve card bounds in the scroll viewport, not in screen coordinates. Filtering or folding a
/// section removes its anchors; scrolling and wrapping the grid move the remaining ones together.
struct TaskLinkAnchor {
    let bounds: Anchor<CGRect>
    let prerequisites: [RelatedTask]
    let hue: Int
}

struct TaskLinkAnchors: PreferenceKey {
    static let defaultValue: [Int: TaskLinkAnchor] = [:]

    static func reduce(value: inout [Int: TaskLinkAnchor], nextValue: () -> [Int: TaskLinkAnchor]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

private struct HoveredTaskLink: EnvironmentKey {
    static let defaultValue: Binding<Int?> = .constant(nil)
}

extension EnvironmentValues {
    var hoveredTaskLink: Binding<Int?> {
        get { self[HoveredTaskLink.self] }
        set { self[HoveredTaskLink.self] = newValue }
    }
}

struct TaskConnections: ViewModifier {
    @Binding var hovered: Int?

    func body(content: Content) -> some View {
        content
            .environment(\.hoveredTaskLink, $hovered)
            .overlayPreferenceValue(TaskLinkAnchors.self) { anchors in
                if !anchors.isEmpty {
                    GeometryReader { geometry in
                        Canvas { context, size in
                            // Paint the focused links last so quieter paths never cover them.
                            let focus = hovered.flatMap { anchors[$0] == nil ? nil : $0 }
                            for focusedPass in [false, true] {
                                if focusedPass && focus == nil { break }
                                for (targetID, target) in anchors {
                                    for link in target.prerequisites where !link.shipped {
                                        guard let source = anchors[link.id] else { continue }
                                        let focused = focus == targetID || focus == link.id
                                        guard focused == focusedPass else { continue }
                                        let from = geometry[source.bounds], to = geometry[target.bounds]
                                        let ink = taskColor(source.hue).opacity(focused ? 1 : focus == nil ? 0.62 : 0.12)
                                        drawArrow(from: from, to: to, width: size.width, color: ink, focused: focused, in: context)
                                        if focused {
                                            for rect in [from, to] {
                                                context.stroke(Path(roundedRect: rect.insetBy(dx: 1, dy: 1), cornerRadius: 12), with: .color(ink), lineWidth: 2)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .clipped()
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
            }
    }
}

/// Stay in the gaps between rows. For distant rows use the outer gutter, so the line never
/// crosses card text (or the stage headings). A dot is the prerequisite; the arrow is its dependent.
private func drawArrow(from a: CGRect, to b: CGRect, width: CGFloat, color: Color, focused: Bool, in context: GraphicsContext) {
    let sameRow = abs(a.minY - b.minY) < 1
    var start: CGPoint, end: CGPoint, direction: CGVector
    var path = Path()
    if sameRow && min(abs(a.maxX - b.minX), abs(b.maxX - a.minX)) < 20 {
        let right = b.midX > a.midX
        start = CGPoint(x: right ? a.maxX - 1 : a.minX + 1, y: a.midY)
        end = CGPoint(x: right ? b.minX + 2 : b.maxX - 2, y: a.midY)
        direction = CGVector(dx: right ? 1 : -1, dy: 0)
        path.move(to: start)
    } else {
        let down = b.midY > a.midY && !sameRow
        // Separate inbound and outbound ports when a card has both kinds of link.
        start = CGPoint(x: a.midX + 9, y: down ? a.maxY - 1 : a.minY + 1)
        end = CGPoint(x: b.midX - 9, y: down || sameRow ? b.minY + 2 : b.maxY - 2)
        direction = CGVector(dx: 0, dy: down || sameRow ? 1 : -1)
        let exitY = start.y + (down ? 6 : -6)
        let entryY = end.y - 7 * direction.dy
        path.move(to: start)
        path.addLine(to: CGPoint(x: start.x, y: exitY))
        if abs(exitY - entryY) > 1 {
            let rail: CGFloat = a.midX + b.midX <= width ? 10 : width - 10
            path.addLine(to: CGPoint(x: rail, y: exitY))
            path.addLine(to: CGPoint(x: rail, y: entryY))
        }
        path.addLine(to: CGPoint(x: end.x, y: entryY))
    }
    path.addLine(to: end)
    context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: focused ? 2.5 : 1.5, lineCap: .round, lineJoin: .round))
    let base = CGPoint(x: end.x - 6 * direction.dx, y: end.y - 6 * direction.dy)
    var head = Path()
    head.move(to: end)
    head.addLine(to: CGPoint(x: base.x - 4 * direction.dy, y: base.y + 4 * direction.dx))
    head.addLine(to: CGPoint(x: base.x + 4 * direction.dy, y: base.y - 4 * direction.dx))
    head.closeSubpath()
    context.fill(head, with: .color(color))
    context.fill(Path(ellipseIn: CGRect(x: start.x - 2.5, y: start.y - 2.5, width: 5, height: 5)), with: .color(color))
}

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
                        let routes = routes(for: anchors, in: geometry)
                        Canvas { context, _ in
                            // Paint the focused links last so quieter paths never cover them.
                            let focus = hovered.flatMap { anchors[$0] == nil ? nil : $0 }
                            for focusedPass in [false, true] {
                                if focusedPass && focus == nil { break }
                                for route in routes {
                                    let edge = route.edge
                                    let focused = focus == edge.target || focus == edge.source
                                    guard focused == focusedPass else { continue }
                                    let ink = taskColor(edge.hue).opacity(focused ? 1 : focus == nil ? 0.85 : 0.12)
                                    if focused {
                                        for rect in [edge.from, edge.to] {
                                            context.stroke(Path(roundedRect: rect.insetBy(dx: 1, dy: 1), cornerRadius: 12), with: .color(ink), lineWidth: 2)
                                        }
                                    }
                                    drawArrow(route.points, color: ink, focused: focused, in: context)
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

    private func routes(for anchors: [Int: TaskLinkAnchor], in geometry: GeometryProxy) -> [RoutedTaskLink] {
        var edges: [TaskLinkEdge] = []
        for (id, target) in anchors {
            for link in target.prerequisites where !link.shipped {
                guard let source = anchors[link.id] else { continue }
                edges.append(TaskLinkEdge(source: link.id, target: id, from: geometry[source.bounds], to: geometry[target.bounds], hue: source.hue))
            }
        }
        return routeTaskLinks(&edges, width: geometry.size.width)
    }
}

/// Only the dependent end has a marker. Its direction comes from the final leg of the route.
private func drawArrow(_ points: [CGPoint], color: Color, focused: Bool, in context: GraphicsContext) {
    let end = points[points.count - 1], previous = points[points.count - 2]
    let dx = end.x - previous.x, dy = end.y - previous.y
    let distance = hypot(dx, dy)
    guard distance > 0 else { return }
    let direction = CGVector(dx: dx / distance, dy: dy / distance)
    // Let the tip enter the card's padding. Even in a narrow gap there's a visible shaft
    // before the head, so adjacent tasks don't look like a pair of matching end markers.
    let length: CGFloat = focused ? 16 : 13
    let halfWidth: CGFloat = focused ? 10 : 8
    let base = CGPoint(x: end.x - length * direction.dx, y: end.y - length * direction.dy)
    var path = Path()
    path.move(to: points[0])
    for corner in points.dropFirst().dropLast() { path.addLine(to: corner) }
    path.addLine(to: base)
    context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: focused ? 4 : 3, lineCap: .butt, lineJoin: .round))
    var head = Path()
    head.move(to: end)
    head.addLine(to: CGPoint(x: base.x - halfWidth * direction.dy, y: base.y + halfWidth * direction.dx))
    head.addLine(to: CGPoint(x: base.x + halfWidth * direction.dy, y: base.y - halfWidth * direction.dx))
    head.closeSubpath()
    context.fill(head, with: .color(color))
}

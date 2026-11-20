import SwiftUI

/// The task whose links you're looking at: hovering a linked card focuses it. Its linked
/// cards light up and say how they relate, every other card fades, and arrows run from each
/// prerequisite into the task that waits on it. Nothing is drawn otherwise, so a board with many
/// links stays as calm as one without.
struct TaskLinkFocus: Equatable {
    let id: Int
    let ref: String
    let hue: Int
    /// Its unshipped prerequisites and dependents.
    let waitsOn: Set<Int>
    let blocks: Set<Int>
}

/// How a card relates to the focused task, so it can light up or fade.
enum TaskLinkRole {
    case focused, prerequisite, dependent, unrelated
}

extension TaskLinkFocus {
    func role(of card: Int) -> TaskLinkRole {
        if card == id { return .focused }
        if waitsOn.contains(card) { return .prerequisite }
        if blocks.contains(card) { return .dependent }
        return .unrelated
    }
}

/// Card bounds in the scroll viewport, so folding a section drops its anchors and scrolling moves
/// the rest together.
struct TaskLinkAnchors: PreferenceKey {
    static let defaultValue: [Int: Anchor<CGRect>] = [:]

    static func reduce(value: inout [Int: Anchor<CGRect>], nextValue: () -> [Int: Anchor<CGRect>]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

private struct TaskLinkFocusKey: EnvironmentKey {
    static let defaultValue: Binding<TaskLinkFocus?> = .constant(nil)
}

extension EnvironmentValues {
    var taskLinkFocus: Binding<TaskLinkFocus?> {
        get { self[TaskLinkFocusKey.self] }
        set { self[TaskLinkFocusKey.self] = newValue }
    }
}

struct TaskConnections: ViewModifier {
    @Binding var focus: TaskLinkFocus?

    func body(content: Content) -> some View {
        content
            .environment(\.taskLinkFocus, $focus)
            .overlayPreferenceValue(TaskLinkAnchors.self) { anchors in
                if let focus, let center = anchors[focus.id] {
                    GeometryReader { geometry in
                        let focused = geometry[center]
                        // Only links between cards in view; the dependency row names the rest.
                        let prerequisites = focus.waitsOn.sorted().compactMap { anchors[$0].map { geometry[$0] } }
                        let dependents = focus.blocks.sorted().compactMap { anchors[$0].map { geometry[$0] } }
                        let ports = focusedPorts(focused, linkedTo: prerequisites + dependents)
                        Canvas { context, _ in
                            let ink = taskColor(focus.hue)
                            for (index, other) in prerequisites.enumerated() {
                                drawLink(from: other, to: focused, startX: lean(other, toward: focused), endX: ports[index], color: ink, in: context)
                            }
                            for (index, other) in dependents.enumerated() {
                                drawLink(from: focused, to: other, startX: ports[prerequisites.count + index], endX: lean(other, toward: focused), color: ink, in: context)
                            }
                        }
                    }
                    .clipped()
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    .transition(.opacity)
                }
            }
    }
}

/// Where each link meets the focused card. Links that share its top edge, or its bottom edge, spread
/// out along it in the order of the cards they come from, so they never pile onto one arrowhead.
private func focusedPorts(_ focused: CGRect, linkedTo others: [CGRect]) -> [CGFloat] {
    var ports = others.map { lean(focused, toward: $0) }
    var byEdge: [Edge: [Int]] = [:]
    for (index, other) in others.enumerated() {
        guard let edge = verticalEdge(of: focused, facing: other) else { continue }
        byEdge[edge, default: []].append(index)
    }
    for indexes in byEdge.values where indexes.count > 1 {
        // Arcs along the row nest, the farthest card's outermost; links to other rows keep left to right.
        let key = { (i: Int) in isSameRow(focused, others[i]) ? -others[i].midX : others[i].midX }
        let ordered = indexes.sorted { key($0) < key($1) }
        let usable = focused.width * 0.7
        let step = usable / CGFloat(ordered.count - 1)
        for (slot, index) in ordered.enumerated() {
            ports[index] = focused.midX - usable / 2 + step * CGFloat(slot)
        }
    }
    return ports
}

/// The top or bottom edge of `card` a link to `other` uses; nil when they join side to side.
private func verticalEdge(of card: CGRect, facing other: CGRect) -> Edge? {
    if isSameRow(card, other) {
        return isAdjacent(card, other) ? nil : .top
    }
    return other.midY > card.midY ? .bottom : .top
}

private func isSameRow(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.midY - b.midY) < min(a.height, b.height) / 2
}

private func isAdjacent(_ a: CGRect, _ b: CGRect) -> Bool {
    b.midX > a.midX ? b.minX - a.maxX < 40 : a.minX - b.maxX < 40
}

/// One smooth curve from the prerequisite's edge into the dependent's, ending in an arrowhead.
/// Cards side by side in a row join at their facing sides; anything else leaves the edge facing
/// the other card and arrives head-on, so the arrow always reads in the direction work flows.
/// `startX` and `endX` say where along a top or bottom edge the link meets each card.
private func drawLink(from a: CGRect, to b: CGRect, startX: CGFloat, endX: CGFloat, color: Color, in context: GraphicsContext) {
    let start: CGPoint, end: CGPoint, startOut: CGVector, endIn: CGVector, reach: CGFloat
    if isSameRow(a, b) {
        let rightward = b.midX > a.midX
        if isAdjacent(a, b) {
            start = CGPoint(x: rightward ? a.maxX : a.minX, y: a.midY)
            end = CGPoint(x: rightward ? b.minX : b.maxX, y: b.midY)
            startOut = CGVector(dx: rightward ? 1 : -1, dy: 0)
            endIn = startOut
            reach = 20
        } else {
            // Farther along the row: a low arc over the cards between, in the gap above them. Longer
            // arcs rise a little higher, so arcs into one card nest instead of tracing each other.
            start = CGPoint(x: startX, y: a.minY)
            end = CGPoint(x: endX, y: b.minY)
            startOut = CGVector(dx: 0, dy: -1)
            endIn = CGVector(dx: 0, dy: 1)
            reach = min(48, 18 + abs(end.x - start.x) / 25)
        }
    } else {
        let downward = b.midY > a.midY
        start = CGPoint(x: startX, y: downward ? a.maxY : a.minY)
        end = CGPoint(x: endX, y: downward ? b.minY : b.maxY)
        startOut = CGVector(dx: 0, dy: downward ? 1 : -1)
        endIn = startOut
        reach = max(28, min(90, abs(end.y - start.y) / 2))
    }
    let head: CGFloat = 11
    // The curve stops at the arrowhead's base so the line doesn't poke through its tip.
    let base = CGPoint(x: end.x - endIn.dx * head, y: end.y - endIn.dy * head)
    var curve = Path()
    curve.move(to: start)
    curve.addCurve(
        to: base,
        control1: CGPoint(x: start.x + startOut.dx * reach, y: start.y + startOut.dy * reach),
        control2: CGPoint(x: base.x - endIn.dx * reach, y: base.y - endIn.dy * reach)
    )
    // A halo in the window's color keeps the line legible where it crosses a faded card.
    context.stroke(curve, with: .color(Color(nsColor: .windowBackgroundColor).opacity(0.9)), style: StrokeStyle(lineWidth: 6, lineCap: .round))
    context.stroke(curve, with: .color(color), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
    var arrow = Path()
    arrow.move(to: end)
    arrow.addLine(to: CGPoint(x: base.x - endIn.dy * head * 0.7, y: base.y + endIn.dx * head * 0.7))
    arrow.addLine(to: CGPoint(x: base.x + endIn.dy * head * 0.7, y: base.y - endIn.dx * head * 0.7))
    arrow.closeSubpath()
    context.fill(Path(ellipseIn: CGRect(x: start.x - 3.5, y: start.y - 3.5, width: 7, height: 7)), with: .color(color))
    context.fill(arrow, with: .color(color))
}

/// Where a link meets a card's top or bottom edge: off center, toward the other card, so links from
/// different cards into one card land apart instead of stacking on one arrowhead.
private func lean(_ card: CGRect, toward other: CGRect) -> CGFloat {
    let shift = max(-card.width / 3, min(card.width / 3, (other.midX - card.midX) / 4))
    return card.midX + shift
}

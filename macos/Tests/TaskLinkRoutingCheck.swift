import CoreGraphics

// Run from the root with the Command Line Tools (no Xcode required):
// swiftc macos/Sources/RelayBoard/TaskLinkRouting.swift macos/Tests/TaskLinkRoutingCheck.swift -o /tmp/check-links && /tmp/check-links
@main struct TaskLinkRoutingCheck {
    static func main() {
        let middle = CGRect(x: 320, y: 300, width: 280, height: 120)
        let first = CGRect(x: 900, y: 300, width: 280, height: 120)
        let last = CGRect(x: 30, y: 50, width: 280, height: 100)
        var edges = [TaskLinkEdge(source: 1, target: 2, from: first, to: middle, hue: 1), TaskLinkEdge(source: 2, target: 3, from: middle, to: last, hue: 2)]
        let routes = routeTaskLinks(&edges, width: 1200)
        let intoMiddle = routes.first { $0.edge.target == 2 }!.points
        let outOfMiddle = routes.first { $0.edge.source == 2 }!.points
        // Two links used to meet above the middle card like a single ambiguous junction.
        precondition(intoMiddle.dropLast().last!.y > middle.maxY && middle.contains(intoMiddle.last!))
        precondition(outOfMiddle[1].y < middle.minY && last.contains(outOfMiddle.last!))
        // Mirroring the row must not reverse the arrow direction on adjacent cards.
        for sign: CGFloat in [-1, 1] {
            let next = middle.offsetBy(dx: sign * (middle.width + 10), dy: 0)
            var adjacent = [TaskLinkEdge(source: 1, target: 2, from: middle, to: next, hue: 1)]
            let line = routeTaskLinks(&adjacent, width: 1200)[0].points
            precondition(next.contains(line.last!) && (line.last!.x - line[0].x) * sign > 0)
        }
    }
}

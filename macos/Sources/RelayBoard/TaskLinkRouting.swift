import CoreGraphics

struct TaskLinkEdge {
    let source, target: Int
    let from, to: CGRect
    let hue: Int
}

struct RoutedTaskLink {
    let edge: TaskLinkEdge
    let points: [CGPoint]
}

/// The grid gives each long link two safe routes: above/below its row, or around the left/right
/// margin for different rows. Prefer the route that conflicts with fewer already placed links.
/// Routing is independent of hover and input dictionary order, so tracing a link never moves it.
func routeTaskLinks(_ edges: inout [TaskLinkEdge], width: CGFloat) -> [RoutedTaskLink] {
    // Place cross-row links first: they have to touch the side facing the other row. Same-row
    // links can then take the free side. IDs break ties consistently across board refreshes.
    edges.sort {
        let sameRowA = abs($0.from.minY - $0.to.minY) < 1
        let sameRowB = abs($1.from.minY - $1.to.minY) < 1
        if sameRowA != sameRowB { return !sameRowA }
        return ($0.target, $0.source) < ($1.target, $1.source)
    }
    var routes: [RoutedTaskLink] = []
    routes.reserveCapacity(edges.count)
    for edge in edges {
        let a = edge.from, b = edge.to
        let sameRow = abs(a.minY - b.minY) < 1
        let right = b.midX > a.midX
        if sameRow && min(abs(a.maxX - b.minX), abs(b.maxX - a.minX)) < 20 {
            let start = CGPoint(x: right ? a.maxX - 4 : a.minX + 4, y: a.midY)
            let end = CGPoint(x: right ? b.minX + 9 : b.maxX - 9, y: a.midY)
            routes.append(RoutedTaskLink(edge: edge, points: [start, end]))
            continue
        }
        func candidate(alternate: Bool) -> [CGPoint] {
            let down = b.midY > a.midY
            let leaveBottom = sameRow ? alternate : down
            let enterTop = sameRow ? !alternate : down
            let leftRail = (a.midX + b.midX <= width) != alternate
            // Use ports facing the other endpoint or the margin the line actually takes, not
            // crossed ports near the card center. Leave the arrow tip inside the card's padding.
            let startX = a.midX + ((sameRow ? right : !leftRail) ? 24 : -24)
            let endX = b.midX + ((sameRow ? !right : !leftRail) ? 24 : -24)
            let start = CGPoint(x: startX, y: leaveBottom ? a.maxY - 1 : a.minY + 1)
            let exit = CGPoint(x: startX, y: leaveBottom ? a.maxY + 5 : a.minY - 5)
            let entry = CGPoint(x: endX, y: enterTop ? b.minY - 5 : b.maxY + 5)
            let end = CGPoint(x: endX, y: enterTop ? b.minY + 9 : b.maxY - 9)
            if sameRow || abs(exit.y - entry.y) <= 8 {
                let laneY = (exit.y + entry.y) / 2
                if abs(startX - endX) < 1 { return [start, end] }
                return [start, CGPoint(x: startX, y: laneY), CGPoint(x: endX, y: laneY), end]
            }
            let rail = leftRail ? 10 : width - 10
            return [start, exit, CGPoint(x: rail, y: exit.y), CGPoint(x: rail, y: entry.y), entry, end]
        }
        func conflicts(_ points: [CGPoint]) -> Int {
            var count = 0
            for other in routes {
                // Don't bring two links into the same side of a shared card if the other side
                // is free, even if their thin centerlines would just miss each other.
                if edge.target == other.edge.source && abs(points.last!.y - other.points[0].y) < 12 { count += 1 }
                if edge.source == other.edge.target && abs(points[0].y - other.points.last!.y) < 12 { count += 1 }
                for i in 1..<points.count {
                    let run = segmentBounds(points[i-1], points[i])
                    for j in 1..<other.points.count where run.intersects(segmentBounds(other.points[j-1], other.points[j])) { count += 1 }
                }
            }
            return count
        }
        var points = candidate(alternate: false)
        let cost = conflicts(points)
        if cost > 0 {
            let alternate = candidate(alternate: true)
            if conflicts(alternate) < cost { points = alternate }
        }
        routes.append(RoutedTaskLink(edge: edge, points: points))
    }
    return routes
}

private func segmentBounds(_ a: CGPoint, _ b: CGPoint) -> CGRect {
    CGRect(x: min(a.x, b.x) - 2, y: min(a.y, b.y) - 2, width: abs(a.x - b.x) + 4, height: abs(a.y - b.y) + 4)
}

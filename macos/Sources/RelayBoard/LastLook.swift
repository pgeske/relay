import Foundation

/// Where each task stood when you last looked away from the board, so the Overview can say what
/// moved since instead of leaving you to compare the board with your memory. Kept across launches.
struct LastLook: Codable, Equatable {
    var at: Date
    /// Each task's place, by id: "you", "moving" (its agent is actively working),
    /// "others", "blocked", "idle", or "idea"; "ship" once it's delivered and "done" once shipped.
    var places: [Int: String]

    private static let key = "overview.lastLook"

    static var saved: LastLook? {
        UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(LastLook.self, from: $0) }
    }

    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: Self.key)
    }

    init(at: Date, columns: [TaskColumn]) {
        self.at = at
        places = [:]
        for column in columns {
            for card in column.cards { places[card.id] = Self.place(of: card, in: column) }
        }
    }

    /// Only an actively working agent is "moving"; legacy "progress" counts as waiting on others.
    private static func place(of card: TaskCard, in column: TaskColumn) -> String {
        if column.id == "ship" || column.id == "done" { return column.id }
        if card.turn.id == "agent" { return "moving" }
        if card.turn.id == "progress" { return "others" }
        return card.turn.id
    }

    /// The tasks that moved since, what needs you first. One that only went quiet (idle) isn't news.
    func changes(in columns: [TaskColumn]) -> [TaskChange] {
        var changes: [TaskChange] = []
        for column in columns {
            for card in column.cards {
                let before = places[card.id]
                let now = Self.place(of: card, in: column)
                guard before != now, let news = Self.news(from: before, to: now) else { continue }
                changes.append(TaskChange(id: card.id, label: news.label, rank: news.rank))
            }
        }
        return changes.sorted { $0.rank < $1.rank }
    }

    private static func news(from before: String?, to now: String) -> (label: String, rank: Int)? {
        switch now {
        case "you": ("Now needs you", 0)
        case "ship": ("Ready to ship", 1)
        case "done": ("Shipped", 2)
        case "others": ("Now waiting on others", 3)
        case "moving": (before == nil ? "New" : "Moving again", 4)
        case "blocked": ("Set aside", 5)
        default: before == nil ? ("New", 4) : nil
        }
    }
}

/// A task that moved since you last looked, and how.
struct TaskChange: Identifiable {
    let id: Int
    /// "Now needs you", "Shipped".
    let label: String
    /// Its place in the list: what needs you first.
    let rank: Int
}

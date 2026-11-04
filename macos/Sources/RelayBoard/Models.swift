import Foundation

// The board as relay's server shapes it for this app: `GET /api/board`, typed in src/board/view.ts.
// The server decides what each card offers and how it's worded; the app lays it out.

struct Board: Decodable, Sendable {
    var lanes: [Lane]
    /// When the board's GitHub data was fetched; nil when it never was.
    var updatedAt: Date?
    /// Set when the latest refresh failed; the lanes are then from `updatedAt`.
    var error: String?
    var agentWorking: Bool
    var refreshSeconds: Int
}

struct Lane: Decodable, Sendable, Identifiable {
    var id: String
    var title: String
    var hint: String
    /// Waiting on you to act.
    var hot: Bool
    var cards: [Card]
}

struct Card: Decodable, Sendable, Identifiable {
    /// "owner/repo#12": what the card's actions name.
    var ref: String
    var repo: String
    var repoName: String
    var number: Int
    var url: URL
    var title: String
    var ticket: String?
    var updatedAt: Date
    var idleDays: Int
    var stale: Bool
    var mergedAt: Date?
    var age: Age
    var rows: [Row]
    var notices: [Notice]
    var session: Session?
    var steps: [BoardAction]
    /// The request the session is on, shown in place of the steps when no row already says it.
    var running: String?
    var close: BoardAction?

    var id: String { ref }
}

/// How long ago the PR last changed, or merged, as the card's header says it.
struct Age: Decodable, Sendable, Hashable {
    var text: String
    var tone: Tone
    var hint: String?
}

/// One line of a card's status: a label, then a short value in its tone. A row acts on at most one
/// of its action, detail, and link, in that order.
struct Row: Decodable, Sendable, Hashable {
    var kind: String
    var label: String
    var value: String
    var tone: Tone
    var hint: String?
    /// The session is on what the value says right now, like fixing CI.
    var running: Bool
    /// Clicking asks the PR's session for this (red CI asks it to fix CI).
    var action: BoardAction?
    /// Clicking shows what an agent wrote.
    var detail: Detail?
    /// Clicking opens this, like the approval ask in Slack.
    var link: URL?
}

/// Something on the card that needs you, like a request that stopped without a result.
struct Notice: Decodable, Sendable, Hashable {
    var tone: Tone
    var text: String
    var hint: String?
    /// Clicking shows what an agent wrote.
    var detail: Detail?
}

enum Tone: String, Decodable, Sendable {
    case ok, bad, wait, muted, warn, link, ghost

    init(from decoder: any Decoder) throws {
        self = Tone(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .muted
    }
}

/// A control on a card: `POST /api/board/actions/<action>` with the card's ref.
struct BoardAction: Decodable, Sendable, Hashable {
    var action: String
    var label: String
    var hint: String
    /// What the card says once the session has taken the request on.
    var running: String?
    /// Asked before the server is.
    var confirm: Confirm?
}

struct Confirm: Decodable, Sendable, Hashable {
    var title: String
    var message: String
    var button: String
    var destructive: Bool
}

/// What an agent concluded: a review, or how a CI fix went.
struct Detail: Decodable, Sendable, Hashable {
    var title: String
    var verdict: String
    var tone: Tone
    var commit: String
    var at: Date
    var note: String?
    var summary: String?
}

/// The omp session in charge of a PR.
struct Session: Decodable, Sendable, Hashable {
    enum State: String, Decodable, Sendable {
        case open, working, closed

        init(from decoder: any Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .open
        }
    }

    var title: String
    var state: State
    /// On one of the board's requests, which the card says in a row or its footer.
    var busy: Bool
    var open: BoardAction
}

extension Card {
    /// The card once its session took `running` on, before the server's board shows it: the step
    /// buttons and the rows' controls give way to the request running in the footer.
    func takingOn(_ running: String) -> Card {
        var card = self
        card.steps = []
        card.rows = rows.map { row in
            guard row.action != nil else { return row }
            var plain = row
            plain.action = nil
            plain.hint = nil
            return plain
        }
        card.running = running
        card.session?.busy = true
        return card
    }
}

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
    var tags: [Tag]
    var session: Session?
    var steps: [BoardAction]
    var close: BoardAction?

    var id: String { ref }
}

struct Tag: Decodable, Sendable, Hashable {
    var kind: String
    var tone: Tone
    var text: String
    var hint: String?
    /// A request its session is working on right now.
    var running: Bool
    /// Clicking asks the PR's session for this (the red CI tag asks it to fix CI).
    var action: BoardAction?
    /// Clicking shows what an agent wrote.
    var detail: Detail?
    /// Clicking opens this, like the approval ask in Slack.
    var link: URL?
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
    /// On one of the board's requests, whose tag says so.
    var busy: Bool
    var open: BoardAction
}

extension Card {
    /// The card once its session took `running` on, before the server's board shows it: the step
    /// buttons and the controls that ask for a step give way to the request's running tag, and the
    /// red CI tag stays, as a plain tag.
    func takingOn(_ running: String) -> Card {
        var card = self
        card.steps = []
        card.tags = tags.compactMap { tag in
            guard tag.action != nil else { return tag }
            guard tag.kind == "ci" else { return nil }
            var plain = tag
            plain.action = nil
            plain.hint = nil
            return plain
        }
        card.tags.append(Tag(kind: "request", tone: .wait, text: running, running: true))
        card.session?.busy = true
        return card
    }
}

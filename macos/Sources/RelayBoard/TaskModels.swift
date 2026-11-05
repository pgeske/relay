import Foundation

// Your tasks as relay's server shapes them for this app, in `GET /api/board`'s `tasks`, typed in
// src/board/taskBoard.ts. As with PRs, the server decides what each card says and offers.

struct TaskBoard: Decodable, Sendable {
    var lanes: [TaskLane]
    var projects: [Project]
    var needsYou: Int
    /// Folders a new task can start in, most recent first.
    var folders: [String]
}

struct TaskLane: Decodable, Sendable, Identifiable {
    var id: String
    var title: String
    var hint: String
    /// Waiting on you to act.
    var hot: Bool
    var cards: [TaskCard]
    /// Open sessions no task knows about; only the Not tracked section has them.
    var sessions: [UntrackedSession]
}

struct Project: Decodable, Sendable, Identifiable, Hashable {
    var id: Int
    var name: String
    /// Its tasks not done yet, and how many of them need you.
    var open: Int
    var needsYou: Int
}

struct TaskCard: Decodable, Sendable, Identifiable {
    var id: Int
    /// "T-12".
    var ref: String
    var title: String
    var details: String?
    var project: ProjectRef?
    /// Its color, shared with its PRs' chips.
    var hue: Int
    var stage: String
    var stageLabel: String
    var stages: [StageStep]
    /// The agent's latest report.
    var status: TaskStatus?
    /// Why it's in its section.
    var reason: Reason
    var plan: Plan?
    var prs: [TaskPR]
    var session: TaskSession?
    var steps: [BoardAction]
    /// Said in the step's place for the moment between a control the window ran (Start, Approve
    /// Plan) and the server's board catching up; the server never sends it.
    var running: String?
    var menu: [BoardAction]
    var history: [HistoryItem]
    var updatedAt: Date
}

struct ProjectRef: Decodable, Sendable, Hashable {
    var id: Int
    var name: String
}

struct StageStep: Decodable, Sendable, Hashable {
    enum State: String, Decodable, Sendable {
        case done, current, todo

        init(from decoder: any Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .todo
        }
    }

    var id: String
    var label: String
    var state: State
}

struct TaskStatus: Decodable, Sendable, Hashable {
    var text: String
    var ago: String
}

struct Reason: Decodable, Sendable, Hashable {
    var text: String
    var tone: Tone
    /// How long it's been so, like "12m".
    var since: String?
}

struct Plan: Decodable, Sendable, Hashable {
    var text: String
    var at: Date
    /// Which plan this is; approving names it, so a plan revised since you read it isn't approved.
    var revision: String
    /// It waits for your approval.
    var awaiting: Bool
    var approved: Bool
}

struct TaskPR: Decodable, Sendable, Hashable, Identifiable {
    var ref: String
    var repoName: String
    var number: Int
    var title: String
    var url: URL
    /// Its PR board lane, in words.
    var state: String
    var tone: Tone

    var id: String { ref }
}

struct TaskSession: Decodable, Sendable, Hashable {
    var title: String
    var state: Session.State
    var open: BoardAction
    /// The task's other sessions.
    var others: Int
}

struct HistoryItem: Decodable, Sendable, Hashable {
    var at: Date
    var text: String
    var stage: String
}

struct UntrackedSession: Decodable, Sendable, Identifiable {
    var sessionFile: String
    var title: String
    var folder: String?
    var state: String
    var activeAgo: String?
    var open: BoardAction
    var track: BoardAction
    var dismiss: BoardAction
    /// Nil from a relay too old to close sessions.
    var close: BoardAction?

    var id: String { sessionFile }
}

/// What a control acts on: a PR card, a task card, or an open session no task knows about.
enum ActionTarget: Hashable, Sendable {
    case pr(String)
    case task(Int)
    case session(String)

    var key: String {
        switch self {
        case .pr(let ref): "pr \(ref)"
        case .task(let id): "task \(id)"
        case .session(let file): "session \(file)"
        }
    }
}

/// A task as the New Task sheet sends it.
struct NewTask: Encodable, Sendable {
    var title: String
    var details: String
    /// Screenshots pasted into its details; the server saves them and lists their paths in its details.
    var images: [Image]
    var project: String
    var folder: String
    var approvePlan: Bool
    /// Start a session on it now, rather than keeping it as an idea.
    var start: Bool

    struct Image: Encodable, Sendable {
        var base64: String
        var mimeType: String
    }
}

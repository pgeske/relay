import Foundation

// Your tasks as relay's server shapes them for this app, in `GET /api/board`'s `tasks`, typed in
// src/board/taskBoard.ts. As with PRs, the server decides what each card says and offers.

struct TaskBoard: Decodable, Sendable {
    /// Left to right in the order work moves, from Ideas to Shipped.
    var columns: [TaskColumn]
    /// Open sessions no task knows about.
    var untracked: [UntrackedSession]
    var projects: [Project]
    var needsYou: Int
}

struct TaskColumn: Decodable, Sendable, Identifiable {
    var id: String
    var title: String
    var hint: String
    /// Your move on top, then the agent's, then others', then what's parked.
    var cards: [TaskCard]
}

struct Project: Decodable, Sendable, Identifiable, Hashable {
    var id: Int
    var name: String
    /// From the top, like "Relay/Sidebar"; what the New Task sheet sends to put a task in it.
    var path: String
    /// The project it sits in; nil for a top-level one.
    var parentId: Int?
    /// It and every project under it, whose tasks it shows.
    var ids: [Int]
    /// Its tasks not done yet, and how many of them need you, counting its subprojects'.
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
    /// Whose move it is.
    var turn: Turn
    /// The agent's latest report.
    var status: TaskStatus?
    var plan: Plan?
    /// Why its agent says it's done, once it said so.
    var finish: Finish?
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
    var path: String
}

struct TaskStatus: Decodable, Sendable, Hashable {
    var text: String
    var ago: String
    /// Relay's watcher reported it because the agent forgot.
    var auto: Bool
}

struct Turn: Decodable, Sendable, Hashable {
    /// "you", "agent", "others", "blocked", "idle", "idea", or "done".
    var id: String
    /// "Needs you", "Agent working".
    var label: String
    /// What exactly it waits on, when the label doesn't say it all.
    var reason: String?
    /// How long it's been so, like "12m".
    var since: String?

    var needsYou: Bool { id == "you" }
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

struct Finish: Decodable, Sendable, Hashable {
    /// What the agent did and how it checked.
    var text: String?
    var at: Date
    /// It waits for you to approve it or send it back.
    var awaiting: Bool
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
    /// Which session it is, to open it in Chats; nil from a relay too old to say.
    var sessionFile: String?
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
    /// Relay's watcher reported it, not the agent.
    var auto: Bool
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

/// A task as the New Task sheet sends it. It has no title: relay names it from its details.
struct NewTask: Encodable, Sendable {
    var details: String
    /// Screenshots pasted into its details; the server saves them and lists their paths in its details.
    var images: [Image]
    var project: String
    var approvePlan: Bool
    /// Start a session on it now, rather than keeping it as an idea.
    var start: Bool
    /// The model its sessions start on, as `provider/id`; nil for omp's default.
    var model: String?
    /// Their thinking level; nil for omp's default.
    var thinkingLevel: String?

    struct Image: Encodable, Sendable {
        var base64: String
        var mimeType: String
    }
}

/// The models omp can start a session on, from `GET /api/models`, and the one it starts on by default.
struct ModelChoices: Decodable, Sendable {
    var models: [ModelOption]
    var defaults: Defaults

    struct Defaults: Decodable, Sendable {
        var model: String?
        var thinkingLevel: String?
    }

    func option(_ selector: String?) -> ModelOption? {
        models.first { $0.selector == selector }
    }

    /// Providers in the order omp lists them, without repeats.
    var providers: [String] {
        var seen: Set<String> = []
        return models.map(\.provider).filter { seen.insert($0).inserted }
    }
}

struct ModelOption: Decodable, Sendable, Identifiable {
    /// `provider/id`, what `omp --model` takes.
    var selector: String
    var name: String
    var provider: String
    /// The levels `omp --thinking` takes for it; empty when it can't think.
    var thinkingLevels: [String]

    var id: String { selector }

    /// "Claude Opus 5.5" reads as "Opus 5.5" on a chip that's already about models.
    var shortName: String { name.hasPrefix("Claude ") ? String(name.dropFirst("Claude ".count)) : name }

    static func levelLabel(_ level: String) -> String {
        level == "xhigh" ? "Extra High" : level.prefix(1).uppercased() + level.dropFirst()
    }
}

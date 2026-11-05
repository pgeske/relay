import AppKit
import Observation

struct Toast: Identifiable, Equatable {
    let id = UUID()
    var message: String
    var failed: Bool
}

/// A control waiting for the user to confirm it.
struct PendingAction: Identifiable {
    let id = UUID()
    var action: BoardAction
    var target: ActionTarget
    var confirm: Confirm
}

/// The board and everything the window does with it: refreshing on a timer (sooner while an agent
/// works), running a card's controls, and what the window shows until the server's board catches up.
@MainActor @Observable
final class BoardModel {
    private(set) var board: Board?
    /// Why the latest refresh failed; `board` may still hold an older one.
    private(set) var failure: BoardError?
    private(set) var isRefreshing = false
    var toast: Toast?
    var confirming: PendingAction?
    /// The New Task sheet is up.
    var composing = false
    /// Controls on their way to the server, as "<target> <action>".
    private var sending: Set<String> = []
    /// Requests the server took on that its board doesn't show yet, by PR card ref.
    private var started: [String: BoardAction] = [:]
    /// Task controls the server took on that its board doesn't show yet, by task id: their `running` text.
    private var startedTasks: [Int: String] = [:]
    /// Cards closed or deleted since the last refresh, by target key.
    private var removed: Set<String> = []

    let client = BoardClient(server: .fromEnvironment())
    private var loop: Task<Void, Never>?
    private var refreshes = 0

    /// The lanes as the window shows them: the server's, with the requests and closes it hasn't caught up with.
    var lanes: [Lane] {
        (board?.lanes ?? []).map { lane in
            var lane = lane
            lane.cards = lane.cards.filter { !removed.contains(ActionTarget.pr($0.ref).key) }.map { card in started[card.ref].map(card.takingOn) ?? card }
            return lane
        }
    }

    /// The task sections as the window shows them, with what the server hasn't caught up with.
    var taskLanes: [TaskLane] {
        (board?.tasks?.lanes ?? []).map { lane in
            var lane = lane
            lane.cards = lane.cards.filter { !removed.contains(ActionTarget.task($0.id).key) }.map { card in
                guard let running = startedTasks[card.id] else { return card }
                var card = card
                card.running = running
                card.steps = []
                return card
            }
            lane.sessions = lane.sessions.filter { !removed.contains(ActionTarget.session($0.sessionFile).key) }
            return lane
        }
    }

    /// PR cards waiting on you, in the lanes that are.
    var prsWaitingOnYou: Int { lanes.filter(\.hot).reduce(0) { $0 + $1.cards.count } }

    /// Tasks waiting on you.
    var tasksWaitingOnYou: Int { taskLanes.filter(\.hot).reduce(0) { $0 + $1.cards.count } }

    func start() {
        if loop == nil { schedule(after: .zero) }
    }

    func refreshNow() {
        schedule(after: .zero)
    }

    func isSending(_ action: BoardAction, on target: ActionTarget) -> Bool {
        sending.contains("\(target.key) \(action.action)")
    }

    func isSending(_ action: BoardAction, on card: Card) -> Bool {
        isSending(action, on: .pr(card.ref))
    }

    /// Runs a control, asking first when it changes something.
    func request(_ action: BoardAction, on target: ActionTarget) {
        if let confirm = action.confirm {
            confirming = PendingAction(action: action, target: target, confirm: confirm)
        } else {
            Task { await run(action, on: target) }
        }
    }

    func request(_ action: BoardAction, on card: Card) {
        request(action, on: .pr(card.ref))
    }

    func confirm(_ pending: PendingAction) {
        confirming = nil
        Task { await run(pending.action, on: pending.target) }
    }

    /// Sends the New Task sheet's task; true once the server took it.
    func create(_ task: NewTask) async -> Bool {
        let key = "new-task"
        guard !sending.contains(key) else { return false }
        sending.insert(key)
        defer { sending.remove(key) }
        do {
            let result = try await client.create(task)
            toast = Toast(message: result.message, failed: !result.ok)
            if result.ok { schedule(after: .milliseconds(300)) }
            return result.ok
        } catch {
            report(error)
            return false
        }
    }

    var isCreating: Bool { sending.contains("new-task") }

    /// Refreshes every `refreshSeconds` the server asks for, holding off while a control is being
    /// confirmed or sent, so the card it's on stays put.
    private func schedule(after delay: Duration) {
        loop?.cancel()
        loop = Task { [weak self] in
            var wait = delay
            while true {
                do { try await Task.sleep(for: wait) } catch { return }
                guard let self else { return }
                if confirming != nil || !sending.isEmpty {
                    wait = .milliseconds(500)
                    continue
                }
                await refresh()
                if Task.isCancelled { return }
                wait = nextRefresh
            }
        }
    }

    private var nextRefresh: Duration {
        switch failure {
        case .serverNotRunning?: .seconds(5)
        case .some: .seconds(15)
        case nil: .seconds(board?.refreshSeconds ?? 60)
        }
    }

    private func refresh() async {
        refreshes += 1
        let current = refreshes
        isRefreshing = true
        defer { if current == refreshes { isRefreshing = false } }
        do {
            board = try await client.board()
            failure = nil
            started = [:]
            startedTasks = [:]
            removed = []
        } catch let error as BoardError {
            failure = error
        } catch {
            // A newer refresh replaced this one.
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
            failure = .server(status: 0, message: error.localizedDescription)
        }
        let waiting = prsWaitingOnYou + tasksWaitingOnYou
        NSApp.dockTile.badgeLabel = waiting > 0 ? "\(waiting)" : nil
    }

    private func run(_ action: BoardAction, on target: ActionTarget) async {
        let key = "\(target.key) \(action.action)"
        guard !sending.contains(key) else { return }
        sending.insert(key)
        defer { sending.remove(key) }
        do {
            // Approving names the plan on screen; refreshes hold off while a control is confirmed or sent, so it's the one you read.
            var plan: String?
            if action.action == "approve-plan", case .task(let id) = target {
                plan = taskLanes.lazy.flatMap(\.cards).first { $0.id == id }?.plan?.revision
            }
            let result = try await client.perform(action.action, on: target, plan: plan)
            toast = Toast(message: result.message, failed: !result.ok)
            if result.ok, let running = action.running {
                switch target {
                case .pr(let ref): started[ref] = action
                case .task(let id): startedTasks[id] = running
                case .session: break
                }
            }
            if result.ok, ["close", "delete", "dismiss", "close-session"].contains(action.action) { removed.insert(target.key) }
            // The session took a step on, a menu control moved the card (skipping its agent review), or the
            // card was out of date (the PR merged, or its session is already on a request): show what's true now.
            // Task controls change the task's section, so they show soon too.
            let isTask = if case .pr = target { false } else { true }
            let movedCard = result.ok && ["skip-review", "require-review"].contains(action.action)
            if (result.ok && (action.running != nil || isTask)) || movedCard || result.status == 409 { schedule(after: .milliseconds(1200)) }
        } catch {
            report(error)
        }
    }

    private func report(_ error: any Error) {
        switch error {
        case BoardError.serverNotRunning: toast = Toast(message: "Couldn't reach relay's server", failed: true)
        case BoardError.noToken(let path): toast = Toast(message: "Couldn't read relay's token at \(path)", failed: true)
        default: toast = Toast(message: error.localizedDescription, failed: true)
        }
    }
}

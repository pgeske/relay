import AppKit
import Observation

struct Toast: Identifiable, Equatable {
    let id = UUID()
    var message: String
    var failed: Bool
    /// Its icon when it went well; a checkmark unless something deserves its own.
    var symbol = "checkmark.circle.fill"
}

/// A task just shipped, celebrated with a chime and confetti; each shipment starts a new burst.
struct Shipment: Identifiable, Equatable {
    let id = UUID()
}

/// A control waiting for the user to confirm it.
struct PendingAction: Identifiable {
    let id = UUID()
    var action: BoardAction
    var target: ActionTarget
    var confirm: Confirm
}

/// The board and everything the window does with it: streaming live updates from relay's server
/// (falling back to a timer on older servers), running a card's controls, and what the window shows
/// until the server's board catches up.
@MainActor @Observable
final class BoardModel {
    private(set) var board: Board?
    /// Why the latest refresh failed; `board` may still hold an older one.
    private(set) var failure: BoardError?
    private(set) var isRefreshing = false
    /// True while connected to the server's live SSE stream.
    private(set) var isLive = false
    var toast: Toast?
    /// The task just shipped, while its confetti falls.
    var shipment: Shipment?
    var confirming: PendingAction? {
        didSet {
            if confirming == nil { flushPendingBoard() }
        }
    }
    /// The New Task sheet is up.
    var composing = false
    var editingDependencies: TaskCard?
    private(set) var modelChoices: ModelChoices?
    /// Controls on their way to the server, as "<target> <action>".
    private var sending: Set<String> = []
    /// Requests the server took on that its board doesn't show yet, by PR card ref.
    private var started: [String: BoardAction] = [:]
    /// Task controls the server took on that its board doesn't show yet, by task id: their `running` text.
    private var startedTasks: [Int: String] = [:]
    /// Cards closed or deleted since the last refresh, by target key.
    private var removed: Set<String> = []

    let client = BoardClient(server: .fromEnvironment())
    /// The sidebar's pick: which view the window shows.
    var section: SidebarItem? = .overview
    private var streamLoop: Task<Void, Never>?
    private var pollLoop: Task<Void, Never>?
    private var pendingBoard: Board?
    private var streamRetrySeconds = 1
    private var refreshes = 0
    func showTasks() {
        section = .tasks
    }

    /// The lanes as the window shows them: the server's, with the requests and closes it hasn't caught up with.
    var lanes: [Lane] {
        (board?.lanes ?? []).map { lane in
            var lane = lane
            lane.cards = lane.cards.filter { !removed.contains(ActionTarget.pr($0.ref).key) }.map { card in started[card.ref].map(card.takingOn) ?? card }
            return lane
        }
    }

    /// The task columns as the window shows them, with what the server hasn't caught up with.
    var taskColumns: [TaskColumn] {
        (board?.tasks?.columns ?? []).map { column in
            var column = column
            column.cards = column.cards.filter { !removed.contains(ActionTarget.task($0.id).key) }.map { card in
                guard let running = startedTasks[card.id] else { return card }
                var card = card
                card.running = running
                card.steps = []
                return card
            }
            return column
        }
    }

    /// Open sessions no task knows about, without the ones the window just closed or dismissed.
    var untrackedSessions: [UntrackedSession] {
        (board?.tasks?.untracked ?? []).filter { !removed.contains(ActionTarget.session($0.sessionFile).key) }
    }

    /// PR cards waiting on you, in the lanes that are.
    var prsWaitingOnYou: Int { lanes.filter(\.hot).reduce(0) { $0 + $1.cards.count } }

    /// Tasks waiting on you.
    var tasksWaitingOnYou: Int { taskColumns.reduce(0) { $0 + $1.cards.count { $0.turn.needsYou } } }

    /// Every task card the window shows, by id, for the overview's rows.
    var taskCards: [Int: TaskCard] {
        Dictionary(taskColumns.lazy.flatMap(\.cards).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// Where tasks stood when you last looked away from the board; nil until you first do.
    private(set) var lastLook: LastLook? = LastLook.saved
    private var lookingSince: Date?

    /// The tasks that moved since you last looked, what needs you first.
    var changesSinceLastLook: [TaskChange] { lastLook?.changes(in: taskColumns) ?? [] }

    /// The window came to the front: fetch fresh local state right away and make sure live streaming is up.
    func startedLooking() {
        lookingSince = .now
        if isLive {
            Task { await refreshLocal() }
        } else if pollLoop != nil {
            schedulePoll(after: .zero)
        } else {
            startStream()
        }
    }

    /// The window went to the back. Only a look of a few seconds counts, so a glance at the board
    /// doesn't clear what's new before you read it.
    func stoppedLooking() {
        defer { lookingSince = nil }
        guard let lookingSince, Date.now.timeIntervalSince(lookingSince) >= 3 else { return }
        markSeen()
    }

    /// Takes the board as it is now as seen.
    func markSeen() {
        guard board?.tasks != nil else { return }
        let look = LastLook(at: .now, columns: taskColumns)
        lastLook = look
        look.save()
    }

    func start() {
        if streamLoop == nil && pollLoop == nil { startStream() }
    }

    /// Forces a full refresh, including GitHub PR data.
    func refreshNow() {
        Task { await refresh(localOnly: false) }
        if !isLive && pollLoop == nil && streamLoop == nil { startStream() }
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
            if result.ok && !isLive { schedulePoll(after: .milliseconds(300)) }
            return result.ok
        } catch {
            report(error)
            return false
        }
    }

    var isCreating: Bool { sending.contains("new-task") }

    /// Makes, renames, or deletes a project from the sidebar, or moves a task into one; true once the server did it.
    func project(_ action: String, project: Int? = nil, name: String? = nil, parent: Int? = nil, task: Int? = nil) async -> Bool {
        do {
            let result = try await client.project(action, project: project, name: name, parent: parent, task: task)
            toast = Toast(message: result.message, failed: !result.ok)
            if result.ok && !isLive { schedulePoll(after: .zero) }
            return result.ok
        } catch {
            report(error)
            return false
        }
    }

    func changeDependency(on task: Int, prerequisite: Int, adding: Bool) async -> Bool {
        do {
            let action = adding ? "add-dependency" : "remove-dependency"
            let result = try await client.perform(action, on: .task(task), prerequisite: prerequisite)
            toast = Toast(message: result.message, failed: !result.ok)
            if result.ok && !isLive { refreshNow() }
            return result.ok
        } catch {
            report(error)
            return false
        }
    }

    /// Asks omp which models it has, once: the list only changes when you add a provider.
    func loadModelChoices() async {
        guard modelChoices == nil else { return }
        modelChoices = try? await client.models()
    }

    /// Connects to the server's live SSE stream, reconnecting automatically on drops and falling back
    /// to polling if talking to an older relay without `/api/board/events`.
    private func startStream() {
        pollLoop?.cancel()
        pollLoop = nil
        streamLoop?.cancel()
        streamRetrySeconds = 1
        streamLoop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    try await client.streamBoards { [weak self] incoming in
                        await MainActor.run {
                            guard let self else { return }
                            self.isLive = true
                            self.streamRetrySeconds = 1
                            self.failure = nil
                            self.receive(incoming)
                        }
                    }
                    // Clean EOF or timeout: reconnect quickly.
                    if Task.isCancelled { return }
                    isLive = false
                    streamRetrySeconds = 1
                } catch BoardError.serverTooOld {
                    // Older server with no SSE endpoint: fall back to polling.
                    isLive = false
                    streamLoop = nil
                    schedulePoll(after: .zero)
                    return
                } catch let error as BoardError {
                    isLive = false
                    failure = error
                    streamRetrySeconds = error == .serverNotRunning ? min(streamRetrySeconds * 2, 5) : 15
                } catch {
                    if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
                    isLive = false
                    failure = .server(status: 0, message: error.localizedDescription)
                    streamRetrySeconds = min(streamRetrySeconds * 2, 5)
                }
                do { try await Task.sleep(for: .seconds(streamRetrySeconds)) } catch { return }
            }
        }
    }

    /// Fallback timer for older servers without live streaming, holding off while a control is being confirmed or sent.
    private func schedulePoll(after delay: Duration) {
        pollLoop?.cancel()
        pollLoop = Task { [weak self] in
            var wait = delay
            while true {
                do { try await Task.sleep(for: wait) } catch { return }
                guard let self else { return }
                if confirming != nil || !sending.isEmpty {
                    wait = .milliseconds(500)
                    continue
                }
                await refresh(localOnly: false)
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

    private func receive(_ incoming: Board) {
        if confirming != nil {
            pendingBoard = incoming
            return
        }
        apply(incoming)
    }

    private func flushPendingBoard() {
        guard confirming == nil, let pending = pendingBoard else { return }
        pendingBoard = nil
        apply(pending)
    }

    private func apply(_ incoming: Board) {
        board = incoming
        failure = nil
        started = [:]
        startedTasks = [:]
        removed = []
        let waiting = prsWaitingOnYou + tasksWaitingOnYou
        NSApp.dockTile.badgeLabel = waiting > 0 ? "\(waiting)" : nil
    }

    /// Quick local-only refresh on window focus so state is current even right after sleep/wake.
    private func refreshLocal() async {
        guard confirming == nil else { return }
        if let fresh = try? await client.board(localOnly: true) {
            receive(fresh)
        }
    }

    private func refresh(localOnly: Bool) async {
        refreshes += 1
        let current = refreshes
        isRefreshing = true
        defer { if current == refreshes { isRefreshing = false } }
        do {
            let fresh = try await client.board(localOnly: localOnly)
            receive(fresh)
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
                plan = taskColumns.lazy.flatMap(\.cards).first { $0.id == id }?.plan?.revision
            }
            let result = try await client.perform(action.action, on: target, plan: plan)
            toast = Toast(message: result.message, failed: !result.ok)
            if result.ok, ["ship", "done"].contains(action.action), case .task = target {
                celebrate()
            }
            if result.ok, let running = action.running {
                switch target {
                case .pr(let ref): started[ref] = action
                case .task(let id): startedTasks[id] = running
                case .session: break
                }
            }
            if result.ok, ["close", "delete", "dismiss", "close-session", "ship", "done"].contains(action.action) { removed.insert(target.key) }
            // The session took a step on, a menu control moved the card (skipping its agent review) or
            // refreshed it, or the card was out of date (the PR merged, or its session is already on a
            // request): show what's true now. Task controls change whose move it is, or the task's column,
            // so they show soon too.
            if !isLive {
                let isTask = if case .pr = target { false } else { true }
                let movedCard = result.ok && ["skip-review", "require-review", "refresh"].contains(action.action)
                if (result.ok && (action.running != nil || isTask)) || movedCard || result.status == 409 { schedulePoll(after: .milliseconds(400)) }
            }
        } catch {
            report(error)
        }
    }

    /// Shipping is the last click of a task: make it feel like one. The card leaves at once (the
    /// next refresh shows it under Shipped), with a chime and confetti.
    private func celebrate() {
        toast?.symbol = "paperplane.fill"
        shipment = Shipment()
        NSSound(named: "Hero")?.play()
    }

    private func report(_ error: any Error) {
        switch error {
        case BoardError.serverNotRunning: toast = Toast(message: "Couldn't reach relay's server", failed: true)
        case BoardError.noToken(let path): toast = Toast(message: "Couldn't read relay's token at \(path)", failed: true)
        default: toast = Toast(message: error.localizedDescription, failed: true)
        }
    }
}

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
    var card: Card
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
    /// Controls on their way to the server, as "<ref> <action>".
    private var sending: Set<String> = []
    /// Requests the server took on that its board doesn't show yet: card ref → what the card says meanwhile.
    private var started: [String: String] = [:]
    /// Cards closed since the last refresh.
    private var closed: Set<String> = []

    let client = BoardClient(server: .fromEnvironment())
    private var loop: Task<Void, Never>?
    private var refreshes = 0

    /// The lanes as the window shows them: the server's, with the requests and closes it hasn't caught up with.
    var lanes: [Lane] {
        (board?.lanes ?? []).map { lane in
            var lane = lane
            lane.cards = lane.cards.filter { !closed.contains($0.ref) }.map { card in started[card.ref].map(card.takingOn) ?? card }
            return lane
        }
    }

    /// Cards waiting on you, in the lanes that are.
    var waitingOnYou: Int { lanes.filter(\.hot).reduce(0) { $0 + $1.cards.count } }

    func start() {
        if loop == nil { schedule(after: .zero) }
    }

    func refreshNow() {
        schedule(after: .zero)
    }

    func isSending(_ action: BoardAction, on card: Card) -> Bool {
        sending.contains("\(card.ref) \(action.action)")
    }

    /// Runs a control, asking first when it changes something.
    func request(_ action: BoardAction, on card: Card) {
        if let confirm = action.confirm {
            confirming = PendingAction(action: action, card: card, confirm: confirm)
        } else {
            Task { await run(action, on: card) }
        }
    }

    func confirm(_ pending: PendingAction) {
        confirming = nil
        Task { await run(pending.action, on: pending.card) }
    }

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
            closed = []
        } catch let error as BoardError {
            failure = error
        } catch {
            // A newer refresh replaced this one.
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
            failure = .server(status: 0, message: error.localizedDescription)
        }
        NSApp.dockTile.badgeLabel = waitingOnYou > 0 ? "\(waitingOnYou)" : nil
    }

    private func run(_ action: BoardAction, on card: Card) async {
        let key = "\(card.ref) \(action.action)"
        guard !sending.contains(key) else { return }
        sending.insert(key)
        defer { sending.remove(key) }
        do {
            let result = try await client.perform(action.action, on: card.ref)
            toast = Toast(message: result.message, failed: !result.ok)
            if result.ok, let running = action.running { started[card.ref] = running }
            if result.ok, action.action == "close" { closed.insert(card.ref) }
            // The session took a step on, or the card was out of date (the PR merged, or its session is
            // already on a request): show what's true now.
            if (result.ok && action.running != nil) || result.status == 409 { schedule(after: .milliseconds(1200)) }
        } catch BoardError.serverNotRunning {
            toast = Toast(message: "Couldn't reach relay's server", failed: true)
        } catch BoardError.noToken(let path) {
            toast = Toast(message: "Couldn't read relay's token at \(path)", failed: true)
        } catch {
            toast = Toast(message: error.localizedDescription, failed: true)
        }
    }
}

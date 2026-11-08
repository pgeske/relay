import AppKit
import Observation

/// Which page the Chats view shows: a conversation, or a new one waiting for its first message.
enum ChatSelection: Hashable {
    case new
    case chat(String)
}

/// The Chats view's list of conversations and the one it shows. The list refreshes every few
/// seconds while the view is on screen; the conversation follows its session as it happens.
@MainActor @Observable
final class ChatsModel {
    private(set) var chats: [Chat] = []
    /// Why the latest refresh failed; `chats` may still hold an older list.
    private(set) var failure: BoardError?
    private(set) var loaded = false
    var search = ""
    private(set) var selection: ChatSelection = .new
    /// The conversation on screen, while a chat is selected.
    private(set) var conversation: Conversation?
    private(set) var isStarting = false
    /// Set by `requestToast` for the window's toast, so chat controls report like the board's.
    var onToast: (Toast) -> Void = { _ in }

    let client: BoardClient
    private var loop: Task<Void, Never>?

    init(client: BoardClient) {
        self.client = client
    }

    // MARK: The list

    /// The chats matching the search box, as the list shows them.
    var shownChats: [Chat] {
        let query = search.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return chats }
        return chats.filter { chat in
            [chat.title, chat.folder ?? "", chat.task?.ref ?? "", chat.task?.title ?? ""].contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }

    var selectedChat: Chat? {
        guard case .chat(let file) = selection else { return nil }
        return chats.first { $0.sessionFile == file }
    }

    /// The Chats view is on screen: the list refreshes every few seconds then, and every half
    /// minute otherwise, for the sidebar's count of working chats.
    var isVisible = false {
        didSet { if isVisible != oldValue { startRefreshing() } }
    }

    /// Starts (or restarts, refreshing at once) the list's refresh loop.
    func startRefreshing() {
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                let visible = self?.isVisible ?? false
                try? await Task.sleep(for: .seconds(visible ? 3 : 30))
            }
        }
    }

    func refresh() async {
        do {
            chats = try await client.chats()
            failure = nil
        } catch let error as BoardError {
            failure = error
        } catch {
            if Task.isCancelled { return }
            failure = .server(status: 0, message: error.localizedDescription)
        }
        loaded = true
        if let conversation, let chat = selectedChat { conversation.follow(chat) }
    }

    // MARK: Picking a chat

    func select(_ selection: ChatSelection) {
        guard selection != self.selection || (conversation == nil && selection != .new) else { return }
        self.selection = selection
        conversation?.close()
        conversation = nil
        if case .chat(let file) = selection {
            let conversation = Conversation(sessionFile: file, paneId: chats.first { $0.sessionFile == file }?.paneId, client: client, toast: { [weak self] in self?.onToast($0) })
            self.conversation = conversation
            conversation.open()
        }
    }

    /// Starts a chat with its first message and shows it; false (keeping what you typed) when it couldn't.
    func startChat(_ chat: NewChat) async -> Bool {
        guard !isStarting else { return false }
        isStarting = true
        defer { isStarting = false }
        do {
            let (started, result) = try await client.startChat(chat)
            guard let started else {
                onToast(Toast(message: result.message, failed: true))
                return false
            }
            // Listed at once, titled by its first line, until the next refresh brings the server's.
            if !chats.contains(where: { $0.sessionFile == started.sessionFile }) {
                let title = String(chat.text.split(separator: "\n").first?.prefix(60) ?? "New chat")
                chats.insert(Chat(sessionFile: started.sessionFile, title: title, folder: "/tmp", state: .working, paneId: started.paneId, updatedAt: .now, task: nil), at: 0)
            }
            select(.chat(started.sessionFile))
            conversation?.showSent(chat.text, imageCount: chat.images.count)
            return true
        } catch {
            onToast(Toast(error))
            return false
        }
    }

    // MARK: A chat's controls

    func link(_ chat: Chat, to task: TaskCard) async {
        await report { try await client.link(chat.sessionFile, toTask: task.id) }
    }

    func openInTerminal(_ chat: Chat) async {
        await report { try await client.openInTerminal(chat.sessionFile) }
    }

    /// Runs a control and shows how it went, then refreshes the list, which it may have changed.
    private func report(_ control: () async throws -> ActionResult) async {
        do {
            let result = try await control()
            onToast(Toast(message: result.message, failed: !result.ok))
        } catch {
            onToast(Toast(error))
        }
        await refresh()
    }
}

extension Toast {
    init(_ error: any Error) {
        switch error {
        case BoardError.serverNotRunning: self.init(message: "Couldn't reach relay's server", failed: true)
        case BoardError.noToken(let path): self.init(message: "Couldn't read relay's token at \(path)", failed: true)
        case BoardError.server(_, let message): self.init(message: message, failed: true)
        default: self.init(message: error.localizedDescription, failed: true)
        }
    }
}

/// A message you sent that the conversation doesn't show yet: shown at once, until the real one arrives.
struct PendingMessage: Identifiable, Equatable {
    let id = "pending-\(UUID().uuidString)"
    let text: String
    let imageCount: Int
}

/// One conversation as it happens: its messages, page by page, and while its session is open, the
/// live stream of what it says and does. Typing into a closed one reopens it and starts following it.
@MainActor @Observable
final class Conversation {
    let sessionFile: String
    private(set) var paneId: String?
    private(set) var messages: [ChatMessage] = []
    private(set) var pending: [PendingMessage] = []
    private(set) var hasMore = false
    private(set) var isLoading = false
    private(set) var isLoadingOlder = false
    private(set) var isSending = false
    /// The open session's state from its live stream; nil while it's closed.
    private(set) var status: PaneStatus?
    /// Your latest model or thinking pick, shown until omp reports it so the chip doesn't flick back.
    private(set) var modelOverride: String?
    private(set) var levelOverride: String?
    /// A live-mode switch on its way, so the button can't be pressed twice.
    private(set) var isSwitchingLive = false

    private let client: BoardClient
    private let toast: (Toast) -> Void
    private var seen: Set<String> = []
    private var stream: Task<Void, Never>?
    /// From sending until omp reports it's working, so "Working" shows at once.
    private var awaitingReply = false
    private var awaitingTimeout: Task<Void, Never>?

    init(sessionFile: String, paneId: String?, client: BoardClient, toast: @escaping (Toast) -> Void) {
        self.sessionFile = sessionFile
        self.paneId = paneId
        self.client = client
        self.toast = toast
    }

    var isOpen: Bool { paneId != nil }
    var working: Bool { status?.working == true || awaitingReply }
    var livePhase: String? { status?.livePhase }
    var model: String? { modelOverride ?? status?.model }
    var thinkingLevel: String? { levelOverride ?? status?.thinkingLevel }

    /// Tool results by the call they answer.
    var results: [String: ChatBlock.ToolResult] {
        var results: [String: ChatBlock.ToolResult] = [:]
        for message in messages where message.role == .tool {
            for result in message.toolResults where !result.toolCallId.isEmpty { results[result.toolCallId] = result }
        }
        return results
    }

    /// The agent's latest `ask` call while omp still waits for its answer.
    var pendingAsk: ChatBlock.ToolCall? {
        guard isOpen else { return nil }
        let results = results
        for message in messages.reversed() {
            for block in message.blocks.reversed() {
                guard case .toolCall(let call) = block, call.ask != nil else { continue }
                return results[call.id] == nil ? call : nil
            }
        }
        return nil
    }

    func open() {
        Task { await loadLatest() }
        followPane()
    }

    func close() {
        stream?.cancel()
        stream = nil
    }

    /// Catches up with the list: a chat that opened or closed elsewhere (your terminal, the phone).
    func follow(_ chat: Chat) {
        guard chat.paneId != paneId, !isSending else { return }
        paneId = chat.paneId
        if paneId == nil { status = nil }
        followPane()
        Task { await loadLatest() }
    }

    // MARK: Loading

    private func loadLatest() async {
        isLoading = messages.isEmpty
        defer { isLoading = false }
        do {
            let page = try await client.messages(of: sessionFile)
            let before = seen
            messages = page.messages
            seen = Set(page.messages.map(\.id))
            hasMore = page.hasMore
            for message in page.messages where !before.contains(message.id) { retirePending(matching: message) }
        } catch {
            if !Task.isCancelled { toast(Toast(error)) }
        }
    }

    func loadOlder() async {
        guard hasMore, !isLoadingOlder, let oldest = messages.first else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        do {
            let page = try await client.messages(of: sessionFile, before: oldest.id)
            let older = page.messages.filter { seen.insert($0.id).inserted }
            messages.insert(contentsOf: older, at: 0)
            hasMore = page.hasMore
        } catch {
            toast(Toast(error))
        }
    }

    // MARK: Following the open session

    private func followPane() {
        stream?.cancel()
        stream = nil
        guard let paneId else { return }
        stream = Task { [weak self, client] in
            var delay = Duration.seconds(1)
            while !Task.isCancelled {
                do {
                    for try await event in client.events(of: paneId) {
                        guard let self, !Task.isCancelled else { return }
                        delay = .seconds(1)
                        if await self.handle(event) { return }
                    }
                } catch {
                    // The server restarted or the connection dropped: try again shortly.
                }
                try? await Task.sleep(for: delay)
                delay = min(delay * 2, .seconds(10))
            }
        }
    }

    /// Applies one event; true once the session closed and there's nothing more to follow.
    private func handle(_ event: ChatEvent) async -> Bool {
        switch event {
        case .message(let message):
            retirePending(matching: message)
            if message.role == .assistant { setAwaitingReply(false) }
            if seen.insert(message.id).inserted { messages.append(message) }
        case .status(let status):
            self.status = status
            if status.working { setAwaitingReply(false) }
            if modelOverride == status.model { modelOverride = nil }
            if levelOverride == status.thinkingLevel { levelOverride = nil }
        case .reset:
            messages = []
            seen = []
            await loadLatest()
        case .closed:
            paneId = nil
            status = nil
            setAwaitingReply(false)
            return true
        }
        return false
    }

    // MARK: Talking to it

    /// Shows the first message of a chat just started, until omp writes it down.
    func showSent(_ text: String, imageCount: Int) {
        pending.append(PendingMessage(text: text.trimmingCharacters(in: .whitespacesAndNewlines), imageCount: imageCount))
        setAwaitingReply(true)
    }

    /// Sends a message, showing it at once; false (keeping what you typed) when it couldn't.
    func send(_ text: String, images: [NewTask.Image]) async -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !images.isEmpty, !isSending else { return false }
        let bubble = PendingMessage(text: text, imageCount: images.count)
        pending.append(bubble)
        setAwaitingReply(true)
        isSending = true
        defer { isSending = false }
        do {
            let (pane, result) = try await client.sendMessage(text, images: images, to: sessionFile)
            guard result.ok else {
                pending.removeAll { $0.id == bubble.id }
                setAwaitingReply(false)
                toast(Toast(message: result.message, failed: true))
                return false
            }
            // A closed chat reopened in a new tab: follow that one.
            if let pane, pane != paneId {
                paneId = pane
                followPane()
                toast(Toast(message: result.message, failed: false))
            }
            return true
        } catch {
            pending.removeAll { $0.id == bubble.id }
            setAwaitingReply(false)
            toast(Toast(error))
            return false
        }
    }

    /// Stops what the agent is doing, like pressing Esc in its terminal.
    func stop() async {
        guard let paneId else { return }
        await run { try await client.press(["Escape"], in: paneId) }
        setAwaitingReply(false)
    }

    func answer(_ call: ChatBlock.ToolCall, with answers: [AskAnswer]) async -> Bool {
        guard let paneId else { return false }
        return await run { try await client.answer(call.id, with: answers, in: paneId) }
    }

    func switchModel(_ model: String) async {
        guard let paneId else { return }
        modelOverride = model
        if await !run({ try await client.switchModel(model, thinkingLevel: nil, in: paneId) }) { modelOverride = nil }
    }

    func switchThinking(_ level: String) async {
        guard let paneId else { return }
        levelOverride = level
        if await !run({ try await client.switchModel(nil, thinkingLevel: level, in: paneId) }) { levelOverride = nil }
    }

    /// Turns omp's live voice mode on or off: it listens on this Mac's microphone and answers out loud.
    func setLive(_ on: Bool) async {
        guard !isSwitchingLive else { return }
        isSwitchingLive = true
        defer { isSwitchingLive = false }
        do {
            let result = try await client.setLive(on, in: sessionFile)
            if !result.ok { toast(Toast(message: result.message, failed: true)) }
        } catch {
            toast(Toast(error))
        }
    }

    /// Mutes or unmutes live mode, with the key omp's live panel takes for it.
    func toggleMute() async {
        guard let paneId else { return }
        await run { try await client.press(["Space"], in: paneId) }
    }

    /// Runs a control on the open session, saying so only when it failed. True when it went through.
    @discardableResult
    private func run(_ control: () async throws -> ActionResult) async -> Bool {
        do {
            let result = try await control()
            if !result.ok { toast(Toast(message: result.message, failed: true)) }
            return result.ok
        } catch {
            toast(Toast(error))
            return false
        }
    }

    /// omp normally reports "working" within a second; this only keeps the indicator from sticking.
    private func setAwaitingReply(_ awaiting: Bool) {
        awaitingReply = awaiting
        awaitingTimeout?.cancel()
        awaitingTimeout = nil
        guard awaiting else { return }
        awaitingTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled else { return }
            self?.awaitingReply = false
        }
    }

    /// Retires the bubble of a message you sent once omp wrote it down. The server adds one
    /// "[Attached image: …]" line per screenshot, so the real text may run on past what you typed.
    private func retirePending(matching message: ChatMessage) {
        guard message.role == .user else { return }
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let index = pending.firstIndex { bubble in
            bubble.text.isEmpty ? bubble.imageCount > 0 && text.contains("[Attached image:") : text == bubble.text || text.hasPrefix(bubble.text + "\n")
        }
        if let index { pending.remove(at: index) }
    }
}

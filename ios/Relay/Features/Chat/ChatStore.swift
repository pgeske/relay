import Foundation
import Observation

enum ConnectionState: Equatable, Sendable {
    case connecting
    case connected
    case reconnecting
    case disconnected

    var label: String {
        switch self {
        case .connecting: "Connecting"
        case .connected: "Live"
        case .reconnecting: "Reconnecting"
        case .disconnected: "Offline"
        }
    }
}

struct PendingMessage: Identifiable, Equatable, Sendable {
    let id: String
    let text: String
    let imageCount: Int
}

/// A row in the message list: either a server message or an optimistic bubble.
struct ChatItem: Identifiable {
    enum Kind {
        case message(Message)
        case pending(PendingMessage)
    }

    let id: String
    let kind: Kind
}

/// Owns one session's message history and its live SSE stream.
@MainActor
@Observable
final class ChatStore {
    let sessionID: String
    private(set) var info: Session
    private(set) var messages: [Message] = []
    private(set) var pending: [PendingMessage] = []
    private(set) var hasMore = false
    private(set) var connection: ConnectionState = .connecting
    private(set) var isLoadingInitial = false
    private(set) var isLoadingOlder = false
    private(set) var models: [ModelOption] = []
    var errorMessage: String?

    /// The phone's latest pick, shown until omp reports it so the chip doesn't flick back.
    private var modelOverride: String?
    private var thinkingOverride: String?

    private let api: APIClient
    private var streamTask: Task<Void, Never>?
    private var seenIDs: Set<String> = []
    private var sessionFile: String?
    private var hasLoaded = false
    private var retryDelay: Duration = .seconds(1)

    init(session: Session, api: APIClient) {
        self.sessionID = session.id
        self.info = session
        self.api = api
    }

    var working: Bool {
        info.status == .working
    }

    var currentModel: String? {
        modelOverride ?? info.model
    }

    var currentThinkingLevel: String? {
        thinkingOverride ?? info.thinkingLevel
    }

    var currentModelOption: ModelOption? {
        models.first { $0.selector == currentModel }
    }

    // MARK: - Items

    var items: [ChatItem] {
        var result = renderedMessages.map { ChatItem(id: $0.id, kind: .message($0)) }
        result.append(contentsOf: pending.map { ChatItem(id: $0.id, kind: .pending($0)) })
        return result
    }

    /// Tool results keyed by the tool call they belong to.
    var toolResultMap: [String: Block.ToolResult] {
        var map: [String: Block.ToolResult] = [:]
        for message in messages {
            for result in message.toolResults where !result.toolCallId.isEmpty {
                map[result.toolCallId] = result
            }
        }
        return map
    }

    var matchedToolCallIDs: Set<String> {
        Set(messages.flatMap(\.toolCallIDs))
    }

    private var renderedMessages: [Message] {
        let callIDs = matchedToolCallIDs
        return messages.filter { message in
            switch message.role {
            case .user:
                return !message.textContent.isEmpty || !message.imageURLs.isEmpty
            case .assistant:
                return message.blocks.contains { block in
                    switch block {
                    case .text(let text): return !text.isEmpty
                    case .thinking(let text): return !text.isEmpty
                    case .toolCall(let call): return !call.name.isEmpty
                    case .image(let url): return !url.isEmpty
                    case .toolResult: return false
                    case .unknown: return false
                    }
                }
            case .tool:
                // Results already attached to a tool call are rendered inside it.
                let results = message.toolResults
                return results.isEmpty || results.contains { !callIDs.contains($0.toolCallId) }
            case .unknown:
                return false
            }
        }
    }

    // MARK: - Lifecycle

    func start() async {
        if !hasLoaded {
            await loadLatest()
        }
        if streamTask == nil {
            restartStream()
        }
        if models.isEmpty {
            await loadModels()
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    /// Called when the app returns to the foreground; the socket may be dead.
    func foregrounded() {
        restartStream()
        Task { await catchUp() }
    }

    func restartStream() {
        streamTask?.cancel()
        retryDelay = .seconds(1)
        connection = .connecting
        streamTask = Task { [weak self] in
            await self?.runStream()
        }
    }

    // MARK: - Loading

    private func loadLatest() async {
        isLoadingInitial = true
        defer { isLoadingInitial = false }

        do {
            let page = try await api.fetchMessages(sessionID: sessionID, limit: 60)
            replaceHistory(with: page)
            hasLoaded = true
            errorMessage = nil
        } catch is CancellationError {
            // View went away.
        } catch {
            errorMessage = APIError.describe(error)
        }
    }

    /// Fetches anything missed while the stream was down without disturbing scroll.
    private func catchUp() async {
        guard !messages.isEmpty else {
            await loadLatest()
            return
        }
        do {
            let page = try await api.fetchMessages(sessionID: sessionID, limit: 60)

            // The pane switched to a different jsonl file while we were away.
            if let file = page.sessionFile, file != sessionFile {
                replaceHistory(with: page)
                return
            }

            for message in page.messages where !seenIDs.contains(message.id) {
                seenIDs.insert(message.id)
                messages.append(message)
                consumePending(matching: message)
            }
        } catch {
            // Keep the existing history; the stream keeps retrying.
        }
    }

    func loadOlder() async {
        guard hasMore, !isLoadingOlder, let oldest = messages.first else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }

        do {
            let page = try await api.fetchMessages(sessionID: sessionID, before: oldest.id, limit: 60)
            let newMessages = page.messages.filter { !seenIDs.contains($0.id) }
            for message in newMessages {
                seenIDs.insert(message.id)
            }
            messages.insert(contentsOf: newMessages, at: 0)
            hasMore = page.hasMore
        } catch is CancellationError {
            // View went away.
        } catch {
            errorMessage = APIError.describe(error)
        }
    }

    // MARK: - Sending

    /// Shows the user's message immediately, then posts it. Returns false when
    /// the composer should keep its contents.
    func send(text: String, images: [InputImage]) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !images.isEmpty else { return false }

        let pendingMessage = PendingMessage(
            id: "pending-\(UUID().uuidString)",
            text: trimmed,
            imageCount: images.count
        )
        pending.append(pendingMessage)

        do {
            try await api.sendInput(sessionID: sessionID, text: trimmed, images: images)
            return true
        } catch {
            pending.removeAll { $0.id == pendingMessage.id }
            errorMessage = APIError.describe(error)
            return false
        }
    }

    func sendKeys(_ keys: [String]) async {
        do {
            try await api.sendKeys(sessionID: sessionID, keys: keys)
        } catch {
            errorMessage = APIError.describe(error)
        }
    }

    func liveCallRequest() throws -> URLRequest {
        try api.liveCallRequest(sessionID: sessionID)
    }

    /// Starts a fresh conversation in this same session, like Cmd+Shift+N on the Mac.
    /// The stream sends a reset once omp switches to the new session file.
    func startNewConversation() async {
        do {
            try await api.sendInput(sessionID: sessionID, text: "/new", images: [])
        } catch {
            errorMessage = APIError.describe(error)
        }
    }

    // MARK: - Model

    private func loadModels() async {
        do {
            models = try await api.fetchModels()
        } catch {
            // The chip still shows the current model; the picker just stays empty.
        }
    }

    func selectModel(_ selector: String) async {
        modelOverride = selector
        do {
            try await api.setModel(sessionID: sessionID, model: selector, thinkingLevel: nil)
        } catch {
            modelOverride = nil
            errorMessage = APIError.describe(error)
            return
        }
        // If omp never confirms (say it rejected the model), fall back to what it reports.
        try? await Task.sleep(for: .seconds(6))
        if modelOverride == selector { modelOverride = nil }
    }

    func selectThinkingLevel(_ level: String) async {
        thinkingOverride = level
        do {
            try await api.setModel(sessionID: sessionID, model: nil, thinkingLevel: level)
        } catch {
            thinkingOverride = nil
            errorMessage = APIError.describe(error)
            return
        }
        try? await Task.sleep(for: .seconds(6))
        if thinkingOverride == level { thinkingOverride = nil }
    }

    // MARK: - Stream

    private func runStream() async {
        let sse = SSEClient(api: api)

        while !Task.isCancelled {
            if connection != .connected {
                connection = .connecting
            }

            do {
                for try await event in sse.events(sessionID: sessionID) {
                    if Task.isCancelled { return }
                    let shouldStop = await handle(event)
                    if shouldStop { return }
                }
                if Task.isCancelled { return }
                connection = .reconnecting
            } catch is CancellationError {
                return
            } catch {
                // No banner: iOS kills the socket whenever the app is backgrounded, and this
                // loop reconnects on its own. The header already shows "Reconnecting".
                if Task.isCancelled { return }
                connection = .reconnecting
            }

            do {
                try await Task.sleep(for: retryDelay)
            } catch {
                return
            }
            retryDelay = min(retryDelay * 2, .seconds(15))
        }
    }

    private func handle(_ event: SSEEvent) async -> Bool {
        switch event {
        case .message(let message):
            connection = .connected
            retryDelay = .seconds(1)
            consumePending(matching: message)
            append(message)
            return false

        case .status(let session):
            info = session
            if modelOverride == session.model { modelOverride = nil }
            if thinkingOverride == session.thinkingLevel { thinkingOverride = nil }
            connection = .connected
            retryDelay = .seconds(1)
            return false

        case .reset(let file):
            messages = []
            seenIDs = []
            hasMore = false
            hasLoaded = false
            sessionFile = file
            await loadLatest()
            return false

        case .closed:
            connection = .disconnected
            return true
        }
    }

    private func append(_ message: Message) {
        guard !seenIDs.contains(message.id) else { return }
        seenIDs.insert(message.id)
        messages.append(message)
    }

    /// Swaps in a freshly fetched page. A reload can carry the real copy of a message the
    /// stream never delivered (omp writes the first message before the server sees the new
    /// session file), so newly seen user messages still retire their optimistic bubbles.
    private func replaceHistory(with page: MessagesPage) {
        let previouslySeen = seenIDs
        messages = page.messages
        seenIDs = Set(page.messages.map(\.id))
        hasMore = page.hasMore
        sessionFile = page.sessionFile
        for message in page.messages where !previouslySeen.contains(message.id) {
            consumePending(matching: message)
        }
    }

    /// Drops the optimistic bubble once its real counterpart arrives. The
    /// server appends “[Attached image: …]” lines, so match on a prefix.
    private func consumePending(matching message: Message) {
        guard message.role == .user else { return }
        let text = message.textContent.trimmingCharacters(in: .whitespacesAndNewlines)

        let index = pending.firstIndex { pending in
            let pendingText = pending.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if pendingText.isEmpty {
                return pending.imageCount > 0 && text.contains("[Attached image:")
            }
            return text == pendingText || text.hasPrefix(pendingText + "\n")
        }

        if let index {
            pending.remove(at: index)
        }
    }
}

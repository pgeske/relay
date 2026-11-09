import AppKit
import Foundation

/// The Chats view's calls to relay's server: the board's chat endpoints, which name a conversation
/// by its session file, and, while it's open, the phone's endpoints for its relay tab's pane.
extension BoardClient {
    func chats() async throws -> [Chat] {
        struct Response: Decodable { let chats: [Chat] }
        return try decode(Response.self, from: try await send("api/board/chats"), using: Self.decoder()).chats
    }

    /// A page of a chat's conversation, ending just before `before` (or at its latest message).
    func messages(of sessionFile: String, before: String? = nil, limit: Int = 80) async throws -> ChatPage {
        var query = [URLQueryItem(name: "session", value: sessionFile), URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        return try decode(ChatPage.self, from: try await send(Self.path("api/board/chats/messages", query)), using: JSONDecoder())
    }

    /// An image a message carries, by the URL the server gave it.
    func image(at url: String) async throws -> NSImage {
        let (data, response) = try await send(String(url.drop { $0 == "/" }))
        guard response.statusCode == 200, let image = NSImage(data: data) else {
            throw BoardError.server(status: response.statusCode, message: "couldn't load the image")
        }
        return image
    }

    /// Starts a chat with its first message; nil with the server's reason when it couldn't.
    func startChat(_ chat: NewChat) async throws -> (StartedChat?, ActionResult) {
        let (data, response) = try await send("api/board/chats", method: "POST", body: try JSONEncoder().encode(chat))
        struct Response: Decodable { let chat: StartedChat? }
        let started = (200..<300).contains(response.statusCode) ? try? JSONDecoder().decode(Response.self, from: data).chat : nil
        return (started, result(data, response))
    }

    /// Types a message into a chat, reopening it first if it's closed. Returns the pane it went to.
    func sendMessage(_ text: String, images: [NewTask.Image], to sessionFile: String) async throws -> (paneId: String?, ActionResult) {
        let body = try JSONSerialization.data(withJSONObject: ["session": sessionFile, "text": text, "images": images.map { ["base64": $0.base64, "mimeType": $0.mimeType] }])
        let (data, response) = try await send("api/board/chats/actions/send", method: "POST", body: body)
        struct Response: Decodable { let paneId: String? }
        return ((try? JSONDecoder().decode(Response.self, from: data))?.paneId, result(data, response))
    }

    /// Puts a chat on a task, which tells it so when it's open.
    func link(_ sessionFile: String, toTask task: Int) async throws -> ActionResult {
        try await post("api/board/chats/actions/link", body: try JSONSerialization.data(withJSONObject: ["session": sessionFile, "task": task]))
    }

    /// Shows a chat in your terminal, reopening it there if it's closed.
    func openInTerminal(_ sessionFile: String) async throws -> ActionResult {
        try await post("api/board/chats/actions/open", body: try JSONSerialization.data(withJSONObject: ["session": sessionFile]))
    }

    // MARK: An open chat's pane

    /// Presses keys in its pane, like Escape to stop the agent.
    func press(_ keys: [String], in paneId: String) async throws -> ActionResult {
        try await post(Self.panePath(paneId, "keys"), body: try JSONSerialization.data(withJSONObject: ["keys": keys]))
    }

    /// Answers the agent's open `ask` question.
    func answer(_ toolCallId: String, with answers: [AskAnswer], in paneId: String) async throws -> ActionResult {
        struct Body: Encodable { let toolCallId: String; let answers: [AskAnswer] }
        return try await post(Self.panePath(paneId, "ask"), body: try JSONEncoder().encode(Body(toolCallId: toolCallId, answers: answers)))
    }

    /// Switches its model or thinking level, the way omp's `/switch` and `/effort` do.
    func switchModel(_ model: String?, thinkingLevel: String?, in paneId: String) async throws -> ActionResult {
        var fields: [String: String] = [:]
        if let model { fields["model"] = model }
        if let thinkingLevel { fields["thinkingLevel"] = thinkingLevel }
        return try await post(Self.panePath(paneId, "model"), body: try JSONSerialization.data(withJSONObject: fields))
    }

    /// Follows an open chat as it happens: new messages and status changes, until its tab closes.
    func events(of paneId: String) -> AsyncThrowingStream<ChatEvent, any Error> {
        let prepared = Result { try self.request(Self.panePath(paneId, "events")) }
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = try prepared.get()
                    request.timeoutInterval = .infinity
                    let (bytes, response) = try await Self.session.bytes(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                        throw BoardError.server(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "live updates are unavailable")
                    }
                    var name = "message"
                    var data: [String] = []
                    // Not `bytes.lines`: it drops the empty lines that end each event.
                    var line: [UInt8] = []
                    for try await byte in bytes {
                        guard byte == UInt8(ascii: "\n") else {
                            line.append(byte)
                            continue
                        }
                        if line.last == UInt8(ascii: "\r") { line.removeLast() }
                        let text = String(decoding: line, as: UTF8.self)
                        line.removeAll(keepingCapacity: true)
                        if text.isEmpty {
                            if let event = Self.event(name, data.joined(separator: "\n")) {
                                continuation.yield(event)
                                if case .closed = event { break }
                            }
                            name = "message"
                            data.removeAll()
                        } else if text.hasPrefix("event:") {
                            name = text.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if text.hasPrefix("data:") {
                            data.append(String(text.dropFirst(5).drop { $0 == " " }))
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func event(_ name: String, _ data: String) -> ChatEvent? {
        if name == "closed" { return .closed }
        let payload = Data(data.utf8)
        switch name {
        case "message": return (try? JSONDecoder().decode(ChatMessage.self, from: payload)).map(ChatEvent.message)
        case "status": return (try? JSONDecoder().decode(PaneStatus.self, from: payload)).map(ChatEvent.status)
        case "reset":
            struct Reset: Decodable { let sessionFile: String? }
            return .reset(sessionFile: (try? JSONDecoder().decode(Reset.self, from: payload))?.sessionFile)
        default: return nil
        }
    }

    private static func panePath(_ paneId: String, _ action: String) -> String {
        // Pane ids start with "%", which a path must escape.
        "api/sessions/\(paneId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? paneId)/\(action)"
    }

    private static func path(_ path: String, _ query: [URLQueryItem]) -> String {
        var components = URLComponents()
        components.queryItems = query
        // URLComponents leaves "+" alone, which a server reads as a space.
        return "\(path)?\(components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B") ?? "")"
    }

    private func decode<Value: Decodable>(_ type: Value.Type, from reply: (Data, HTTPURLResponse), using decoder: JSONDecoder) throws -> Value {
        let (data, response) = reply
        switch response.statusCode {
        case 200:
            do {
                return try decoder.decode(type, from: data)
            } catch {
                throw BoardError.server(status: 200, message: "relay's server sent something this app can't read")
            }
        case 401: throw BoardError.unauthorized
        case 404 where Self.message(in: data) == "not found": throw BoardError.serverTooOld
        default: throw BoardError.server(status: response.statusCode, message: Self.message(in: data) ?? "HTTP \(response.statusCode)")
        }
    }

    private func result(_ data: Data, _ response: HTTPURLResponse) -> ActionResult {
        let ok = (200..<300).contains(response.statusCode)
        return ActionResult(ok: ok, status: response.statusCode, message: Self.message(in: data) ?? (ok ? "Done" : "Something went wrong (HTTP \(response.statusCode))"))
    }
}

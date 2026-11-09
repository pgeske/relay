import Foundation

// Your omp sessions as the Chats view shows them: `GET /api/board/chats` lists them (typed in
// src/board/chats.ts), and each conversation's messages come from relay's message reader (typed in
// src/server/messages.ts), the same one the iPhone app reads.

/// A conversation in the Chats list.
struct Chat: Decodable, Sendable, Identifiable, Hashable {
    enum State: String, Decodable, Sendable {
        case working, idle, closed

        init(from decoder: any Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .closed
        }
    }

    var sessionFile: String
    var title: String
    /// The Nerd Font icon omp puts in front of the title; nil when it has none.
    var icon: String?
    var folder: String?
    var state: State
    /// Its relay tab's pane while it's open.
    var paneId: String?
    var updatedAt: Date
    var task: TaskChip?

    var id: String { sessionFile }
    var isOpen: Bool { state != .closed }
}

/// One piece of a message.
enum ChatBlock: Hashable, Sendable {
    case text(String)
    case thinking(String)
    case toolCall(ToolCall)
    case toolResult(ToolResult)
    case image(url: String)
    case unknown

    struct ToolCall: Hashable, Sendable {
        let id: String
        let name: String
        /// A one-line gist of its arguments, like the command a `bash` call runs.
        let summary: String
        let argsJson: String
        /// The questions of an `ask` call; nil for every other tool.
        let ask: [AskQuestion]?
    }

    struct AskQuestion: Hashable, Sendable, Decodable {
        struct Option: Hashable, Sendable, Decodable {
            let label: String
            let description: String?
        }

        let id: String
        let question: String
        let options: [Option]
        let multi: Bool
        let recommended: Int?
    }

    struct ToolResult: Hashable, Sendable {
        let toolCallId: String
        let name: String
        let text: String
        let truncated: Bool
        let isError: Bool
    }
}

extension ChatBlock: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type, text, id, name, summary, argsJson, toolCallId, truncated, isError, url, ask
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func string(_ key: CodingKeys) -> String { (try? container.decode(String.self, forKey: key)) ?? "" }
        switch string(.type) {
        case "text":
            self = .text(string(.text))
        case "thinking":
            self = .thinking(string(.text))
        case "toolCall":
            self = .toolCall(ToolCall(id: string(.id), name: string(.name), summary: string(.summary), argsJson: string(.argsJson), ask: try? container.decodeIfPresent([AskQuestion].self, forKey: .ask)))
        case "toolResult":
            self = .toolResult(ToolResult(
                toolCallId: string(.toolCallId),
                name: string(.name),
                text: string(.text),
                truncated: (try? container.decode(Bool.self, forKey: .truncated)) ?? false,
                isError: (try? container.decode(Bool.self, forKey: .isError)) ?? false
            ))
        case "image":
            self = .image(url: string(.url))
        default:
            self = .unknown
        }
    }
}

/// One message of a conversation: yours, the agent's, or a tool's result.
struct ChatMessage: Identifiable, Hashable, Sendable {
    enum Role: String, Sendable {
        case user, assistant, tool, unknown
    }

    let id: String
    let role: Role
    let timestamp: Date?
    let blocks: [ChatBlock]

    /// The message's text, its blocks run together.
    var text: String {
        blocks.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined(separator: "\n")
    }

    var toolResults: [ChatBlock.ToolResult] {
        blocks.compactMap { if case .toolResult(let result) = $0 { result } else { nil } }
    }

    var toolCallIDs: [String] {
        blocks.compactMap { if case .toolCall(let call) = $0, !call.id.isEmpty { call.id } else { nil } }
    }
}

extension ChatMessage: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, role, timestamp, blocks
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? container.decode(String.self, forKey: .id)) ?? UUID().uuidString
        role = Role(rawValue: (try? container.decode(String.self, forKey: .role)) ?? "") ?? .unknown
        timestamp = (try? container.decode(String.self, forKey: .timestamp)).flatMap { try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse($0) }
        // A block this app doesn't know yet is skipped rather than losing the whole message.
        blocks = ((try? container.decode([Lossy<ChatBlock>].self, forKey: .blocks)) ?? []).compactMap(\.value)
    }
}

/// Decodes what it can, and nil for the rest, so one odd entry can't hide a whole page.
struct Lossy<Value: Decodable & Sendable>: Decodable, Sendable {
    let value: Value?

    init(from decoder: any Decoder) throws {
        value = try? Value(from: decoder)
    }
}

/// A page of a conversation, oldest message first.
struct ChatPage: Decodable, Sendable {
    let messages: [ChatMessage]
    let hasMore: Bool

    private enum CodingKeys: String, CodingKey { case messages, hasMore }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messages = ((try? container.decode([Lossy<ChatMessage>].self, forKey: .messages)) ?? []).compactMap(\.value)
        hasMore = (try? container.decode(Bool.self, forKey: .hasMore)) ?? false
    }
}

/// An open session's state, as its live stream reports it.
struct PaneStatus: Decodable, Sendable, Equatable {
    let status: String
    let title: String
    let sessionFile: String?
    /// Active `provider/id`, or nil when the server can't tell.
    let model: String?
    let thinkingLevel: String?

    var working: Bool { status == "working" }
}

/// What an open session's live stream says.
enum ChatEvent: Sendable {
    case message(ChatMessage)
    case status(PaneStatus)
    /// The session switched conversations (omp's /new) or rewrote its file: read it again.
    case reset(sessionFile: String?)
    /// Its relay tab closed.
    case closed
}

/// The answer to one `ask` question: picked option indices and/or typed text.
struct AskAnswer: Encodable, Sendable {
    let options: [Int]
    let custom: String?
}

/// A new chat as the app sends it: its first message and what it starts on.
struct NewChat: Encodable, Sendable {
    var text: String
    var images: [NewTask.Image]
    /// `provider/id`; nil for omp's default.
    var model: String?
    var thinkingLevel: String?
}

/// Where the server started a new chat.
struct StartedChat: Decodable, Sendable {
    let sessionFile: String
    let paneId: String
}

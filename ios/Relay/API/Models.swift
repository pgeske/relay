import Foundation

/// A tmux window running `omp`, as reported by GET /api/sessions.
struct Session: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let windowId: String
    let windowIndex: Int
    let tmuxSession: String
    let title: String
    let status: SessionStatus
    let unread: Bool
    let focused: Bool
    let cwd: String
    let sessionFile: String?
    let updatedAt: String
    /// Active `provider/id`; nil when the server can't tell.
    let model: String?
    let thinkingLevel: String?

    var displayTitle: String {
        title.isEmpty ? "Untitled session" : title
    }

    var directoryName: String {
        let name = URL(fileURLWithPath: cwd).lastPathComponent
        return name.isEmpty ? cwd : name
    }

    var updatedDate: Date? {
        Timestamps.parse(updatedAt)
    }
}

enum SessionStatus: String, Decodable, Sendable {
    case working
    case idle

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = (try? container.decode(String.self)) ?? ""
        self = SessionStatus(rawValue: raw) ?? .idle
    }
}

enum Timestamps {
    static func parse(_ string: String) -> Date? {
        if let date = try? Date(string, strategy: .iso8601) {
            return date
        }
        let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        return try? Date(string, strategy: fractional)
    }
}

/// One renderable piece of a message.
enum Block: Hashable, Sendable {
    case text(String)
    case thinking(String)
    case toolCall(ToolCall)
    case toolResult(ToolResult)
    case image(url: String)
    case unknown(type: String)

    struct ToolCall: Hashable, Sendable {
        let id: String
        let name: String
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

/// The phone's answer to one `ask` question: picked option indices and/or a typed answer.
struct AskAnswer: Encodable, Sendable {
    let options: [Int]
    let custom: String?
}

extension Block: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type
        case text
        case thinking
        case id
        case name
        case summary
        case argsJson
        case toolCallId
        case truncated
        case isError
        case url
        case ask
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? container.decode(String.self, forKey: .type)) ?? ""

        switch type {
        case "text":
            self = .text((try? container.decode(String.self, forKey: .text)) ?? "")
        case "thinking":
            let thinking = (try? container.decode(String.self, forKey: .thinking)) ?? ""
            let text = (try? container.decode(String.self, forKey: .text)) ?? ""
            self = .thinking(thinking.isEmpty ? text : thinking)
        case "toolCall":
            self = .toolCall(
                ToolCall(
                    id: (try? container.decode(String.self, forKey: .id)) ?? "",
                    name: (try? container.decode(String.self, forKey: .name)) ?? "",
                    summary: (try? container.decode(String.self, forKey: .summary)) ?? "",
                    argsJson: (try? container.decode(String.self, forKey: .argsJson)) ?? "",
                    ask: try? container.decodeIfPresent([AskQuestion].self, forKey: .ask)
                )
            )
        case "toolResult":
            self = .toolResult(
                ToolResult(
                    toolCallId: (try? container.decode(String.self, forKey: .toolCallId)) ?? "",
                    name: (try? container.decode(String.self, forKey: .name)) ?? "",
                    text: (try? container.decode(String.self, forKey: .text)) ?? "",
                    truncated: (try? container.decode(Bool.self, forKey: .truncated)) ?? false,
                    isError: (try? container.decode(Bool.self, forKey: .isError)) ?? false
                )
            )
        case "image":
            self = .image(url: (try? container.decode(String.self, forKey: .url)) ?? "")
        default:
            self = .unknown(type: type)
        }
    }
}

enum MessageRole: String, Sendable, Decodable {
    case user
    case assistant
    case tool
    case unknown

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = (try? container.decode(String.self)) ?? ""
        self = MessageRole(rawValue: raw) ?? .unknown
    }
}

/// One jsonl entry exposed by the server.
struct Message: Identifiable, Hashable, Sendable {
    let id: String
    let role: MessageRole
    let timestamp: String
    let blocks: [Block]
}

extension Message: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id
        case role
        case timestamp
        case blocks
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = (try? container.decode(String.self, forKey: .id)) ?? UUID().uuidString
        self.role = (try? container.decode(MessageRole.self, forKey: .role)) ?? .unknown
        self.timestamp = (try? container.decode(String.self, forKey: .timestamp)) ?? ""

        let lossy = (try? container.decode([LossyBlock].self, forKey: .blocks)) ?? []
        self.blocks = lossy.compactMap(\.block)
    }

    private struct LossyBlock: Decodable {
        let block: Block?
        init(from decoder: Decoder) throws {
            block = try? Block(from: decoder)
        }
    }
}

extension Message {
    var textContent: String {
        blocks.compactMap { block in
            if case .text(let text) = block { return text }
            return nil
        }.joined(separator: "\n")
    }

    var imageURLs: [String] {
        blocks.compactMap { block in
            if case .image(let url) = block, !url.isEmpty { return url }
            return nil
        }
    }

    var toolResults: [Block.ToolResult] {
        blocks.compactMap { block in
            if case .toolResult(let result) = block { return result }
            return nil
        }
    }

    var toolCallIDs: [String] {
        blocks.compactMap { block in
            if case .toolCall(let call) = block, !call.id.isEmpty { return call.id }
            return nil
        }
    }
}

struct MessagesPage: Sendable {
    let messages: [Message]
    let hasMore: Bool
    let sessionFile: String?
}

extension MessagesPage: Decodable {
    private enum CodingKeys: String, CodingKey {
        case messages
        case hasMore
        case sessionFile
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let lossy = (try? container.decode([LossyMessage].self, forKey: .messages)) ?? []
        self.messages = lossy.compactMap(\.message)
        self.hasMore = (try? container.decode(Bool.self, forKey: .hasMore)) ?? false
        self.sessionFile = try? container.decode(String.self, forKey: .sessionFile)
    }

    private struct LossyMessage: Decodable {
        let message: Message?
        init(from decoder: Decoder) throws {
            message = try? Message(from: decoder)
        }
    }
}

struct SessionsResponse: Decodable, Sendable {
    let sessions: [Session]
}

/// A chat model the session can switch to, as reported by GET /api/models.
struct ModelOption: Decodable, Identifiable, Hashable, Sendable {
    /// `provider/id`, e.g. `anthropic/claude-opus-5-5`.
    let selector: String
    let name: String
    let provider: String
    /// Levels this model accepts, in order; empty when it can't think.
    let thinkingLevels: [String]

    var id: String { selector }
}

struct ModelsResponse: Decodable, Sendable {
    let models: [ModelOption]
}

struct HealthResponse: Decodable, Sendable {
    let ok: Bool
    let version: String
    /// Missing on servers from before voice calls existed.
    let voice: Bool?
}

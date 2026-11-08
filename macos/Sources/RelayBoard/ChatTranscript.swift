import AppKit
import SwiftUI

/// One row of a conversation as the Chats view lays it out. The agent's thinking and tool calls
/// between two things it says fold into one "work" row, the way chat apps show an agent's steps.
enum TranscriptItem: Identifiable {
    case user(ChatMessage)
    case pending(PendingMessage)
    case reply(id: String, text: String)
    case image(id: String, url: String)
    case work(id: String, steps: [WorkStep])

    var id: String {
        switch self {
        case .user(let message): message.id
        case .pending(let bubble): bubble.id
        case .reply(let id, _), .image(let id, _), .work(let id, _): id
        }
    }
}

/// A step of the agent's work: a thought, or a tool call with its result once it has one.
enum WorkStep: Identifiable {
    case thought(id: String, text: String)
    case tool(ChatBlock.ToolCall, result: ChatBlock.ToolResult?)

    var id: String {
        switch self {
        case .thought(let id, _): id
        case .tool(let call, _): call.id
        }
    }
}

extension Conversation {
    /// The conversation's rows, oldest first, then the messages you sent that it doesn't show yet.
    var transcript: [TranscriptItem] {
        let results = results
        var items: [TranscriptItem] = []
        var steps: [WorkStep] = []
        var workID: String?
        func flushWork() {
            if let id = workID, !steps.isEmpty { items.append(.work(id: id, steps: steps)) }
            steps = []
            workID = nil
        }
        for message in messages {
            switch message.role {
            case .user:
                flushWork()
                if !message.text.isEmpty || message.blocks.contains(where: { if case .image = $0 { true } else { false } }) {
                    items.append(.user(message))
                }
            case .assistant:
                for (index, block) in message.blocks.enumerated() {
                    let id = "\(message.id)-\(index)"
                    switch block {
                    case .text(let text) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                        flushWork()
                        items.append(.reply(id: id, text: text))
                    case .thinking(let text) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                        workID = workID ?? id
                        steps.append(.thought(id: id, text: text))
                    case .toolCall(let call):
                        workID = workID ?? id
                        steps.append(.tool(call, result: results[call.id]))
                    case .image(let url):
                        flushWork()
                        items.append(.image(id: id, url: url))
                    default:
                        break
                    }
                }
            case .tool, .unknown:
                // Results show inside the call they answer.
                break
            }
        }
        flushWork()
        return items + pending.map(TranscriptItem.pending)
    }
}

/// The conversation, scrolled to its latest message, with earlier ones a click away.
struct TranscriptView: View {
    let conversation: Conversation

    var body: some View {
        let items = conversation.transcript
        let scale = Zoom.shared.scale
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18 * scale) {
                if conversation.hasMore {
                    Button {
                        Task { await conversation.loadOlder() }
                    } label: {
                        if conversation.isLoadingOlder { ProgressView().controlSize(.small) } else { Text("Show earlier messages") }
                    }
                    .buttonStyle(.glass)
                    .frame(maxWidth: .infinity)
                }
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    TranscriptRow(item: item, isLatest: index == items.count - 1, working: conversation.working)
                }
                if conversation.working, !(items.last.map(isWork) ?? false) {
                    WorkingLabel(text: "Working…")
                }
            }
            .frame(maxWidth: 780 * scale)
            .padding(.horizontal, 28 * scale)
            .padding(.vertical, 24 * scale)
            .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
    }

    private func isWork(_ item: TranscriptItem) -> Bool {
        if case .work = item { true } else { false }
    }
}

private struct TranscriptRow: View {
    let item: TranscriptItem
    /// The conversation's last row, where the agent's work in progress shows.
    let isLatest: Bool
    let working: Bool

    var body: some View {
        switch item {
        case .user(let message):
            UserBubble(text: message.text, imageURLs: message.blocks.compactMap { if case .image(let url) = $0 { url } else { nil } }, sending: false)
        case .pending(let bubble):
            UserBubble(text: bubble.text, imageURLs: [], sending: true)
        case .reply(_, let text):
            MarkdownText(text: text)
                .font(.zoomed(size: 14, weight: .regular))
        case .image(_, let url):
            RemoteImage(url: url).frame(maxWidth: 420 * Zoom.shared.scale, alignment: .leading)
        case .work(_, let steps):
            WorkView(steps: steps, inProgress: isLatest && working)
        }
    }
}

/// A message you sent, in a bubble on the right, with the screenshots it carried.
private struct UserBubble: View {
    let text: String
    let imageURLs: [String]
    /// On its way: shown faded until omp writes it down.
    let sending: Bool

    var body: some View {
        let scale = Zoom.shared.scale
        let (body, attachments) = Self.splitAttachments(text)
        VStack(alignment: .trailing, spacing: 6 * scale) {
            if !attachments.isEmpty || !imageURLs.isEmpty {
                HStack(spacing: 6 * scale) {
                    ForEach(attachments, id: \.self) { path in
                        if let image = NSImage(contentsOfFile: path) { Thumbnail(image: image) }
                    }
                    ForEach(imageURLs, id: \.self) { RemoteImage(url: $0).frame(width: 120 * scale, height: 80 * scale).clipShape(.rect(cornerRadius: 8)) }
                }
            }
            if !body.isEmpty {
                Text(body)
                    .font(.zoomed(size: 14, weight: .regular))
                    .lineSpacing(3 * scale)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14 * scale)
                    .padding(.vertical, 9 * scale)
                    .background(Color.accentColor.opacity(0.14), in: .rect(cornerRadius: 18 * scale, style: .continuous))
            }
        }
        .opacity(sending ? 0.6 : 1)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 80 * scale)
    }

    /// The text you typed, and the screenshot files relay saved and named in "[Attached image: <path>]" lines.
    static func splitAttachments(_ text: String) -> (String, [String]) {
        var lines: [String] = []
        var paths: [String] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("[Attached image: "), line.hasSuffix("]") {
                paths.append(String(line.dropFirst("[Attached image: ".count).dropLast()))
            } else {
                lines.append(String(line))
            }
        }
        return (lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), paths)
    }
}

private struct Thumbnail: View {
    let image: NSImage

    var body: some View {
        let scale = Zoom.shared.scale
        Image(nsImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: 120 * scale, height: 80 * scale)
            .clipShape(.rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
    }
}

/// An image the server serves, loaded with relay's token.
struct RemoteImage: View {
    let url: String

    @Environment(BoardModel.self) private var model
    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFit()
            } else {
                RoundedRectangle(cornerRadius: 8).fill(.quaternary).overlay { Image(systemName: "photo").foregroundStyle(.secondary) }
            }
        }
        .task(id: url) { image = try? await model.client.image(at: url) }
    }
}

/// The agent's work between two things it said: folded to one line ("Ran 6 tools"), opening up
/// to each thought and tool call. While it's the agent's current work, the line says what it's doing.
private struct WorkView: View {
    let steps: [WorkStep]
    let inProgress: Bool

    @State private var expanded = false

    var body: some View {
        let scale = Zoom.shared.scale
        VStack(alignment: .leading, spacing: 6 * scale) {
            Button {
                withAnimation(.smooth(duration: 0.25)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6 * scale) {
                    if inProgress {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: failedCount > 0 ? "exclamationmark.triangle" : "checkmark.circle")
                            .foregroundStyle(failedCount > 0 ? Color.boardOrange : .secondary)
                    }
                    Text(headline).lineLimit(1).truncationMode(.tail)
                    Image(systemName: "chevron.right")
                        .font(.zoomed(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .foregroundStyle(.tertiary)
                }
                .font(.zoomed(.callout))
                .foregroundStyle(.secondary)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if expanded {
                VStack(alignment: .leading, spacing: 4 * scale) {
                    ForEach(steps) { step in
                        switch step {
                        case .thought(_, let text): ThoughtRow(text: text)
                        case .tool(let call, let result): ToolRow(call: call, result: result, running: inProgress && result == nil)
                        }
                    }
                }
                .padding(.leading, 10 * scale)
                .overlay(alignment: .leading) { Rectangle().fill(.quaternary).frame(width: 1.5) }
                .transition(.opacity)
            }
        }
    }

    private var tools: [(ChatBlock.ToolCall, ChatBlock.ToolResult?)] {
        steps.compactMap { if case .tool(let call, let result) = $0 { (call, result) } else { nil } }
    }

    private var failedCount: Int { tools.filter { $0.1?.isError == true }.count }

    /// What the work did, or while it's going, the step it's on.
    private var headline: String {
        if inProgress, let (call, _) = tools.last { return "\(call.name) \(call.summary)".trimmingCharacters(in: .whitespaces) }
        if inProgress { return "Thinking…" }
        if tools.isEmpty { return "Thought it over" }
        let count = tools.count
        let failed = failedCount > 0 ? " · \(failedCount) failed" : ""
        return "Ran \(count) tool\(count == 1 ? "" : "s")\(failed)"
    }
}

private struct ThoughtRow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.zoomed(.callout))
            .italic()
            .foregroundStyle(.secondary)
            .lineSpacing(2)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 2)
    }
}

/// One tool call on a line: its name and gist, opening to its arguments and what it returned.
private struct ToolRow: View {
    let call: ChatBlock.ToolCall
    let result: ChatBlock.ToolResult?
    let running: Bool

    @State private var expanded = false

    var body: some View {
        let scale = Zoom.shared.scale
        VStack(alignment: .leading, spacing: 4 * scale) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 6 * scale) {
                    Group {
                        if running {
                            ProgressView().controlSize(.mini)
                        } else if result?.isError == true {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(Color.boardRed)
                        } else {
                            Image(systemName: Self.symbol(call.name)).foregroundStyle(.secondary)
                        }
                    }
                    .frame(width: 14 * scale)
                    Text(call.name).fontWeight(.medium)
                    Text(call.summary)
                        .font(.system(size: BoardTextStyle.callout.rawValue * scale, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                }
                .font(.zoomed(.callout))
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if expanded {
                VStack(alignment: .leading, spacing: 6 * scale) {
                    if !call.argsJson.isEmpty { CodeBox(text: call.argsJson) }
                    if let result, !result.text.isEmpty {
                        CodeBox(text: result.truncated ? result.text + "\n…" : result.text, tint: result.isError ? .boardRed : nil)
                    }
                }
                .padding(.leading, 20 * scale)
            }
        }
    }

    static func symbol(_ tool: String) -> String {
        switch tool {
        case "bash": "terminal"
        case "read": "doc.text"
        case "edit", "write", "ast_edit": "pencil"
        case "grep", "glob", "web_search": "magnifyingglass"
        case "task": "person.2"
        case "ask": "questionmark.bubble"
        case "eval": "chevron.left.forwardslash.chevron.right"
        case "todo": "checklist"
        default: "wrench.and.screwdriver"
        }
    }
}

private struct CodeBox: View {
    let text: String
    var tint: Color?

    var body: some View {
        let scale = Zoom.shared.scale
        ScrollView(.vertical) {
            Text(text)
                .font(.system(size: BoardTextStyle.caption.rawValue * scale + 1, design: .monospaced))
                .foregroundStyle(tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.primary.opacity(0.85)))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8 * scale)
        }
        .frame(maxHeight: 240 * scale)
        .fixedSize(horizontal: false, vertical: true)
        .background(Color.primary.opacity(0.05), in: .rect(cornerRadius: 6))
    }
}

/// "Working…" with a spinner, while the agent hasn't said or done anything new yet.
struct WorkingLabel: View {
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.small)
            Text(text)
        }
        .font(.zoomed(.callout))
        .foregroundStyle(.secondary)
    }
}

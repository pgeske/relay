import SwiftUI

struct ChatItemView: View {
    let item: ChatItem
    let store: ChatStore
    let api: APIClient

    var body: some View {
        switch item.kind {
        case .message(let message):
            MessageRow(
                message: message,
                toolResults: store.toolResultMap,
                matchedToolCallIDs: store.matchedToolCallIDs,
                api: api
            )
        case .pending(let pending):
            PendingBubble(pending: pending)
        }
    }
}

struct MessageRow: View {
    let message: Message
    let toolResults: [String: Block.ToolResult]
    let matchedToolCallIDs: Set<String>
    let api: APIClient

    var body: some View {
        switch message.role {
        case .user:
            UserMessageView(message: message, api: api)
        case .assistant:
            VStack(alignment: .leading, spacing: 10) {
                ForEach(message.blocks.indices, id: \.self) { index in
                    AssistantBlockView(
                        block: message.blocks[index],
                        toolResults: toolResults,
                        matchedToolCallIDs: matchedToolCallIDs,
                        api: api
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .tool:
            VStack(alignment: .leading, spacing: 8) {
                ForEach(message.blocks.indices, id: \.self) { index in
                    if case .toolResult(let result) = message.blocks[index], !matchedToolCallIDs.contains(result.toolCallId) {
                        ToolResultRow(result: result)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .unknown:
            EmptyView()
        }
    }
}

private struct AssistantBlockView: View {
    let block: Block
    let toolResults: [String: Block.ToolResult]
    let matchedToolCallIDs: Set<String>
    let api: APIClient

    var body: some View {
        switch block {
        case .text(let text):
            if !text.isEmpty {
                MarkdownText(text: text)
            }
        case .thinking(let text):
            if !text.isEmpty {
                ThinkingView(text: text)
            }
        case .toolCall(let call):
            if !call.name.isEmpty {
                ToolCallRow(call: call, result: toolResults[call.id])
            }
        case .toolResult(let result):
            if !matchedToolCallIDs.contains(result.toolCallId) {
                ToolResultRow(result: result)
            }
        case .image(let url):
            if !url.isEmpty {
                AuthenticatedImage(path: url, api: api)
                    .frame(maxWidth: 260)
            }
        case .unknown:
            EmptyView()
        }
    }
}

struct UserMessageView: View {
    let message: Message
    let api: APIClient

    @Environment(\.appTheme) private var theme

    var body: some View {
        HStack {
            Spacer(minLength: 48)

            VStack(alignment: .trailing, spacing: 6) {
                ForEach(message.imageURLs.indices, id: \.self) { index in
                    AuthenticatedImage(path: message.imageURLs[index], api: api)
                        .frame(maxWidth: 210)
                }

                let text = message.textContent.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    Text(text)
                        .font(.body)
                        .foregroundStyle(theme.userBubbleForeground)
                        .multilineTextAlignment(.leading)
                        .textSelection(.enabled)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 9)
                        .background(
                            theme.userBubble,
                            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                        )
                        .contextMenu {
                            Button {
                                UIPasteboard.general.string = text
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                        }
                }
            }
        }
    }
}

struct PendingBubble: View {
    let pending: PendingMessage

    @Environment(\.appTheme) private var theme

    var body: some View {
        HStack {
            Spacer(minLength: 48)

            VStack(alignment: .trailing, spacing: 4) {
                if !pending.text.isEmpty {
                    Text(pending.text)
                        .font(.body)
                        .foregroundStyle(theme.userBubbleForeground)
                        .multilineTextAlignment(.leading)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 9)
                        .background(
                            theme.userBubble,
                            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                        )
                }

                if pending.imageCount > 0 {
                    Label(
                        "\(pending.imageCount) photo\(pending.imageCount == 1 ? "" : "s")",
                        systemImage: "photo"
                    )
                    .font(.caption2)
                    .foregroundStyle(theme.secondaryText)
                }
            }
        }
    }
}

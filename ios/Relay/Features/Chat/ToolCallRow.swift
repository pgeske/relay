import SwiftUI

struct ToolCallRow: View {
    let call: Block.ToolCall
    let result: Block.ToolResult?

    @Environment(\.appTheme) private var theme
    @State private var isExpanded = false

    private var isError: Bool { result?.isError == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.snappy(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: ToolStyle.icon(for: call.name))
                        .font(.caption)
                        .foregroundStyle(isError ? theme.error : theme.toolIcon)
                        .frame(width: 14)

                    Text(call.name)
                        .font(.caption.weight(.semibold))
                        .monospaced()
                        .foregroundStyle(isError ? theme.error : theme.primaryText)

                    if !call.summary.isEmpty {
                        Text(call.summary)
                            .font(.caption)
                            .foregroundStyle(isError ? theme.error.opacity(0.8) : theme.secondaryText)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 4)

                    if isError {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(theme.error)
                    }

                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .foregroundStyle(isError ? theme.error : theme.secondaryText)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                if !call.argsJson.isEmpty {
                    CodeTextView(text: call.argsJson, maxHeight: 240)
                }
                if let result {
                    ToolResultContent(result: result)
                } else {
                    Text("No result yet")
                        .font(.caption2)
                        .foregroundStyle(theme.tertiaryText)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            isError ? theme.error.opacity(0.12) : theme.toolSurface,
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
    }
}

struct ToolResultContent: View {
    let result: Block.ToolResult

    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(result.isError ? "Error" : "Result")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(result.isError ? theme.error : theme.secondaryText)
                if result.truncated {
                    Text("truncated")
                        .font(.caption2)
                        .foregroundStyle(theme.tertiaryText)
                }
                Spacer(minLength: 0)
            }

            CodeTextView(
                text: result.text.isEmpty ? "(no output)" : result.text,
                maxHeight: 260
            )
            .foregroundStyle(result.isError ? theme.error : theme.primaryText)
        }
    }
}

/// A tool result whose tool call isn't in the loaded history (for example,
/// after paging past the call).
struct ToolResultRow: View {
    let result: Block.ToolResult

    @Environment(\.appTheme) private var theme
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.snappy(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "wrench.and.screwdriver")
                        .font(.caption)
                        .foregroundStyle(result.isError ? theme.error : theme.toolIcon)
                    Text(result.name.isEmpty ? "Tool result" : result.name)
                        .font(.caption.weight(.medium))
                        .monospaced()
                        .foregroundStyle(result.isError ? theme.error : theme.primaryText)
                    Spacer(minLength: 0)
                    if result.isError {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(theme.error)
                    }
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .foregroundStyle(result.isError ? theme.error : theme.secondaryText)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                ToolResultContent(result: result)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            result.isError ? theme.error.opacity(0.12) : theme.toolSurface,
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
    }
}

private enum ToolStyle {
    static func icon(for name: String) -> String {
        let name = name.lowercased()
        if name.contains("bash") || name.contains("shell") || name.contains("exec") {
            return "terminal"
        }
        if name.contains("grep") || name.contains("search") || name.contains("find") {
            return "magnifyingglass"
        }
        if name.contains("read") || name.contains("view") {
            return "doc.text"
        }
        if name.contains("write") || name.contains("edit") || name.contains("replace") {
            return "pencil"
        }
        if name.contains("glob") || name.contains("list") {
            return "folder"
        }
        if name.contains("web") || name.contains("fetch") || name.contains("http") {
            return "globe"
        }
        if name.contains("task") || name.contains("agent") {
            return "person.2"
        }
        if name.contains("image") || name.contains("photo") {
            return "photo"
        }
        return "wrench.and.screwdriver"
    }
}

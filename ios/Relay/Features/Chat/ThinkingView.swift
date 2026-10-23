import SwiftUI

struct ThinkingView: View {
    let text: String
    @State private var isExpanded = false

    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "brain")
                        .font(.caption2)
                    Text("Thinking")
                        .font(.caption.weight(.medium))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .foregroundStyle(theme.secondaryText)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                Text(text)
                    .font(.callout)
                    .foregroundStyle(theme.secondaryText)
                    .textSelection(.enabled)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(theme.separator)
                            .frame(width: 2)
                    }
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

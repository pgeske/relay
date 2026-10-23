import SwiftUI
import MarkdownUI

struct MarkdownText: View {
    let text: String

    @Environment(\.appTheme) private var theme

    var body: some View {
        Markdown(text)
            .markdownTheme(theme.markdownTheme)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu {
                Button {
                    UIPasteboard.general.string = text
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
            }
    }
}

/// Monospaced code with horizontal scrolling and a copy action.
struct CodeTextView: View {
    let text: String
    var maxHeight: CGFloat?

    @Environment(\.appTheme) private var theme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(theme.primaryText)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
        }
        .frame(maxHeight: maxHeight, alignment: .top)
        .background(theme.codeBackground, in: RoundedRectangle(cornerRadius: 6))
        .contextMenu {
            Button {
                UIPasteboard.general.string = text
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }
    }
}

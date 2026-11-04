import SwiftUI

/// What an agent concluded, and its write-up.
struct DetailPopover: View {
    let detail: Detail
    let card: Card

    /// A long write-up scrolls past this height.
    private let maximumTextHeight: CGFloat = 420
    @State private var textHeight: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(detail.title).font(.zoomedHeadline)
                Text(verbatim: "\(card.repoName) #\(card.number)").foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                Text(detail.verdict).fontWeight(.semibold).foregroundStyle(detail.tone.color)
                Text("·").foregroundStyle(.tertiary)
                Text("commit \(detail.commit)").monospaced().foregroundStyle(.secondary)
                Text("·").foregroundStyle(.tertiary)
                Text(detail.at, format: .relative(presentation: .named)).foregroundStyle(.secondary)
            }
            .font(.zoomed(.subheadline))
            if let note = detail.note {
                Label(note, systemImage: "exclamationmark.triangle.fill")
                    .font(.zoomed(.callout))
                    .foregroundStyle(Color.boardOrange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            if let summary = detail.summary {
                ScrollView {
                    summaryText(summary)
                        .onGeometryChange(for: CGFloat.self, of: \.size.height) { textHeight = $0 }
                }
                .frame(height: min(max(textHeight, 1), maximumTextHeight))
                .scrollBounceBehavior(.basedOnSize)
            } else {
                Text("No write-up was saved with this result. Its session has the details.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(width: 460 * Zoom.shared.scale)
    }

    /// Agents write a little Markdown (code spans, bold, links); line breaks are theirs too.
    private func summaryText(_ summary: String) -> some View {
        let markdown = try? AttributedString(markdown: summary, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        return Text(markdown ?? AttributedString(summary))
            .textSelection(.enabled)
            .lineSpacing(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

import SwiftUI

/// One of a card's status tags. Some act when clicked: the red CI tag asks the session to fix CI,
/// an agent's tag shows what it wrote, and the approval tag opens the ask in Slack.
struct TagChip: View {
    let tag: Tag
    let card: Card

    @Environment(BoardModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var hovering = false
    @State private var showingDetail = false

    var body: some View {
        if tag.action != nil || tag.detail != nil || tag.link != nil {
            Button(action: activate) { chip }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
                .pointerStyle(.link)
                .help(tag.hint ?? "")
                .disabled(sending)
                .popover(isPresented: $showingDetail, arrowEdge: .bottom) {
                    if let detail = tag.detail { DetailPopover(detail: detail, card: card) }
                }
        } else {
            chip.help(tag.hint ?? "")
        }
    }

    private var sending: Bool {
        tag.action.map { model.isSending($0, on: card) } ?? false
    }

    private func activate() {
        if let action = tag.action {
            model.request(action, on: card)
        } else if tag.detail != nil {
            showingDetail = true
        } else if let link = tag.link {
            openURL(link)
        }
    }

    private var chip: some View {
        HStack(spacing: 4) {
            if tag.running || sending {
                ProgressView().controlSize(.mini).scaleEffect(0.75).frame(width: 10, height: 10)
            } else if let symbol = tag.symbol {
                Image(systemName: symbol).imageScale(.small)
            }
            Text(tag.text)
            if tag.action != nil {
                Image(systemName: "wrench.adjustable.fill").imageScale(.small)
            } else if tag.detail != nil {
                Image(systemName: "chevron.down").font(.system(size: 7, weight: .bold))
            } else if tag.link != nil {
                Image(systemName: "arrow.up.right").font(.system(size: 8, weight: .bold))
            }
        }
        .font(.caption.weight(.medium))
        .lineLimit(1)
        .foregroundStyle(tag.tone.color)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background {
            if tag.tone == .ghost {
                Capsule().strokeBorder(Color.secondary.opacity(0.45), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
            } else if tag.running {
                PulsingFill(color: tag.tone.color)
            } else {
                Capsule().fill(tag.tone.color.opacity(hovering ? 0.24 : 0.13))
            }
        }
        .overlay {
            if tag.action != nil { Capsule().strokeBorder(tag.tone.color.opacity(hovering ? 0.6 : 0.35), lineWidth: 1) }
        }
    }
}

/// The ticket key a PR's title started with.
struct TicketChip: View {
    let ticket: String

    var body: some View {
        Text(ticket)
            .font(.caption.weight(.semibold))
            .monospacedDigit()
            .lineLimit(1)
            .foregroundStyle(Color.boardBlue)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Color.boardBlue.opacity(0.12), in: .rect(cornerRadius: 5))
            .help("Ticket \(ticket)")
    }
}

/// A tag's fill that breathes while its request runs.
private struct PulsingFill: View {
    let color: Color

    var body: some View {
        Capsule().fill(color).phaseAnimator([0.1, 0.28]) { fill, opacity in
            fill.opacity(opacity)
        } animation: { _ in
            .easeInOut(duration: 0.9)
        }
    }
}

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
                Text(detail.title).font(.headline)
                Text(verbatim: "\(card.repoName) #\(card.number)").foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                Text(detail.verdict).fontWeight(.semibold).foregroundStyle(detail.tone.color)
                Text("·").foregroundStyle(.tertiary)
                Text("commit \(detail.commit)").monospaced().foregroundStyle(.secondary)
                Text("·").foregroundStyle(.tertiary)
                Text(detail.at, format: .relative(presentation: .named)).foregroundStyle(.secondary)
            }
            .font(.subheadline)
            if let note = detail.note {
                Label(note, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
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
        .frame(width: 460)
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

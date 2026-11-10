import SwiftUI

/// Every lane top to bottom in work order, each a section whose cards wrap to the window's width.
/// Clicking a header folds its section. A plain stack, not a lazy one: a lazy stack of these tall,
/// wrapping sections can keep re-measuring a section at the edge of the screen and hang the app.
struct LanesView: View {
    let lanes: [Lane]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(lanes) { LaneSection(lane: $0) }
            }
            .padding(.top, 6)
            .padding(.bottom, 16)
        }
    }
}

/// One lane in the list: its header, then its cards unless it's folded or empty.
private struct LaneSection: View {
    let lane: Lane
    @AppStorage private var folded: Bool

    init(lane: Lane) {
        self.lane = lane
        // Merged is history: it starts folded.
        _folded = AppStorage(wrappedValue: lane.id == "merged", "lane.\(lane.id).folded")
    }

    var body: some View {
        Section {
            if !folded && !lane.cards.isEmpty {
                LaneCards(lane: lane).sectionBox(lit: lane.lit, tint: lane.tint)
            }
        } header: {
            SectionHeader(section: lane.section, folded: $folded)
        }
    }
}

/// What a lane's header shows.
struct SectionInfo {
    var title: String
    var hint: String
    var symbol: String
    var tint: Color
    var count: Int
    /// Waiting on you, and holding anything.
    var lit: Bool
    /// How many of its cards need you, badged at the header's end.
    var needsYou = 0
}

extension View {
    /// A section's cards in their box: tinted when the section is waiting on you.
    func sectionBox(lit: Bool, tint: Color) -> some View {
        padding(8)
            .background {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(lit ? AnyShapeStyle(tint.opacity(0.08)) : AnyShapeStyle(.quinary))
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 10)
    }
}

/// A section's one-line header: chevron, symbol, title, count, and its hint. The chevron and symbol
/// sit in fixed boxes, so every header's title starts at the same place, and the chevron lines up
/// with the cards' left edge.
struct SectionHeader: View {
    let section: SectionInfo
    @Binding var folded: Bool

    var body: some View {
        let scale = Zoom.shared.scale
        Button {
            withAnimation(.snappy(duration: 0.25)) { folded.toggle() }
        } label: {
            HStack(spacing: 7) {
                // An empty section can't fold: a quiet dot holds the chevron's place, so every header has a mark there.
                Image(systemName: empty ? "circle.fill" : "chevron.right")
                    .font(.zoomed(size: empty ? 4 : 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(folded || empty ? 0 : 90))
                    .frame(width: 10 * scale)
                Image(systemName: section.symbol)
                    .font(.zoomed(.callout))
                    .foregroundStyle(section.tint)
                    .frame(width: 18 * scale)
                Text(section.title)
                    .font(.zoomedHeadline)
                    .foregroundStyle(empty ? .secondary : .primary)
                    // The hint gives way first when the window is narrow.
                    .layoutPriority(1)
                SectionCount(section: section)
                Text(empty ? "Nothing here" : section.hint)
                    .font(.zoomed(.callout))
                    .foregroundStyle(empty ? .tertiary : .secondary)
                    .padding(.leading, 4)
                    .help(section.hint)
                Spacer(minLength: 0)
                if section.needsYou > 0 {
                    Label("\(section.needsYou)", systemImage: "hand.raised.fill")
                        .font(.zoomed(.caption).weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color.boardOrange, in: .capsule)
                        .help("\(section.needsYou) need\(section.needsYou == 1 ? "s" : "") you")
                }
            }
            .lineLimit(1)
            // The section's box is inset 16 and its cards 8 more.
            .padding(.horizontal, 24)
            .padding(.vertical, 9)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(empty)
        .background(.background)
        .help(empty ? section.hint : folded ? "Show \(section.title)" : "Fold \(section.title)")
    }

    private var empty: Bool { section.count == 0 }
}

/// One lane on its own: a larger header over the same grid of cards.
struct LaneGridView: View {
    let lane: Lane

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Image(systemName: lane.symbol)
                            .font(.zoomed(.title3))
                            .foregroundStyle(lane.tint)
                        Text(lane.title)
                            .font(.zoomed(.title2).weight(.semibold))
                        SectionCount(section: lane.section)
                    }
                    Text(lane.hint)
                        .font(.zoomed(.callout))
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
                if lane.cards.isEmpty {
                    ContentUnavailableView("Nothing in \(lane.title)", systemImage: lane.symbol, description: Text(lane.hint))
                        .padding(.top, 60)
                } else {
                    LaneCards(lane: lane)
                }
            }
            .padding(20)
        }
    }
}

/// A lane's cards: Merged as a list, newest first, since there's nothing left to do on them; every
/// other lane as a grid.
private struct LaneCards: View {
    let lane: Lane

    var body: some View {
        if lane.id == "merged" {
            MergedList(cards: lane.cards)
        } else {
            let zoom = Zoom.shared.scale
            CardGrid(minimum: 260 * zoom, maximum: 380 * zoom, spacing: 10) {
                ForEach(lane.cards) { CardView(card: $0) }
            }
        }
    }
}

/// Cards as many across as fit, never wider than a card reads well, left to right and then down.
/// Each row is as tall as its tallest card, and every card in it is offered that height, so their
/// footers line up.
struct CardGrid: Layout {
    let minimum: CGFloat
    let maximum: CGFloat
    let spacing: CGFloat

    struct Rows {
        var width: CGFloat = -1
        var columns = 1
        var columnWidth: CGFloat = 0
        var heights: [CGFloat] = []
    }

    func makeCache(subviews: Subviews) -> Rows { Rows() }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Rows) -> CGSize {
        let width = proposal.width ?? maximum
        measure(width: width, subviews: subviews, cache: &cache)
        let height = cache.heights.reduce(0, +) + spacing * CGFloat(max(cache.heights.count - 1, 0))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Rows) {
        measure(width: bounds.width, subviews: subviews, cache: &cache)
        var y = bounds.minY
        for (row, height) in cache.heights.enumerated() {
            for column in 0..<cache.columns {
                let index = row * cache.columns + column
                guard index < subviews.count else { break }
                let x = bounds.minX + CGFloat(column) * (cache.columnWidth + spacing)
                subviews[index].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(width: cache.columnWidth, height: height))
            }
            y += height + spacing
        }
    }

    /// The columns that fit `width` and each row's height, unless they're measured for it already.
    /// SwiftUI starts the cache over whenever the cards change.
    private func measure(width: CGFloat, subviews: Subviews, cache: inout Rows) {
        guard width != cache.width else { return }
        let columns = max(1, Int((width + spacing) / (minimum + spacing)))
        let columnWidth = min(maximum, (width - spacing * CGFloat(columns - 1)) / CGFloat(columns))
        let fit = ProposedViewSize(width: columnWidth, height: nil)
        cache = Rows(
            width: width, columns: columns, columnWidth: columnWidth,
            heights: stride(from: 0, to: subviews.count, by: columns).map { start in
                subviews[start..<min(start + columns, subviews.count)].map { $0.sizeThatFits(fit).height }.max() ?? 0
            }
        )
    }
}

/// Merged PRs, one per line in the order given: repo and number, title, and when it merged.
private struct MergedList: View {
    let cards: [Card]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(cards.enumerated()), id: \.element.id) { index, card in
                if index > 0 { Divider().padding(.horizontal, 12) }
                MergedRow(card: card)
            }
        }
        .background(Color(nsColor: .controlBackgroundColor), in: .rect(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.07), lineWidth: 1)
        }
        .clipShape(.rect(cornerRadius: 12, style: .continuous))
    }
}

/// One merged PR on a line of its own. Clicking it opens the PR; its "…" menu and right-click menu
/// are the card's.
private struct MergedRow: View {
    let card: Card

    @Environment(\.openURL) private var openURL
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            HStack(spacing: 3) {
                Text(card.repoName).fontWeight(.medium)
                Text(verbatim: "#\(card.number)").monospacedDigit()
            }
            .font(.zoomed(.caption))
            .foregroundStyle(.secondary)
            .fixedSize()
            .help(card.repo)
            if let ticket = card.ticket { TicketChip(ticket: ticket) }
            Text(card.title)
                .font(.zoomed(.subheadline).weight(.medium))
                .truncationMode(.tail)
            Spacer(minLength: 8)
            Text(card.age.text)
                .font(.zoomed(.caption))
                .foregroundStyle(.tertiary)
                .fixedSize()
                .help(card.age.hint ?? "")
            CardMenu { CardMenuItems(card: card) }
        }
        .lineLimit(1)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.primary.opacity(hovering ? 0.05 : 0))
        .contentShape(.rect)
        .onTapGesture { openURL(card.url) }
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.15), value: hovering)
        .help("Open \(card.ref) on GitHub")
        .contextMenu { CardMenuItems(card: card) }
    }
}

/// How many cards a section holds; sections waiting on you light it up while they hold anything.
struct SectionCount: View {
    let section: SectionInfo

    var body: some View {
        Text("\(section.count)")
            .font(.zoomed(.caption).weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(section.lit ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(section.lit ? AnyShapeStyle(section.tint) : AnyShapeStyle(.quaternary), in: .capsule)
    }
}

private extension Lane {
    /// A lane waiting on you that holds anything.
    var lit: Bool { hot && !cards.isEmpty }

    var section: SectionInfo {
        SectionInfo(title: title, hint: hint, symbol: symbol, tint: tint, count: cards.count, lit: lit)
    }
}

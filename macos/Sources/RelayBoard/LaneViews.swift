import SwiftUI

/// Every lane top to bottom in work order, each a section whose cards wrap to the window's width.
/// Headers stay pinned while their section scrolls by; clicking one folds the section.
struct LanesView: View {
    let lanes: [Lane]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
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
                CardGrid(lane: lane)
                    .padding(8)
                    .background {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(lane.lit ? AnyShapeStyle(lane.tint.opacity(0.08)) : AnyShapeStyle(.quinary))
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)
            }
        } header: {
            SectionHeader(lane: lane, folded: $folded)
        }
    }
}

/// A lane's one-line header: chevron, symbol, title, count, and its hint. Pinned, so it hides the
/// cards scrolling under it.
private struct SectionHeader: View {
    let lane: Lane
    @Binding var folded: Bool

    var body: some View {
        Button {
            withAnimation(.snappy(duration: 0.25)) { folded.toggle() }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "chevron.right")
                    .font(.zoomed(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(folded || empty ? 0 : 90))
                    .opacity(empty ? 0 : 1)
                Image(systemName: lane.symbol)
                    .font(.zoomed(.callout))
                    .foregroundStyle(lane.tint)
                Text(lane.title)
                    .font(.zoomedHeadline)
                    .foregroundStyle(empty ? .secondary : .primary)
                    // The hint gives way first when the window is narrow.
                    .layoutPriority(1)
                LaneCount(lane: lane)
                Text(empty ? "Nothing here" : lane.hint)
                    .font(.zoomed(.callout))
                    .foregroundStyle(empty ? .tertiary : .secondary)
                    .padding(.leading, 4)
                    .help(lane.hint)
                Spacer(minLength: 0)
            }
            .lineLimit(1)
            .padding(.horizontal, 22)
            .padding(.vertical, 9)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(empty)
        .background(.background)
        .help(empty ? lane.hint : folded ? "Show \(lane.title)" : "Fold \(lane.title)")
    }

    private var empty: Bool { lane.cards.isEmpty }
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
                        LaneCount(lane: lane)
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
                    CardGrid(lane: lane)
                }
            }
            .padding(20)
        }
    }
}

/// A lane's cards, as many across as fit and top-aligned, never wider than a card reads well.
private struct CardGrid: View {
    let lane: Lane

    var body: some View {
        let zoom = Zoom.shared.scale
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 260 * zoom, maximum: 380 * zoom), spacing: 10, alignment: .top)], alignment: .leading, spacing: 10) {
            ForEach(lane.cards) { CardView(card: $0, muted: lane.id == "merged") }
        }
    }
}

/// How many cards a lane holds; lanes waiting on you light it up while they hold anything.
private struct LaneCount: View {
    let lane: Lane

    var body: some View {
        Text("\(lane.cards.count)")
            .font(.zoomed(.caption).weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(lane.lit ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(lane.lit ? AnyShapeStyle(lane.tint) : AnyShapeStyle(.quaternary), in: .capsule)
    }
}

private extension Lane {
    /// A lane waiting on you that holds anything.
    var lit: Bool { hot && !cards.isEmpty }
}

import SwiftUI

/// Every lane side by side, left to right as work moves. Columns share the window's width down
/// to a readable minimum, then the board scrolls sideways.
struct KanbanView: View {
    let lanes: [Lane]

    private let spacing: CGFloat = 10
    private let padding: CGFloat = 14
    private let minimumWidth: CGFloat = 232

    var body: some View {
        GeometryReader { geometry in
            let count = CGFloat(max(lanes.count, 1))
            let width = max(minimumWidth, (geometry.size.width - padding * 2 - spacing * (count - 1)) / count)
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: spacing) {
                    ForEach(lanes) { lane in
                        LaneColumn(lane: lane).frame(width: width)
                    }
                }
                .padding(padding)
                .frame(height: geometry.size.height)
            }
        }
    }
}

/// One lane: its header, then its cards, scrolling on their own.
private struct LaneColumn: View {
    let lane: Lane

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            LaneHeader(lane: lane)
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .padding(.bottom, 10)
            ScrollView(.vertical) {
                LazyVStack(spacing: 8) {
                    ForEach(lane.cards) { CardView(card: $0, muted: lane.id == "merged") }
                    if lane.cards.isEmpty {
                        Text("Nothing here")
                            .font(.callout)
                            .foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 28)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
            }
            .scrollIndicators(.never)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(lane.hot && !lane.cards.isEmpty ? AnyShapeStyle(lane.tint.opacity(0.08)) : AnyShapeStyle(.quinary))
        }
    }
}

struct LaneHeader: View {
    let lane: Lane
    var large = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 7) {
                Image(systemName: lane.symbol)
                    .foregroundStyle(lane.tint)
                    .font(large ? .title3 : .callout)
                Text(lane.title)
                    .font(large ? .title2.weight(.semibold) : .headline)
                    .lineLimit(1)
                Spacer(minLength: 4)
                count
            }
            // One line, so every lane's cards start at the same height.
            Text(lane.hint)
                .font(large ? .callout : .caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .help(lane.hint)
        }
    }

    /// Lanes waiting on you light their count up while they hold anything.
    private var count: some View {
        let lit = lane.hot && !lane.cards.isEmpty
        return Text("\(lane.cards.count)")
            .font(.caption.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(lit ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(lit ? AnyShapeStyle(lane.tint) : AnyShapeStyle(.quaternary), in: .capsule)
    }
}

/// One lane on its own, its cards in a grid that fills the window.
struct LaneGridView: View {
    let lane: Lane

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                LaneHeader(lane: lane, large: true)
                if lane.cards.isEmpty {
                    ContentUnavailableView("Nothing in \(lane.title)", systemImage: lane.symbol, description: Text(lane.hint))
                        .padding(.top, 60)
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 300, maximum: 440), spacing: 12, alignment: .top)], spacing: 12) {
                        ForEach(lane.cards) { CardView(card: $0, muted: lane.id == "merged") }
                    }
                }
            }
            .padding(20)
        }
    }
}

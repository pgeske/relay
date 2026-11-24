import SwiftUI

/// Your tasks at a glance, for coming back to the board without rereading every card: what needs
/// you, best first, with the top one ready to act on; then each workstream relay found in a line,
/// with its open tasks a row each, grouped by its parts. Every row opens the task's details, like a card.
struct OverviewView: View {
    let overview: Overview

    @Environment(BoardModel.self) private var model

    var body: some View {
        let cards = model.taskCards
        let changes = model.changesSinceLastLook
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                if !model.untrackedSessions.isEmpty {
                    UntrackedStrip(sessions: model.untrackedSessions)
                }
                UpNextSection(items: overview.upNext.compactMap { item in cards[item.id].map { (item, $0) } }, counts: overview.counts)
                if let since = model.lastLook?.at, !changes.isEmpty {
                    SinceLastLookSection(since: since, changes: changes.compactMap { change in cards[change.id].map { (change, $0) } })
                }
                if !overview.workstreams.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        OverviewHeader(title: "Workstreams", symbol: "square.stack.3d.up", tint: .secondary)
                        ForEach(overview.workstreams) { WorkstreamBlock(workstream: $0, cards: cards) }
                    }
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 18)
            .frame(maxWidth: 920 * Zoom.shared.scale, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .environment(\.changedTaskIds, Set(changes.map(\.id)))
    }
}

private struct ChangedTaskIdsKey: EnvironmentKey {
    static let defaultValue: Set<Int> = []
}

extension EnvironmentValues {
    /// The tasks that moved since you last looked, which the Overview's rows mark.
    var changedTaskIds: Set<Int> {
        get { self[ChangedTaskIdsKey.self] }
        set { self[ChangedTaskIdsKey.self] = newValue }
    }
}

/// What moved while you were away, a row each, what needs you first; Mark Seen clears it.
private struct SinceLastLookSection: View {
    let since: Date
    let changes: [(TaskChange, TaskCard)]

    @Environment(BoardModel.self) private var model

    /// More than this and the rest go behind a count: it's news, not a second board.
    private let shown = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                OverviewHeader(title: "Since you last looked", symbol: "clock.arrow.circlepath", tint: .boardBlue)
                Text(since, format: .relative(presentation: .named))
                    .font(.zoomed(.callout))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Button("Mark Seen") { withAnimation(.snappy(duration: 0.25)) { model.markSeen() } }
                    .controlSize(.small)
                    .help("Clear this list; it fills again with what moves from here on")
            }
            RowList {
                // A shipped task's own line already says so ("Shipped 3h ago").
                ForEach(changes.prefix(shown), id: \.0.id) { change, card in OverviewRow(card: card, detail: card.stage == "done" ? nil : change.label) }
            }
            if changes.count > shown {
                Text("and \(changes.count - shown) more")
                    .font(.zoomed(.callout))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct OverviewHeader: View {
    let title: String
    let symbol: String
    let tint: Color

    var body: some View {
        Label {
            Text(title)
        } icon: {
            Image(systemName: symbol).foregroundStyle(tint)
        }
        .font(.zoomed(.title3).weight(.semibold))
    }
}

/// What needs you: the best next move on a card of its own, the rest a row each, then how much is
/// moving without you.
private struct UpNextSection: View {
    let items: [(UpNext, TaskCard)]
    let counts: OverviewCounts

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            OverviewHeader(title: "Up next", symbol: "hand.raised.fill", tint: .boardOrange)
            if let (first, card) = items.first {
                UpNextLead(card: card, item: first)
                if items.count > 1 {
                    RowList {
                        ForEach(items.dropFirst(), id: \.0.id) { item, card in OverviewRow(card: card, detail: item.why) }
                    }
                }
            } else {
                Label("Nothing needs you right now.", systemImage: "checkmark.circle")
                    .font(.zoomed(.body))
                    .foregroundStyle(Color.boardGreen)
            }
            Text(othersLine)
                .font(.zoomed(.callout))
                .foregroundStyle(.secondary)
        }
    }

    /// "3 moving on their own · 4 waiting on others · 2 parked", leaving out what's zero.
    private var othersLine: String {
        let parts = [
            counts.moving > 0 ? "\(counts.moving) moving without you" : nil,
            counts.waiting > 0 ? "\(counts.waiting) waiting on others" : nil,
            counts.parked > 0 ? "\(counts.parked) parked" : nil,
        ].compactMap(\.self)
        return parts.isEmpty ? "Nothing else open." : parts.joined(separator: " · ")
    }
}

/// The best next move: what to do, why it's first, and the buttons that do it; for a delivery, what
/// the agent did, to look over first.
private struct UpNextLead: View {
    let card: TaskCard
    let item: UpNext

    @State private var showingDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(card.ref).monospacedDigit()
                if let workstream = item.workstream { Text("·"); Text(workstream) }
                if !item.why.isEmpty { Text("·"); Text(item.why) }
                Spacer(minLength: 4)
                CardMenu { TaskMenuItems(card: card) }
            }
            .font(.zoomed(.caption))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            Text(card.brief ?? card.turn.reason ?? card.turn.label)
                .font(.zoomed(.title3).weight(.semibold))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Text(card.title)
                .font(.zoomed(.subheadline))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if let plan = card.plan, plan.awaiting {
                PlanNote(card: card, plan: plan)
            }
            if let finish = card.finish, finish.awaiting {
                DeliveryNote(card: card, finish: finish)
            }
            Group {
                // Nothing to click through: it asked you something, which you answer in its session.
                if card.running == nil, card.steps.isEmpty, let open = card.session?.open {
                    StepButton(step: open, target: .task(card.id))
                } else {
                    TaskStepSlot(card: card)
                }
            }
            .padding(.top, 2)
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor), in: .rect(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.boardOrange.opacity(0.55), lineWidth: 1.5)
        }
        .contentShape(.rect(cornerRadius: 12))
        .onTapGesture { showingDetails = true }
        .popover(isPresented: $showingDetails, arrowEdge: .trailing) { TaskDetailsPopover(card: card, isPresented: $showingDetails) }
        .contextMenu { TaskMenuItems(card: card) }
        .help("Show \(card.ref)'s details and history")
    }
}

/// A workstream on a line: its name, a dot per open task in its turn's color, and what relay says of
/// it; then its own tasks a row each, then each of its parts, unless you folded it.
private struct WorkstreamBlock: View {
    let workstream: Workstream
    /// Every task card, by id.
    let cards: [Int: TaskCard]

    @AppStorage private var folded: Bool

    init(workstream: Workstream, cards: [Int: TaskCard]) {
        self.workstream = workstream
        self.cards = cards
        _folded = AppStorage(wrappedValue: false, "overview.workstream.\(workstream.id).folded")
    }

    var body: some View {
        let own = workstream.taskIds.compactMap { cards[$0] }
        let parts = workstream.parts.map { part in (part, part.taskIds.compactMap { cards[$0] }) }
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.25)) { folded.toggle() }
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .center, spacing: 8) {
                        Image(systemName: "chevron.right")
                            .font(.zoomed(size: 10, weight: .bold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(folded ? 0 : 90))
                        Text(workstream.name).font(.zoomed(.body).weight(.semibold))
                        TurnDots(cards: own + parts.flatMap(\.1))
                        Spacer(minLength: 8)
                        if workstream.needsYou > 0 {
                            Text("\(workstream.needsYou) need\(workstream.needsYou == 1 ? "s" : "") you")
                                .font(.zoomed(.caption).weight(.semibold))
                                .foregroundStyle(Color.boardOrange)
                        }
                        if workstream.shipped > 0 {
                            Text("\(workstream.shipped) shipped this week")
                                .font(.zoomed(.caption))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    if let summary = workstream.summary {
                        Text(summary)
                            .font(.zoomed(.subheadline))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.leading, 18 * Zoom.shared.scale)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help(folded ? "Show its tasks" : "Fold its tasks away")
            if !folded {
                if !own.isEmpty {
                    RowList { ForEach(own) { OverviewRow(card: $0, detail: nil) } }
                }
                ForEach(parts, id: \.0.id) { part, partCards in
                    WorkstreamPartBlock(part: part, cards: partCards)
                }
            }
        }
    }
}

/// A part of a workstream, set in under it: its name and a dot per open task, then its tasks a row each.
private struct WorkstreamPartBlock: View {
    let part: WorkstreamPart
    let cards: [TaskCard]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .center, spacing: 6) {
                Image(systemName: "arrow.turn.down.right")
                    .font(.zoomed(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
                Text(part.name)
                    .font(.zoomed(.subheadline).weight(.semibold))
                    .foregroundStyle(.secondary)
                TurnDots(cards: cards)
            }
            RowList { ForEach(cards) { OverviewRow(card: $0, detail: nil) } }
        }
        .padding(.leading, 18 * Zoom.shared.scale)
        .padding(.top, 2)
    }
}

/// A dot per task in its turn's color.
private struct TurnDots: View {
    let cards: [TaskCard]

    var body: some View {
        HStack(spacing: 3) {
            ForEach(cards) { card in
                Circle().fill(card.turn.tint).frame(width: 7 * Zoom.shared.scale).help("\(card.ref): \(card.turn.label)")
            }
        }
    }
}

/// A task on one line: whose move it is, its title, where it stands in a few words, and its step
/// forward when it has one. Clicking it shows its details.
private struct OverviewRow: View {
    let card: TaskCard
    /// Said before where it stands, like why it's up next.
    let detail: String?

    @Environment(BoardModel.self) private var model
    @Environment(\.changedTaskIds) private var changedTaskIds
    @State private var hovering = false
    @State private var showingDetails = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: card.turn.symbol)
                .font(.zoomed(.caption))
                .foregroundStyle(card.turn.tint)
                .frame(width: 16 * Zoom.shared.scale)
                // A dot for what moved since you last looked.
                .overlay(alignment: .leading) {
                    if changedTaskIds.contains(card.id) {
                        Circle().fill(Color.boardBlue).frame(width: 5 * Zoom.shared.scale).offset(x: -7 * Zoom.shared.scale)
                    }
                }
                .help(changedTaskIds.contains(card.id) ? "\(card.turn.label) · moved since you last looked" : card.turn.label)
            Text(card.title)
                .font(.zoomed(.subheadline).weight(.medium))
                .truncationMode(.tail)
                .layoutPriority(1)
            Spacer(minLength: 8)
            Text([detail, card.brief ?? card.turn.reason].compactMap(\.self).filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.zoomed(.caption))
                .foregroundStyle(card.turn.needsYou ? AnyShapeStyle(Color.boardOrange) : AnyShapeStyle(.secondary))
                .truncationMode(.tail)
                .frame(maxWidth: 340 * Zoom.shared.scale, alignment: .trailing)
            if let running = card.running {
                Text(running).font(.zoomed(.caption)).foregroundStyle(Color.boardPurple).fixedSize()
            } else if let step = card.steps.first {
                let sending = model.isSending(step, on: .task(card.id))
                let reviewPlan = step.action == "approve-plan" && card.plan != nil
                Button { model.request(step, on: .task(card.id)) } label: {
                    if sending { ProgressView().controlSize(.mini) } else { Text(reviewPlan ? "Review Plan" : step.label) }
                }
                .controlSize(.small)
                .disabled(sending)
                .help(reviewPlan ? "Read \(card.ref)'s plan and approve it" : step.hint)
            }
            CardMenu { TaskMenuItems(card: card) }
        }
        .lineLimit(1)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.primary.opacity(hovering ? 0.05 : 0))
        .contentShape(.rect)
        .onTapGesture { showingDetails = true }
        .popover(isPresented: $showingDetails, arrowEdge: .trailing) { TaskDetailsPopover(card: card, isPresented: $showingDetails) }
        .contextMenu { TaskMenuItems(card: card) }
        .onHover { hovering = $0 }
        .help("Show \(card.ref)'s details and history")
    }
}

import AppKit
import SwiftUI

/// Your tasks as a Kanban board turned on its side: a section per stage, top to bottom in the order
/// work moves, from Ideas to Shipped, so how close each task is to done reads at a glance. Each card
/// says whose move it is. Open sessions no task knows about sit in a strip above the stages.
struct TasksView: View {
    @Environment(BoardModel.self) private var model
    @State private var focusedTaskId: Int?
    @State private var viewportHeight: CGFloat = 0

    var body: some View {
        let columns = model.taskColumns
        let focusedCard = focusedTaskId.flatMap { id in columns.lazy.flatMap(\.cards).first { $0.id == id } }
        let linkFocus = focusedCard.flatMap(TaskLinkFocus.init)
        let untracked = model.untrackedSessions
        if columns.allSatisfy(\.cards.isEmpty) && untracked.isEmpty {
            ContentUnavailableView {
                Label("No tasks yet", systemImage: "checklist")
            } description: {
                Text("Start one here, or ask any agent in relay to track what it's doing. Agents keep each task's stage and status current.")
            } actions: {
                Button("New Task…") { model.composing = true }
                    .buttonStyle(.glass)
                    .controlSize(.large)
            }
        } else {
            ScrollView {
                // Plain, not lazy, for the same reason as the PR board's lanes: a lazy stack can hang the app.
                VStack(alignment: .leading, spacing: 0) {
                    if !untracked.isEmpty {
                        UntrackedStrip(sessions: untracked)
                            .padding(.horizontal, 24)
                            .padding(.vertical, 6)
                    }
                    ForEach(columns) { StageSection(column: $0) }
                }
                .padding(.top, 6)
                .padding(.bottom, linkFocus != nil ? 76 : 16)
                .frame(maxWidth: .infinity, minHeight: viewportHeight, alignment: .topLeading)
                .background {
                    if linkFocus != nil {
                        Color.clear
                            .contentShape(.rect)
                            .onTapGesture {
                                withAnimation(.easeOut(duration: 0.15)) { focusedTaskId = nil }
                            }
                    }
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
            .modifier(TaskConnections(focus: linkFocus, focusedId: $focusedTaskId))
            .overlay(alignment: .bottom) {
                if let linkFocus, let focusedCard {
                    TaskLinkFocusBar(card: focusedCard, focus: linkFocus) {
                        withAnimation(.easeOut(duration: 0.15)) { focusedTaskId = nil }
                    }
                    .padding(.bottom, model.toast == nil ? 22 : 78)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.easeOut(duration: 0.15), value: linkFocus?.id)
            .animation(.spring(duration: 0.35, bounce: 0.2), value: model.toast != nil)
            .onChange(of: linkFocus == nil) { _, cleared in
                if cleared && focusedTaskId != nil { focusedTaskId = nil }
            }
        }
    }
}

/// One stage: its header, then its cards unless it's folded or empty. Clicking the header folds
/// the stage.
private struct StageSection: View {
    let column: TaskColumn
    @AppStorage private var folded: Bool

    init(column: TaskColumn) {
        self.column = column
        // Shipped is history: it starts folded.
        _folded = AppStorage(wrappedValue: column.id == "done", "tasks.\(column.id).folded")
    }

    var body: some View {
        Section {
            if !folded && !column.cards.isEmpty {
                StageCards(column: column).sectionBox(lit: section.lit, tint: column.tint)
            }
        } header: {
            SectionHeader(section: section, folded: $folded)
        }
    }

    /// Ready to ship lights up while it holds anything: it's waiting on you to look.
    private var section: SectionInfo {
        SectionInfo(
            title: column.title, hint: column.hint, symbol: column.symbol, tint: column.tint,
            count: column.cards.count, lit: column.id == "ship" && !column.cards.isEmpty,
            needsYou: column.cards.count { $0.turn.needsYou }
        )
    }
}

/// A stage's cards: Shipped as a list, since there's nothing left to do on them; every other stage
/// as a grid that wraps to the window's width.
private struct StageCards: View {
    let column: TaskColumn

    var body: some View {
        if column.id == "done" {
            RowList { ForEach(column.cards) { DoneRow(card: $0) } }
        } else {
            let zoom = Zoom.shared.scale
            CardGrid(minimum: 260 * zoom, maximum: 380 * zoom, spacing: 10) {
                ForEach(column.cards) { TaskCardView(card: $0) }
            }
        }
    }
}

/// Open sessions no task knows about, folded into one line above the board until you open it.
struct UntrackedStrip: View {
    let sessions: [UntrackedSession]

    @AppStorage("tasks.untracked.open") private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.25)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.zoomed(size: 9, weight: .bold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Image(systemName: "questionmark.circle")
                    Text("\(sessions.count) open session\(sessions.count == 1 ? "" : "s") not tracked as a task")
                    Spacer(minLength: 0)
                }
                .font(.zoomed(.callout).weight(.medium))
                .foregroundStyle(.secondary)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .help(open ? "Hide them" : "Show them, to track one as a task or say it isn't one")
            if open {
                RowList { ForEach(sessions) { UntrackedRow(session: $0) } }
            }
        }
    }
}

/// One task, in the same shape on every card: what it is, whose move it is and why, then labeled
/// rows in a fixed order (Update, Plan, Delivered, PRs; a row shows when it has something to say),
/// then its session and its one step forward. It fills the height it's offered, the extra above the
/// footer, so a row of cards is one height and their footers line up. Clicking it shows its details
/// and history.
struct TaskCardView: View {
    let card: TaskCard

    @Environment(\.taskLinkFocus) private var linkFocus
    @Environment(\.taskLinkFocusId) private var focusedTaskId
    @State private var hovering = false
    @State private var showingDetails = false

    var body: some View {
        let waitsOn = card.unshippedWaitsOn
        let blocks = card.unshippedBlocks
        let linked = card.hasUnshippedLinks
        let focus = linkFocus
        let role = focus?.role(of: card.id) ?? .unrelated
        VStack(alignment: .leading, spacing: 9) {
            VStack(alignment: .leading, spacing: 5) {
                header(focus: focus, role: role)
                Text(card.title)
                    .font(.zoomed(.body).weight(.semibold))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .help(card.title)
            }
            TurnLine(turn: card.turn)
            if linked { DependencyLine(card: card, waitsOn: waitsOn, blocks: blocks) }
            if let plan = card.plan, plan.awaiting {
                PlanNote(card: card, plan: plan)
            }
            if let finish = card.finish, finish.awaiting {
                DeliveryNote(card: card, finish: finish)
            }
            TaskRows(card: card)
            Spacer(minLength: 0)
            if card.session != nil || !card.steps.isEmpty || card.running != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Divider()
                    if let session = card.session { TaskSessionLine(card: card, session: session) }
                    TaskStepSlot(card: card)
                }
                .padding(.top, 2)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .padding(12)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(color: .black.opacity(hovering ? 0.14 : 0.06), radius: hovering ? 6 : 2, y: hovering ? 3 : 1)
        }
        .overlay {
            let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
            if let focus, role != .unrelated {
                shape.strokeBorder(taskColor(focus.hue), lineWidth: 2)
            } else {
                shape.strokeBorder(card.turn.needsYou ? card.turn.tint.opacity(hovering ? 0.6 : 0.4) : Color.primary.opacity(hovering ? 0.14 : 0.07), lineWidth: 1)
            }
        }
        // While you look at one task's links, the cards it has nothing to do with step back.
        .opacity(focus != nil && role == .unrelated ? 0.35 : 1)
        .contentShape(.rect(cornerRadius: 12))
        .onTapGesture {
            if focus != nil && role == .unrelated {
                withAnimation(.easeOut(duration: 0.15)) { focusedTaskId.wrappedValue = nil }
            } else {
                showingDetails = true
            }
        }
        .popover(isPresented: $showingDetails, arrowEdge: .trailing) { TaskDetailsPopover(card: card, isPresented: $showingDetails) }
        .anchorPreference(key: TaskLinkAnchors.self, value: .bounds) { bounds in
            linked ? [card.id: bounds] : [:]
        }
        .onHover { hovering = $0 }
        .onDisappear { if focusedTaskId.wrappedValue == card.id { focusedTaskId.wrappedValue = nil } }
        .animation(.easeOut(duration: 0.15), value: hovering)
        .help(focus != nil && role == .unrelated ? "Click to clear link focus" : "Show \(card.ref)'s details and history")
        .contextMenu { TaskMenuItems(card: card) }
    }

    private func header(focus: TaskLinkFocus?, role: TaskLinkRole) -> some View {
        HStack(spacing: 6) {
            Circle().fill(taskColor(card.hue)).frame(width: 7 * Zoom.shared.scale)
            Text(card.ref)
                .fontWeight(.medium)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Spacer(minLength: 4)
            // While another task's links are shown, the time gives way to how this card relates to it.
            if let focus, role == .prerequisite || role == .dependent {
                TaskLinkBadge(focus: focus, role: role)
            } else {
                Text(card.updatedAt, format: .relative(presentation: .numeric, unitsStyle: .narrow))
                    .foregroundStyle(.tertiary)
                    .help("Last update")
            }
            CardMenu { TaskMenuItems(card: card) }
        }
        .font(.zoomed(.caption))
        .lineLimit(1)
    }
}

/// A task's color down a card's left edge: its own card's, and its PRs' on the PR board.
struct TaskEdge: View {
    let hue: Int

    var body: some View {
        RoundedRectangle(cornerRadius: 2, style: .continuous)
            .fill(taskColor(hue))
            .frame(width: 3 * Zoom.shared.scale)
            .padding(.vertical, 12)
            .padding(.leading, 1)
            .allowsHitTesting(false)
    }
}

/// The task a PR is part of, on its PR card: a dot in the task's color and its id.
struct TaskChipView: View {
    let chip: TaskChip

    var body: some View {
        HStack(spacing: 3) {
            Circle().fill(taskColor(chip.hue)).frame(width: 6 * Zoom.shared.scale)
            Text(chip.ref).monospacedDigit()
        }
        .font(.zoomed(size: 9, weight: .semibold))
        .lineLimit(1)
        .foregroundStyle(taskColor(chip.hue))
        .padding(.horizontal, 5)
        .padding(.vertical, 1.5)
        .background(taskColor(chip.hue).opacity(0.12), in: .rect(cornerRadius: 4))
        .help("Part of \(chip.ref): \(chip.title)")
    }
}

/// Whose move it is, as a colored pill, then what exactly it waits on and for how long.
private struct TurnLine: View {
    let turn: Turn

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Label(turn.label, systemImage: turn.symbol)
                .font(.zoomed(.caption).weight(.semibold))
                .foregroundStyle(turn.tint)
                .lineLimit(1)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(turn.tint.opacity(0.14), in: .capsule)
                .fixedSize()
            if let text = detail {
                Text(text)
                    .font(.zoomed(.subheadline))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }

    /// "Plan ready for your approval · 12m", or just "12m".
    private var detail: String? {
        switch (turn.reason, turn.since) {
        case (let reason?, let since?): "\(reason) · \(since)"
        case (let reason?, nil): reason
        case (nil, let since?): since
        case (nil, nil): nil
        }
    }
}

/// The card's labeled rows, always in this order: the agent's latest update, its plan, an earlier
/// delivery, and its PRs. Labels sit in a column of their own, values beside them, like a PR card's.
private struct TaskRows: View {
    let card: TaskCard

    var body: some View {
        // Shown unwrapped above while waiting on you; once approved, informational, or sent back, stays a quiet row.
        let quietPlan = card.plan.flatMap { $0.awaiting ? nil : $0 }
        let earlierDelivery = card.finish.flatMap { $0.awaiting ? nil : $0 }
        if card.status != nil || quietPlan != nil || earlierDelivery != nil || !card.prs.isEmpty {
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 5) {
                if let status = card.status {
                    GridRow(alignment: .firstTextBaseline) {
                        RowLabel(symbol: "text.bubble", text: "Update")
                        StatusText(status: status)
                    }
                }
                if let plan = quietPlan {
                    GridRow(alignment: .firstTextBaseline) {
                        RowLabel(symbol: "list.number", text: "Plan")
                        NoteLine(
                            kind: .plan,
                            state: plan.approved ? "Approved" : "Written",
                            waiting: false,
                            card: card
                        )
                    }
                }
                if earlierDelivery != nil {
                    GridRow(alignment: .firstTextBaseline) {
                        RowLabel(symbol: "gift", text: "Delivered")
                        NoteLine(
                            kind: .delivery,
                            state: "Sent back",
                            waiting: false,
                            card: card
                        )
                    }
                }
                if !card.prs.isEmpty {
                    GridRow(alignment: .firstTextBaseline) {
                        RowLabel(symbol: "arrow.triangle.pull", text: "PRs")
                        VStack(alignment: .leading, spacing: 3) { PRLines(prs: card.prs) }
                    }
                }
            }
            .font(.zoomed(.subheadline))
        }
    }
}

/// A row's label: a symbol in a fixed box, so every label's text starts at the same place.
private struct RowLabel: View {
    let symbol: String
    let text: String

    var body: some View {
        HStack(alignment: .center, spacing: 5) {
            Image(systemName: symbol).frame(width: 16 * Zoom.shared.scale, alignment: .center)
            Text(text).lineLimit(1).fixedSize()
        }
        .foregroundStyle(.secondary)
        .gridColumnAlignment(.leading)
    }
}

/// The latest report, in the agent's words, or relay's when it filled in for an agent that forgot.
private struct StatusText: View {
    let status: TaskStatus

    var body: some View {
        Text("\(Text(status.text).foregroundStyle(.primary.opacity(0.85)))  \(Text(status.auto ? "\(status.ago) · auto" : status.ago).foregroundStyle(.tertiary))")
            .lineLimit(3)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .help(status.auto ? "Relay filled this in from the session because the agent didn't report it" : "")
    }
}

/// A note's row value: where it stands; clicking opens the full reader sheet.
private struct NoteLine: View {
    let kind: ViewedNote.Kind
    let state: String
    let waiting: Bool
    let card: TaskCard

    @Environment(BoardModel.self) private var model
    @State private var hovering = false

    var body: some View {
        Button { model.viewingNote = ViewedNote(taskId: card.id, kind: kind) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(state)
                    .foregroundStyle(waiting ? AnyShapeStyle(Color.boardOrange) : AnyShapeStyle(.secondary))
                Image(systemName: "arrow.up.right").font(.zoomed(size: 8, weight: .bold)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(Color.primary.opacity(hovering ? 0.07 : 0), in: .rect(cornerRadius: 5))
            .padding(.horizontal, -4)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .pointerStyle(.link)
        .help(kind == .plan ? "Read the plan" : "Read the delivery note")
    }
}

/// The agent's plan, previewed right on the card while it waits for your approval. Clicking opens
/// the full Markdown reader sheet where you can review and approve it.
struct PlanNote: View {
    let card: TaskCard
    let plan: Plan

    @Environment(BoardModel.self) private var model
    @State private var hovering = false

    var body: some View {
        Button { model.viewingNote = ViewedNote(taskId: card.id, kind: .plan) } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "doc.text.fill")
                    Text("Plan")
                    if let since = card.turn.since {
                        Text(verbatim: "· \(since)").foregroundStyle(Color.boardBlue.opacity(0.75))
                    }
                    Spacer(minLength: 4)
                    HStack(spacing: 3) {
                        Text("Read full plan")
                        Image(systemName: "arrow.up.right").font(.zoomed(size: 8, weight: .bold))
                    }
                    .font(.zoomed(.caption).weight(.medium))
                    .opacity(hovering ? 1 : 0.72)
                }
                .font(.zoomed(.subheadline).weight(.semibold))
                .foregroundStyle(Color.boardBlue)
                Text(markdownPreview(plan.text))
                    .font(.zoomed(.subheadline))
                    .foregroundStyle(.primary.opacity(0.85))
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color.boardBlue.opacity(hovering ? 0.14 : 0.08), in: .rect(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(Color.boardBlue.opacity(hovering ? 0.32 : 0.16), lineWidth: 1)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .pointerStyle(.link)
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help("Read \(card.ref)'s full plan")
    }
}

/// What the agent delivered, unwrapped right on its card: when, and the start of its note on what
/// it did and how it checked, to look over before you ship it. Clicking opens the full reader sheet.
struct DeliveryNote: View {
    let card: TaskCard
    let finish: Finish

    @Environment(BoardModel.self) private var model
    @State private var hovering = false

    var body: some View {
        Button { model.viewingNote = ViewedNote(taskId: card.id, kind: .delivery) } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "gift.fill")
                    Text("Delivered")
                    if let since = card.turn.since {
                        Text(verbatim: "· \(since)").foregroundStyle(Color.boardGreen.opacity(0.75))
                    }
                    Spacer(minLength: 4)
                    HStack(spacing: 3) {
                        Text("Read it all")
                        Image(systemName: "arrow.up.right").font(.zoomed(size: 8, weight: .bold))
                    }
                    .font(.zoomed(.caption).weight(.medium))
                    .opacity(hovering ? 1 : 0.72)
                }
                .font(.zoomed(.subheadline).weight(.semibold))
                .foregroundStyle(Color.boardGreen)
                Text(markdownPreview(finish.text ?? "The agent didn't say what it did."))
                    .font(.zoomed(.subheadline))
                    .foregroundStyle(.primary.opacity(0.85))
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color.boardGreen.opacity(hovering ? 0.14 : 0.09), in: .rect(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(Color.boardGreen.opacity(hovering ? 0.32 : 0.16), lineWidth: 1)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .pointerStyle(.link)
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help("Read what the agent did and how it checked")
    }
}

/// Markdown read as a few plain lines for card previews: headings and list markers dropped, inline
/// styling (bold, code) kept.
private func markdownPreview(_ text: String) -> AttributedString {
    let lines = text.split(whereSeparator: \.isNewline).compactMap { line -> String? in
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("```") else { return nil }
        return trimmed.replacing(/^(#+|[-*+]|\d+[.)])\s+/, with: "")
    }
    let plain = lines.joined(separator: "\n")
    return (try? AttributedString(markdown: plain, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(plain)
}

/// The task's PRs, a line each with where it is on the PR board; clicking one opens it.
private struct PRLines: View {
    let prs: [TaskPR]
    private let shown = 3

    var body: some View {
        ForEach(prs.prefix(shown)) { PRLine(pr: $0) }
        if prs.count > shown {
            Text("+\(prs.count - shown) more")
                .font(.zoomed(.caption).weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.leading, 4)
                .help(prs.dropFirst(shown).map(\.ref).joined(separator: ", "))
        }
    }
}

private struct PRLine: View {
    let pr: TaskPR

    @Environment(\.openURL) private var openURL
    @State private var hovering = false

    var body: some View {
        Button { openURL(pr.url) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                // A long repo name gives way before where the PR is, which is the point of the line.
                Text(verbatim: "\(pr.repoName)#\(pr.number)").fontWeight(.medium).monospacedDigit().lineLimit(1).truncationMode(.middle)
                ToneDot(tone: pr.tone, running: false)
                Text(pr.state).foregroundStyle(pr.tone.textStyle).lineLimit(1).fixedSize()
                Image(systemName: "arrow.up.right").font(.zoomed(size: 8, weight: .bold)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(Color.primary.opacity(hovering ? 0.07 : 0), in: .rect(cornerRadius: 5))
            .padding(.horizontal, -4)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .pointerStyle(.link)
        .help("\(pr.title) — open on GitHub")
    }
}

/// The task's session, on a row of its own: clicking it shows the session in your terminal.
private struct TaskSessionLine: View {
    let card: TaskCard
    let session: TaskSession

    @Environment(BoardModel.self) private var model
    @State private var hovering = false

    var body: some View {
        let sending = model.isSending(session.open, on: .task(card.id))
        Button {
            model.request(session.open, on: .task(card.id))
        } label: {
            HStack(spacing: 6) {
                if sending {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "terminal").imageScale(.medium).foregroundStyle(.secondary)
                }
                Text(session.title).lineLimit(1).truncationMode(.tail)
                if session.others > 0 {
                    Text("+\(session.others)").foregroundStyle(.secondary).help("\(session.others) more session\(session.others == 1 ? "" : "s") on this task")
                }
                if session.state != .open {
                    Text(session.state == .working ? "working" : "closed")
                        .foregroundStyle(session.state == .working ? Color.boardAmber : Color.secondary)
                }
                Spacer(minLength: 0)
            }
            .font(.zoomed(.caption))
            .foregroundStyle(.primary.opacity(0.85))
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(Color.primary.opacity(hovering ? 0.08 : 0), in: .rect(cornerRadius: 6))
            .padding(.horizontal, -6)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(session.open.hint)
        .disabled(sending)
    }
}

/// The task's next steps, or in their place what the agent is doing. The first is the way forward,
/// a full-width button; any other (Not Yet beside Ship It) sits at its side, quieter.
struct TaskStepSlot: View {
    let card: TaskCard

    var body: some View {
        Group {
            if let running = card.running {
                RunningLabel(text: running).transition(.blurReplace)
            } else if let primary = card.steps.first {
                HStack(spacing: 6) {
                    StepButton(step: displayStep(primary, for: card), target: .task(card.id))
                    ForEach(card.steps.dropFirst(), id: \.self) { SecondaryStepButton(step: $0, target: .task(card.id)) }
                }
            }
        }
        .animation(.smooth(duration: 0.3), value: card.running)
    }

    /// `approve-plan` opens the plan reader sheet first, so label the card button honestly.
    private func displayStep(_ step: BoardAction, for card: TaskCard) -> BoardAction {
        guard step.action == "approve-plan", card.plan != nil else { return step }
        var copy = step
        copy.label = "Review & Approve"
        copy.hint = "Read \(card.ref)'s plan and approve it"
        return copy
    }
}

/// A task's actions, in its "…" menu and its right-click menu alike.
struct TaskMenuItems: View {
    let card: TaskCard

    @Environment(BoardModel.self) private var model
    @Environment(\.taskLinkFocus) private var linkFocus
    @Environment(\.taskLinkFocusId) private var focusedTaskId

    var body: some View {
        if card.plan != nil {
            Button("View Plan", systemImage: "doc.text") { model.viewingNote = ViewedNote(taskId: card.id, kind: .plan) }
        }
        if let session = card.session {
            Button(session.open.label, systemImage: "terminal") { model.request(session.open, on: .task(card.id)) }
        }
        ForEach(card.steps.filter { $0.action != "open" }, id: \.self) { step in
            let label = step.action == "approve-plan" && card.plan != nil ? "Review & Approve Plan…" : (step.confirm == nil ? step.label : "\(step.label)…")
            Button(label, systemImage: step.symbol) { model.request(step, on: .task(card.id)) }
        }
        Button("Copy ID", systemImage: "number") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(card.ref, forType: .string)
        }
        if card.hasUnshippedLinks && card.stage != "done" {
            let focused = linkFocus?.id == card.id
            Button(focused ? "Hide Links" : "Show Links", systemImage: "point.3.connected.trianglepath.dotted") {
                withAnimation(.easeOut(duration: 0.15)) {
                    focusedTaskId.wrappedValue = focused ? nil : card.id
                }
            }
        }
        if card.dependsOn != nil {
            Button("Dependencies…", systemImage: "link") { model.editingDependencies = card }
        }
        Divider()
        ForEach(card.menu, id: \.self) { item in
            Button(item.label, systemImage: item.symbol, role: item.confirm?.destructive == true ? .destructive : nil) { model.request(item, on: .task(card.id)) }
        }
    }
}

/// Everything about a task: what you asked for, where it stands, and its history.
struct TaskDetailsPopover: View {
    let card: TaskCard
    @Binding var isPresented: Bool

    @Environment(BoardModel.self) private var model
    @Environment(\.taskLinkFocus) private var linkFocus
    @Environment(\.taskLinkFocusId) private var focusedTaskId

    var body: some View {
        let waitsOn = card.unshippedWaitsOn
        let blocks = card.unshippedBlocks
        let isFocused = linkFocus?.id == card.id
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(card.ref).foregroundStyle(.secondary).monospacedDigit()
                Spacer()
                Text(card.stageLabel).fontWeight(.semibold).foregroundStyle(taskColor(card.hue))
            }
            Text(card.title).font(.zoomedHeadline).fixedSize(horizontal: false, vertical: true)
            if let details = card.details {
                MarkdownText(text: details).foregroundStyle(.secondary)
            }
            TurnLine(turn: card.turn)
            if !waitsOn.isEmpty || !blocks.isEmpty {
                Divider()
                TaskDetailsDependencies(
                    card: card,
                    waitsOn: waitsOn,
                    blocks: blocks,
                    isFocused: isFocused,
                    toggleBoardFocus: {
                        isPresented = false
                        withAnimation(.easeOut(duration: 0.15)) { focusedTaskId.wrappedValue = isFocused ? nil : card.id }
                    },
                    edit: {
                        isPresented = false
                        model.editingDependencies = card
                    }
                )
            }
            if let plan = card.plan {
                Divider()
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("Plan").font(.zoomed(.callout).weight(.semibold)).foregroundStyle(.secondary)
                    Text(plan.awaiting ? "Needs approval" : plan.approved ? "Approved" : "Written")
                        .font(.zoomed(.caption).weight(.medium))
                        .foregroundStyle(plan.awaiting ? Color.boardOrange : plan.approved ? Color.boardGreen : .secondary)
                    Spacer()
                    Button("Read Plan", systemImage: "arrow.up.right") {
                        isPresented = false
                        model.viewingNote = ViewedNote(taskId: card.id, kind: .plan)
                    }
                    .buttonStyle(.borderless)
                    .font(.zoomed(.caption).weight(.medium))
                }
                Button {
                    isPresented = false
                    model.viewingNote = ViewedNote(taskId: card.id, kind: .plan)
                } label: {
                    Text(markdownPreview(plan.text))
                        .foregroundStyle(.primary.opacity(0.85))
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(Color.primary.opacity(0.04), in: .rect(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .pointerStyle(.link)
                .help("Open the full plan reader")
            }
            if let finish = card.finish, let text = finish.text {
                Divider()
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("What the agent delivered").font(.zoomed(.callout).weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Open Full", systemImage: "arrow.up.right") {
                        isPresented = false
                        model.viewingNote = ViewedNote(taskId: card.id, kind: .delivery)
                    }
                    .buttonStyle(.borderless)
                    .font(.zoomed(.caption).weight(.medium))
                }
                MarkdownText(text: text)
            }
            Divider()
            Text("History").font(.zoomed(.callout).weight(.semibold)).foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(card.history.enumerated()), id: \.offset) { _, item in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(item.at, format: .relative(presentation: .numeric, unitsStyle: .narrow))
                                .foregroundStyle(.tertiary)
                                .frame(width: 64 * Zoom.shared.scale, alignment: .leading)
                            Text(item.text).fixedSize(horizontal: false, vertical: true)
                            if item.auto {
                                Text("auto").foregroundStyle(.tertiary).help("Relay filled this in from the session because the agent didn't report it")
                            }
                            Spacer(minLength: 0)
                            Text(item.stage).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .frame(maxHeight: 320)
            .scrollBounceBehavior(.basedOnSize)
        }
        .font(.zoomed(.subheadline))
        .padding(16)
        .frame(width: 420 * Zoom.shared.scale)
    }
}

/// Rows on one rounded surface, a divider between each, for sections with little to say per item.
struct RowList<Rows: View>: View {
    @ViewBuilder let rows: Rows

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: rows) { subviews in
                ForEach(Array(subviews.enumerated()), id: \.offset) { index, subview in
                    if index > 0 { Divider().padding(.horizontal, 12) }
                    subview
                }
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

/// An open session no task knows about: what it's called, where, and whether it's working, with
/// Track, which asks it to register its task. Clicking it shows the session; its "…" menu and
/// right-click menu also close it.
private struct UntrackedRow: View {
    let session: UntrackedSession

    @Environment(BoardModel.self) private var model
    @State private var hovering = false

    var body: some View {
        let target = ActionTarget.session(session.sessionFile)
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "terminal").foregroundStyle(.secondary)
            Text(session.title)
                .font(.zoomed(.subheadline).weight(.medium))
                .truncationMode(.tail)
            if let folder = session.folder {
                Text(folder).font(.zoomed(.caption)).foregroundStyle(.tertiary).truncationMode(.head)
            }
            Spacer(minLength: 8)
            Text(session.state == "idle" ? session.activeAgo.map { "idle · \($0)" } ?? "idle" : session.state == "asking" ? "asking you" : "working")
                .font(.zoomed(.caption))
                .foregroundStyle(session.state == "idle" ? AnyShapeStyle(.tertiary) : AnyShapeStyle(Color.boardAmber))
                .fixedSize()
            Button {
                model.request(session.track, on: target)
            } label: {
                if model.isSending(session.track, on: target) { ProgressView().controlSize(.mini) } else { Text(session.track.label) }
            }
            .controlSize(.small)
            .disabled(session.state != "idle" || model.isSending(session.track, on: target))
            .help(session.state == "asking" ? "It's asking you something; answer it, then track it" : session.state == "working" ? "It's working; track it once it's idle" : session.track.hint)
            CardMenu { menuItems(target) }
        }
        .lineLimit(1)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.primary.opacity(hovering ? 0.05 : 0))
        .contentShape(.rect)
        .onTapGesture { model.request(session.open, on: target) }
        .contextMenu { menuItems(target) }
        .onHover { hovering = $0 }
        .help(session.open.hint)
    }

    @ViewBuilder private func menuItems(_ target: ActionTarget) -> some View {
        Button(session.open.label, systemImage: "terminal") { model.request(session.open, on: target) }
        Button(session.dismiss.label, systemImage: session.dismiss.symbol) { model.request(session.dismiss, on: target) }
        if let close = session.close {
            Divider()
            Button(close.confirm == nil ? close.label : "\(close.label)…", systemImage: close.symbol, role: .destructive) { model.request(close, on: target) }
        }
    }
}

/// A finished task on a line of its own; clicking it shows its details.
private struct DoneRow: View {
    let card: TaskCard

    @State private var hovering = false
    @State private var showingDetails = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "checkmark").font(.zoomed(size: 9, weight: .bold)).foregroundStyle(Color.boardGreen.opacity(0.7))
            Text(card.ref).font(.zoomed(.caption)).monospacedDigit().foregroundStyle(.secondary).fixedSize()
            Text(card.title).font(.zoomed(.subheadline).weight(.medium)).truncationMode(.tail).help(card.title)
            Spacer(minLength: 8)
            if let ago = card.turn.reason {
                Text(ago).font(.zoomed(.caption)).foregroundStyle(.tertiary).fixedSize().help("Shipped \(ago)")
            }
            CardMenu { TaskMenuItems(card: card) }
        }
        .lineLimit(1)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.primary.opacity(hovering ? 0.05 : 0))
        .contentShape(.rect)
        .onTapGesture { showingDetails = true }
        .popover(isPresented: $showingDetails, arrowEdge: .bottom) { TaskDetailsPopover(card: card, isPresented: $showingDetails) }
        .onHover { hovering = $0 }
        .contextMenu { TaskMenuItems(card: card) }
    }
}

/// Jots down a task: what you want done (relay titles it from that) and whether you
/// approve its plan first. Start (⌘↩) opens a session on it right away; Save as Idea keeps it for later.
struct NewTaskSheet: View {
    @Environment(BoardModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var details = ""
    @State private var screenshots: [Screenshot] = []
    @State private var approvePlan = true
    /// The model and thinking level its sessions start on; nil keeps omp's default. They start on
    /// the last ones picked for a new task, kept in `lastModel`/`lastLevel` ("" for omp's default).
    @State private var chosenModel: String?
    @State private var chosenLevel: String?
    @AppStorage("newTaskModel") private var lastModel = ""
    @AppStorage("newTaskThinkingLevel") private var lastLevel = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("New Task")
                        .font(.zoomed(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                        .kerning(0.6)
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.zoomed(size: 10, weight: .bold))
                            .foregroundStyle(.secondary)
                            .frame(width: 22 * Zoom.shared.scale, height: 22 * Zoom.shared.scale)
                            .background(.quaternary.opacity(0.6), in: .circle)
                            .contentShape(.circle)
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.cancelAction)
                    .help("Close (Esc)")
                }
                // No title to write: relay names the task from what you say here.
                DetailsEditor(text: $details, placeholder: "What do you want done? Add context, links, what done looks like. Paste or drop screenshots here too.", focusOnAppear: true, onSubmit: { submit(start: true) }) { pasted in
                    screenshots += pasted
                }
                .frame(minHeight: 200 * Zoom.shared.scale)
                if !screenshots.isEmpty { screenshotStrip }
                options
            }
            .padding(.horizontal, 28)
            .padding(.top, 24)
            .padding(.bottom, 18)
            Divider()
            actions
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
        }
        .font(.zoomed(.body))
        .frame(width: 640 * Zoom.shared.scale)
        .onAppear {
            chosenModel = lastModel.isEmpty ? nil : lastModel
            chosenLevel = lastLevel.isEmpty ? nil : lastLevel
        }
        .onChange(of: chosenModel) { lastModel = chosenModel ?? "" }
        .onChange(of: chosenLevel) { lastLevel = chosenLevel ?? "" }
        .task {
            await model.loadModelChoices()
            // A remembered model omp no longer offers falls back to its default.
            if let choices = model.modelChoices, let chosen = chosenModel, choices.option(chosen) == nil {
                chosenModel = nil
                chosenLevel = nil
            }
        }
    }

    /// The task's options as chips under the details. They wrap onto another line rather than crowd
    /// the buttons when a long model name (or a smaller zoom) leaves too little room.
    private var options: some View {
        FlowLayout(spacing: 8) {
            Toggle(isOn: $approvePlan) {
                Label("Approve plan first", systemImage: approvePlan ? "checkmark.circle.fill" : "circle")
                    .lineLimit(1)
            }
            .toggleStyle(ChipToggleStyle())
            .fixedSize()
            .help("Review the agent's plan on the board before it starts the work")
            modelChip
        }
        .controlSize(.large)
    }

    /// Its two ways in, on a row of their own so they always show in full: keep it as an idea, or start it.
    private var actions: some View {
        HStack(spacing: 10) {
            Spacer(minLength: 0)
            if model.isCreating { ProgressView().controlSize(.small) }
            Button { submit(start: false) } label: {
                Label("Save as Idea", systemImage: "lightbulb")
                    .font(.zoomed(.body).weight(.medium))
                    .padding(.horizontal, 2)
            }
            .buttonStyle(.glass)
            .fixedSize()
            .disabled(!ready)
            .help("Keep it in Ideas without starting a session")
            Button { submit(start: true) } label: {
                HStack(spacing: 6) {
                    Label("Start", systemImage: "play.fill")
                        .font(.zoomed(.body).weight(.semibold))
                    Text("⌘↩").font(.zoomed(.callout)).opacity(0.65)
                }
                .padding(.horizontal, 2)
            }
            .buttonStyle(SolidCapsuleButtonStyle())
            .fixedSize()
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(!ready)
            .help("Open a session on it now (⌘↩)")
        }
        .lineLimit(1)
        .controlSize(.large)
    }

    /// The model and thinking level its sessions start on.
    @ViewBuilder private var modelChip: some View {
        if let choices = model.modelChoices {
            ModelChip(choices: choices, model: $chosenModel, level: $chosenLevel, help: "The model and thinking level its sessions start on")
        }
    }

    private var ready: Bool { !details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isCreating }

    private func submit(start: Bool) {
        guard ready else { return }
        let images = screenshots.map { NewTask.Image(base64: $0.data.base64EncodedString(), mimeType: $0.mimeType) }
        let task = NewTask(details: details, images: images, approvePlan: approvePlan, start: start, model: chosenModel, thinkingLevel: chosenLevel)
        Task {
            if await model.create(task) { dismiss() }
        }
    }

    /// The pasted screenshots as thumbnails, each with a button to take it back out.
    private var screenshotStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(screenshots) { screenshot in
                    Image(nsImage: screenshot.image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 96, height: 64)
                        .clipShape(.rect(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
                        .overlay(alignment: .topTrailing) {
                            Button { screenshots.removeAll { $0.id == screenshot.id } } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .buttonStyle(.plain)
                            .padding(4)
                            .help("Remove this screenshot")
                        }
                }
            }
        }
        .scrollIndicators(.never)
    }
}

/// A session's model and thinking level, picked in a finder like omp's `/switch` (⇧⌘M opens it).
/// For a session yet to start, `offersDefault` adds omp's own default (nil) to both lists, and the
/// chip stays untinted while it's on them, so a choice you made stands out. For one already
/// running, it shows what it runs on and switches it.
struct ModelChip: View {
    let choices: ModelChoices
    @Binding var model: String?
    @Binding var level: String?
    var offersDefault = true
    let help: String
    @State private var picking = false

    var body: some View {
        Button { picking.toggle() } label: {
            Label(label, systemImage: "cpu")
                .lineLimit(1)
                .modifier(Chip(on: offersDefault && (model != nil || level != nil)))
        }
        .buttonStyle(.plain)
        .keyboardShortcut("m", modifiers: [.command, .shift])
        .fixedSize()
        .help("\(help) (⇧⌘M)")
        .popover(isPresented: $picking, arrowEdge: .bottom) {
            ModelPicker(choices: choices, model: $model, level: $level, offersDefault: offersDefault) { picking = false }
        }
    }

    /// "Opus 5.5 · Medium": what it runs on, defaults filled in.
    private var label: String {
        let selector = model ?? choices.defaults.model
        let option = choices.option(selector)
        let name = option?.shortName ?? selector?.split(separator: "/").last.map(String.init) ?? "Default model"
        guard let level = level ?? choices.defaults.thinkingLevel, option?.thinkingLevels.isEmpty == false else { return name }
        return "\(name) · \(ModelOption.levelLabel(level))"
    }
}

/// A small capsule for a new task's options: tinted with the accent color when it's set.
private struct Chip: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        content
            .font(.zoomed(.callout).weight(.medium))
            .foregroundStyle(on ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(on ? AnyShapeStyle(.tint.opacity(0.15)) : AnyShapeStyle(.quaternary.opacity(0.6)), in: .capsule)
            .contentShape(.capsule)
    }
}

/// Lays its views out left to right, starting a new line whenever the next one wouldn't fit.
private struct FlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let lines = lines(for: subviews, width: proposal.width ?? .infinity)
        let width = lines.map(\.width).max() ?? 0
        let height = lines.map(\.height).reduce(0, +) + spacing * CGFloat(max(lines.count - 1, 0))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in lines(for: subviews, width: bounds.width) {
            var x = bounds.minX
            for index in line.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (line.height - size.height) / 2), proposal: .unspecified)
                x += size.width + spacing
            }
            y += line.height + spacing
        }
    }

    private struct Line {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func lines(for subviews: Subviews, width maxWidth: CGFloat) -> [Line] {
        var lines: [Line] = []
        var line = Line()
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            let needed = line.indices.isEmpty ? size.width : line.width + spacing + size.width
            if needed > maxWidth, !line.indices.isEmpty {
                lines.append(line)
                line = Line()
            }
            line.width = line.indices.isEmpty ? size.width : line.width + spacing + size.width
            line.height = max(line.height, size.height)
            line.indices.append(index)
        }
        if !line.indices.isEmpty { lines.append(line) }
        return lines
    }
}

/// A toggle drawn as a `Chip` that flips when clicked.
private struct ChipToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            configuration.label.modifier(Chip(on: configuration.isOn))
        }
        .buttonStyle(.plain)
    }
}

/// A sheet's main button: solid tinted capsule that dims only while it can't be pressed. Glass's
/// prominent style fades whenever the window isn't the active one, which made Start look disabled.
struct SolidCapsuleButtonStyle: ButtonStyle {
    var tint: Color = .accentColor
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(tint.opacity(configuration.isPressed ? 0.8 : 1), in: .capsule)
            .shadow(color: tint.opacity(isEnabled ? 0.35 : 0), radius: 6, y: 2)
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(.capsule)
    }
}

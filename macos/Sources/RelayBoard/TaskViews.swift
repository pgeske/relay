import AppKit
import SwiftUI

/// Your tasks, section by section in the order the server sends, grouped by who moves next: your
/// move (ready to ship, needs you), in motion (agent working, waiting on others), parked (paused,
/// ideas), then sessions no task knows about, then what shipped. A gap sets each group apart.
/// `project` narrows it to one project's tasks.
struct TasksView: View {
    let project: Project?

    @Environment(BoardModel.self) private var model

    var body: some View {
        let lanes = shownLanes
        if lanes.allSatisfy({ $0.cards.isEmpty && $0.sessions.isEmpty }) {
            ContentUnavailableView {
                Label(project.map { "No tasks in \($0.name)" } ?? "No tasks yet", systemImage: "checklist")
            } description: {
                Text("Start one here, or ask any agent in relay to track what it's doing. Agents keep each task's stage and status current.")
            } actions: {
                Button("New Task…") { model.composing = true }
                    .buttonStyle(.glass)
                    .controlSize(.large)
            }
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    ForEach(lanes) { lane in
                        if Self.groupStarts.contains(lane.id) {
                            Color.clear.frame(height: 14 * Zoom.shared.scale)
                        }
                        TaskSection(lane: lane)
                    }
                }
                .padding(.top, 6)
                .padding(.bottom, 16)
            }
        }
    }

    /// The sections with only the project's tasks and its subprojects'; sessions no task knows about belong to no project.
    private var shownLanes: [TaskLane] {
        guard let project else { return model.taskLanes }
        return model.taskLanes.compactMap { lane in
            guard lane.id != "untracked" else { return nil }
            var lane = lane
            lane.cards = lane.cards.filter { card in card.project.map { project.ids.contains($0.id) } ?? false }
            return lane
        }
    }

    /// The first section of each group after the first.
    private static let groupStarts: Set<String> = ["working", "paused", "untracked", "done"]
}

/// One section: its header, then its cards (or sessions) unless it's folded or empty.
private struct TaskSection: View {
    let lane: TaskLane
    @AppStorage private var folded: Bool

    init(lane: TaskLane) {
        self.lane = lane
        // Done is history, and what's paused or untracked can wait: they start folded, however full.
        _folded = AppStorage(wrappedValue: ["done", "paused", "untracked"].contains(lane.id), "tasks.\(lane.id).folded")
    }

    var body: some View {
        let count = lane.cards.count + lane.sessions.count
        let lit = lane.hot && count > 0
        Section {
            if !folded && count > 0 {
                content.sectionBox(lit: lit, tint: lane.tint)
            }
        } header: {
            SectionHeader(section: SectionInfo(title: lane.title, hint: lane.hint, symbol: lane.symbol, tint: lane.tint, count: count, lit: lit), folded: $folded)
        }
    }

    @ViewBuilder private var content: some View {
        if lane.id == "untracked" {
            RowList { ForEach(lane.sessions) { UntrackedRow(session: $0) } }
        } else if lane.id == "done" {
            RowList { ForEach(lane.cards) { DoneRow(card: $0) } }
        } else {
            let zoom = Zoom.shared.scale
            CardGrid(minimum: 260 * zoom, maximum: 380 * zoom, spacing: 10) {
                ForEach(lane.cards) { TaskCardView(card: $0, sectionTitle: lane.title) }
            }
        }
    }
}

/// One task: what it is, how far along, why it's in its section, what its agent said last, its
/// plan and PRs, then its session and its one step forward. Clicking it shows its details and history.
struct TaskCardView: View {
    let card: TaskCard
    /// The title of the section the card sits in, so the card doesn't repeat it ("Agent working").
    let sectionTitle: String

    @State private var hovering = false
    @State private var showingDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 9) {
                VStack(alignment: .leading, spacing: 5) {
                    header
                    // One line, so every card's stage bar sits at the same height; hover shows the rest.
                    Text(card.title)
                        .font(.zoomed(.body).weight(.semibold))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .help(card.title)
                }
                StageBar(card: card)
                if let finish = card.finish, finish.awaiting {
                    DeliveryNote(card: card, finish: finish)
                } else if card.reason.text != sectionTitle {
                    ReasonLine(reason: card.reason)
                }
                if let status = card.status {
                    StatusText(status: status)
                }
                let earlierDelivery = card.finish.flatMap { $0.awaiting ? nil : $0 }
                if card.plan != nil || earlierDelivery != nil || !card.prs.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        if let plan = card.plan {
                            NoteLine(
                                note: Note(symbol: "list.number", title: "Plan", text: plan.text, at: plan.at, steps: ["approve-plan"]),
                                state: plan.awaiting ? "waiting for your approval" : plan.approved ? "approved" : "written",
                                waiting: plan.awaiting,
                                card: card
                            )
                        }
                        // Delivered once and sent back, or more work reported since: still worth a look.
                        if let finish = earlierDelivery {
                            NoteLine(
                                note: Note(symbol: "gift", title: "Last delivery", text: finish.text ?? "The agent didn't say what it did.", at: finish.at, steps: []),
                                state: "sent back",
                                waiting: false,
                                card: card
                            )
                        }
                        PRLines(prs: card.prs)
                    }
                    .font(.zoomed(.subheadline))
                }
            }
            Spacer(minLength: 0)
            if card.session != nil || !card.steps.isEmpty || card.running != nil {
                VStack(alignment: .leading, spacing: 10) {
                    Divider()
                    VStack(alignment: .leading, spacing: 8) {
                        if let session = card.session { TaskSessionLine(card: card, session: session) }
                        TaskStepSlot(card: card)
                    }
                }
                .padding(.top, 10)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .padding(12)
        .padding(.leading, 2)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(color: delivered ? Color.boardGreen.opacity(hovering ? 0.3 : 0.16) : .black.opacity(hovering ? 0.14 : 0.06), radius: hovering ? 6 : delivered ? 4 : 2, y: hovering ? 3 : 1)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(delivered ? Color.boardGreen.opacity(hovering ? 0.55 : 0.35) : Color.primary.opacity(hovering ? 0.14 : 0.07), lineWidth: 1)
        }
        .contentShape(.rect(cornerRadius: 12))
        .onTapGesture { showingDetails = true }
        .popover(isPresented: $showingDetails, arrowEdge: .trailing) { TaskDetailsPopover(card: card) }
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.15), value: hovering)
        .help("Show \(card.ref)'s details and history")
        .contextMenu { TaskMenuItems(card: card) }
    }

    /// Its agent delivered and it waits for you to ship it: the card wears the section's green.
    private var delivered: Bool { card.finish?.awaiting == true }

    private var header: some View {
        HStack(spacing: 6) {
            Text(card.ref)
                .fontWeight(.medium)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            if let project = card.project { ProjectChip(project: project) }
            Spacer(minLength: 4)
            Text(card.updatedAt, format: .relative(presentation: .numeric, unitsStyle: .narrow))
                .foregroundStyle(.tertiary)
                .help("Last update")
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

/// The project a task belongs to, as a small muted chip; hovering shows its full path.
private struct ProjectChip: View {
    let project: ProjectRef

    var body: some View {
        Label(project.name, systemImage: "folder")
            .labelStyle(.titleAndIcon)
            .font(.zoomed(size: 9, weight: .semibold))
            .lineLimit(1)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(Color.primary.opacity(0.07), in: .rect(cornerRadius: 4))
            .help("Project: \(project.path)")
    }
}

/// How far along the task is: a segment per stage, filled up to the current one, and its name.
private struct StageBar: View {
    let card: TaskCard

    var body: some View {
        let color = taskColor(card.hue)
        HStack(spacing: 8) {
            HStack(spacing: 3) {
                ForEach(card.stages, id: \.id) { stage in
                    Capsule()
                        .fill(stage.state == .todo ? AnyShapeStyle(.quaternary) : AnyShapeStyle(color.opacity(stage.state == .current ? 1 : 0.45)))
                        .frame(height: 4 * Zoom.shared.scale)
                        .help(stage.label)
                }
            }
            Text(card.stageLabel)
                .font(.zoomed(.caption).weight(.semibold))
                .foregroundStyle(card.stage == "idea" ? AnyShapeStyle(.secondary) : AnyShapeStyle(color))
                .fixedSize()
        }
    }
}

/// Why the task is in its section: on a tinted line when it waits on someone, else quietly.
private struct ReasonLine: View {
    let reason: Reason

    var body: some View {
        let quiet = reason.tone == .muted || reason.tone == .ghost
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: symbol)
            Text(reason.text).fixedSize(horizontal: false, vertical: true)
            if let since = reason.since {
                Text(verbatim: "· \(since)").foregroundStyle(quiet ? AnyShapeStyle(.tertiary) : AnyShapeStyle(reason.tone.color.opacity(0.75)))
            }
        }
        .font(.zoomed(.subheadline).weight(.medium))
        .foregroundStyle(reason.tone.textStyle)
        .padding(.horizontal, quiet ? 0 : 6)
        .padding(.vertical, quiet ? 0 : 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(quiet ? Color.clear : reason.tone.color.opacity(0.1), in: .rect(cornerRadius: 6))
    }

    private var symbol: String {
        switch reason.tone {
        case .warn: "hand.raised.fill"
        case .wait: "hourglass"
        case .ok: "checkmark.circle.fill"
        case .link: "sparkle.magnifyingglass"
        case .bad: "exclamationmark.octagon.fill"
        case .muted, .ghost: "pause.circle"
        }
    }
}

/// The agent's latest report, in its words.
private struct StatusText: View {
    let status: TaskStatus

    var body: some View {
        Text("\(Text(status.text).foregroundStyle(.primary.opacity(0.85)))  \(Text(status.ago).foregroundStyle(.tertiary))")
            .font(.zoomed(.subheadline))
            .lineLimit(3)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Something the agent wrote for you to read: its plan, or why it says the task is done.
private struct Note: Hashable {
    var symbol: String
    var title: String
    var text: String
    var at: Date
    /// The card's steps its popover offers while they're on the card, like Approve Plan.
    var steps: [String]
}

/// A note on a line, with where it stands; clicking shows it, with its steps while they wait for you.
private struct NoteLine: View {
    let note: Note
    let state: String
    let waiting: Bool
    let card: TaskCard

    @State private var hovering = false
    @State private var showing = false

    var body: some View {
        Button { showing = true } label: {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Image(systemName: note.symbol).frame(width: 14 * Zoom.shared.scale)
                Text(note.title).fontWeight(.medium)
                Text(state)
                    .foregroundStyle(waiting ? AnyShapeStyle(Color.boardOrange) : AnyShapeStyle(.secondary))
                Image(systemName: "chevron.down").font(.zoomed(size: 7, weight: .bold)).foregroundStyle(.secondary)
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
        .help("Show the \(note.title.lowercased())")
        .popover(isPresented: $showing, arrowEdge: .bottom) { NotePopover(note: note, card: card, isPresented: $showing) }
    }
}

/// What the agent delivered, unwrapped right on its card: when, and the start of its note on what
/// it did and how it checked, to look over before you ship it. Clicking it shows the whole note,
/// with Ship It and Not Yet.
private struct DeliveryNote: View {
    let card: TaskCard
    let finish: Finish

    @State private var hovering = false
    @State private var showing = false

    var body: some View {
        Button { showing = true } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "gift.fill")
                    Text("Delivered")
                    if let since = card.reason.since {
                        Text(verbatim: "· \(since)").foregroundStyle(Color.boardGreen.opacity(0.75))
                    }
                    Spacer(minLength: 4)
                    Text("Read it all").font(.zoomed(.caption)).opacity(hovering ? 1 : 0)
                }
                .font(.zoomed(.subheadline).weight(.semibold))
                .foregroundStyle(Color.boardGreen)
                Text(preview)
                    .font(.zoomed(.subheadline))
                    .foregroundStyle(.primary.opacity(0.85))
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Color.boardGreen.opacity(hovering ? 0.14 : 0.09), in: .rect(cornerRadius: 8))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .pointerStyle(.link)
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help("Read what the agent did and how it checked")
        .popover(isPresented: $showing, arrowEdge: .bottom) {
            NotePopover(note: Note(symbol: "gift", title: "Delivered", text: text, at: finish.at, steps: ["ship", "send-back"]), card: card, isPresented: $showing)
        }
    }

    private var text: String { finish.text ?? "The agent didn't say what it did." }

    /// The note's Markdown read as a few plain lines: headings and list markers dropped, inline
    /// styling (bold, code) kept.
    private var preview: AttributedString {
        let lines = text.split(whereSeparator: \.isNewline).compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("```") else { return nil }
            return trimmed.replacing(/^(#+|[-*+]|\d+[.)])\s+/, with: "")
        }
        let plain = lines.joined(separator: "\n")
        return (try? AttributedString(markdown: plain, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(plain)
    }
}

/// A note as the agent wrote it, with its steps (Approve Plan; Ship It, Not Yet) while they wait for you.
private struct NotePopover: View {
    let note: Note
    let card: TaskCard
    @Binding var isPresented: Bool

    @Environment(BoardModel.self) private var model

    var body: some View {
        let steps = card.steps.filter { note.steps.contains($0.action) }
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(note.title).font(.zoomedHeadline)
                Text(card.ref).foregroundStyle(.secondary)
                Spacer()
                Text(note.at, format: .relative(presentation: .named)).foregroundStyle(.secondary)
            }
            Text(card.title).font(.zoomed(.callout)).foregroundStyle(.secondary)
            Divider()
            ScrollView { MarkdownText(text: note.text) }
                .frame(maxHeight: 420)
                .scrollBounceBehavior(.basedOnSize)
            if !steps.isEmpty {
                HStack {
                    Spacer()
                    // The first step is the way forward; the rest come before it, as macOS lays out buttons.
                    ForEach(steps.dropFirst().reversed(), id: \.self) { step in
                        Button(step.label) { run(step) }
                    }
                    if let primary = steps.first {
                        Button(primary.label) { run(primary) }.keyboardShortcut(.defaultAction)
                    }
                }
            }
        }
        .font(.zoomed(.body))
        .padding(16)
        .frame(width: 520 * Zoom.shared.scale)
    }

    private func run(_ step: BoardAction) {
        isPresented = false
        // The popover already showed the note: acting on it here needs no second ask.
        var direct = step
        direct.confirm = nil
        model.request(direct, on: .task(card.id))
    }
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
                .padding(.leading, 14 * Zoom.shared.scale + 5)
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
                Image(systemName: "arrow.triangle.pull").frame(width: 14 * Zoom.shared.scale).foregroundStyle(.secondary)
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

/// The task's session, on a row of its own: clicking it opens the session.
private struct TaskSessionLine: View {
    let card: TaskCard
    let session: TaskSession

    @Environment(BoardModel.self) private var model
    @State private var hovering = false

    var body: some View {
        let sending = model.isSending(session.open, on: .task(card.id))
        Button { model.request(session.open, on: .task(card.id)) } label: {
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
private struct TaskStepSlot: View {
    let card: TaskCard

    var body: some View {
        Group {
            if let running = card.running {
                RunningLabel(text: running).transition(.blurReplace)
            } else if let primary = card.steps.first {
                HStack(spacing: 6) {
                    StepButton(step: primary, target: .task(card.id))
                    ForEach(card.steps.dropFirst(), id: \.self) { SecondaryStepButton(step: $0, target: .task(card.id)) }
                }
            }
        }
        .animation(.smooth(duration: 0.3), value: card.running)
    }
}

/// A task's actions, in its "…" menu and its right-click menu alike.
struct TaskMenuItems: View {
    let card: TaskCard

    @Environment(BoardModel.self) private var model

    var body: some View {
        if let session = card.session {
            Button(session.open.label, systemImage: "terminal") { model.request(session.open, on: .task(card.id)) }
        }
        ForEach(card.steps.filter { $0.action != "open" }, id: \.self) { step in
            Button(step.confirm == nil ? step.label : "\(step.label)…", systemImage: step.symbol) { model.request(step, on: .task(card.id)) }
        }
        Button("Copy ID", systemImage: "number") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(card.ref, forType: .string)
        }
        Divider()
        ForEach(card.menu, id: \.self) { item in
            Button(item.label, systemImage: item.symbol, role: item.confirm?.destructive == true ? .destructive : nil) { model.request(item, on: .task(card.id)) }
        }
    }
}

/// Everything about a task: what you asked for, where it stands, and its history.
private struct TaskDetailsPopover: View {
    let card: TaskCard

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(card.ref).foregroundStyle(.secondary).monospacedDigit()
                if let project = card.project { ProjectChip(project: project) }
                Spacer()
                Text(card.stageLabel).fontWeight(.semibold).foregroundStyle(taskColor(card.hue))
            }
            Text(card.title).font(.zoomedHeadline).fixedSize(horizontal: false, vertical: true)
            if let details = card.details {
                MarkdownText(text: details).foregroundStyle(.secondary)
            }
            ReasonLine(reason: card.reason)
            if let finish = card.finish, let text = finish.text {
                Divider()
                Text("What the agent delivered").font(.zoomed(.callout).weight(.semibold)).foregroundStyle(.secondary)
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
private struct RowList<Rows: View>: View {
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
            Text(session.state == "working" ? "working" : session.activeAgo.map { "idle · \($0)" } ?? "idle")
                .font(.zoomed(.caption))
                .foregroundStyle(session.state == "working" ? AnyShapeStyle(Color.boardAmber) : AnyShapeStyle(.tertiary))
                .fixedSize()
            Button {
                model.request(session.track, on: target)
            } label: {
                if model.isSending(session.track, on: target) { ProgressView().controlSize(.mini) } else { Text(session.track.label) }
            }
            .controlSize(.small)
            .disabled(session.state == "working" || model.isSending(session.track, on: target))
            .help(session.state == "working" ? "It's working; track it once it's idle" : session.track.hint)
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
            Circle().fill(taskColor(card.hue)).frame(width: 7 * Zoom.shared.scale)
            Text(card.ref).font(.zoomed(.caption)).monospacedDigit().foregroundStyle(.secondary).fixedSize()
            Text(card.title).font(.zoomed(.subheadline).weight(.medium)).truncationMode(.tail)
            if let project = card.project { ProjectChip(project: project) }
            Spacer(minLength: 8)
            Text(card.reason.text).font(.zoomed(.caption)).foregroundStyle(.tertiary).fixedSize()
            CardMenu { TaskMenuItems(card: card) }
        }
        .lineLimit(1)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.primary.opacity(hovering ? 0.05 : 0))
        .contentShape(.rect)
        .onTapGesture { showingDetails = true }
        .popover(isPresented: $showingDetails, arrowEdge: .bottom) { TaskDetailsPopover(card: card) }
        .onHover { hovering = $0 }
        .contextMenu { TaskMenuItems(card: card) }
    }
}

/// Jots down a task: what you want done, anything the agent should know, its project, and whether you
/// approve its plan first. Start (⌘↩) opens a session on it right away; Save as Idea keeps it for later.
struct NewTaskSheet: View {
    let project: Project?

    @Environment(BoardModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var details = ""
    @State private var screenshots: [Screenshot] = []
    @State private var projectName = ""
    /// Typing a new project's name, in place of the project chip.
    @State private var namingProject = false
    @State private var approvePlan = true
    /// The model and thinking level its sessions start on; nil keeps omp's default.
    @State private var chosenModel: String?
    @State private var chosenLevel: String?
    @FocusState private var focus: Field?

    private enum Field { case title, projectName }

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
                TextField("Task", text: $title, prompt: Text("What do you want done?"), axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.zoomed(size: 22, weight: .semibold))
                    .lineLimit(1...3)
                    .focused($focus, equals: .title)
                DetailsEditor(text: $details, placeholder: "Anything the agent should know: context, links, what done looks like. Paste or drop screenshots here too.", onSubmit: { submit(start: true) }) { pasted in
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
            projectName = project?.path ?? ""
            focus = .title
        }
        .task { await model.loadModelChoices() }
    }

    /// The task's options as chips under the details. They wrap onto another line rather than crowd
    /// the buttons when a long model or project name (or a smaller zoom) leaves too little room.
    private var options: some View {
        FlowLayout(spacing: 8) {
            projectChip
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
            .buttonStyle(StartButtonStyle())
            .fixedSize()
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(!ready)
            .help("Open a session on it now (⌘↩)")
        }
        .lineLimit(1)
        .controlSize(.large)
    }

    /// The project it goes under: pick one, none, or name a new one in place.
    @ViewBuilder private var projectChip: some View {
        if namingProject {
            TextField("Project", text: $projectName, prompt: Text("New project, or Parent/Child"))
                .textFieldStyle(.plain)
                .focused($focus, equals: .projectName)
                .frame(width: 190)
                .modifier(Chip(on: true))
                .onSubmit { namingProject = false }
                .onChange(of: focus) { if focus != .projectName { namingProject = false } }
        } else {
            Menu {
                Button("None") { projectName = "" }
                if !projects.isEmpty { Divider() }
                ForEach(projects) { project in Button(project.path) { projectName = project.path } }
                Divider()
                Button("New Project…") {
                    projectName = ""
                    namingProject = true
                    focus = .projectName
                }
            } label: {
                Label(projectName.isEmpty ? "No project" : projectName, systemImage: "folder")
                    .lineLimit(1)
                    .modifier(Chip(on: !projectName.isEmpty))
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("The project it goes under")
        }
    }

    /// The model and thinking level its sessions start on, picked like omp's `/switch` and `/effort`.
    /// Untinted while it's omp's default, so a choice you made stands out.
    @ViewBuilder private var modelChip: some View {
        if let choices = model.modelChoices {
            Menu {
                let levels = choices.option(chosenModel ?? choices.defaults.model)?.thinkingLevels ?? []
                if !levels.isEmpty {
                    Section("Thinking") {
                        checkmarkButton("Default", selected: chosenLevel == nil) { chosenLevel = nil }
                        ForEach(levels, id: \.self) { level in
                            checkmarkButton(ModelOption.levelLabel(level), selected: chosenLevel == level) { chosenLevel = level }
                        }
                    }
                }
                Section("Model") {
                    checkmarkButton("Default", selected: chosenModel == nil) { pick(model: nil, in: choices) }
                    ForEach(choices.providers, id: \.self) { provider in
                        Menu(provider) {
                            ForEach(choices.models.filter { $0.provider == provider }) { option in
                                checkmarkButton(option.name, selected: chosenModel == option.selector) { pick(model: option.selector, in: choices) }
                            }
                        }
                    }
                }
            } label: {
                Label(modelLabel(choices), systemImage: "cpu")
                    .lineLimit(1)
                    .modifier(Chip(on: chosenModel != nil || chosenLevel != nil))
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .menuOrder(.fixed)
            .fixedSize()
            .help("The model and thinking level its sessions start on")
        }
    }

    private func checkmarkButton(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            if selected { Label(title, systemImage: "checkmark") } else { Text(title) }
        }
    }

    /// Switching models drops a thinking level the new one doesn't take, like omp's `/switch` would.
    private func pick(model selector: String?, in choices: ModelChoices) {
        chosenModel = selector
        let levels = choices.option(selector ?? choices.defaults.model)?.thinkingLevels ?? []
        if let level = chosenLevel, !levels.contains(level) { chosenLevel = nil }
    }

    /// "Opus 5.5 · Medium": what it'll start on, defaults filled in.
    private func modelLabel(_ choices: ModelChoices) -> String {
        let selector = chosenModel ?? choices.defaults.model
        let option = choices.option(selector)
        let name = option?.shortName ?? selector?.split(separator: "/").last.map(String.init) ?? "Default model"
        let level = chosenLevel ?? choices.defaults.thinkingLevel
        guard let level, option?.thinkingLevels.isEmpty == false else { return name }
        return "\(name) · \(ModelOption.levelLabel(level))"
    }

    /// Every project by its path, so subprojects sit right under their parents.
    private var projects: [Project] {
        (model.board?.tasks?.projects ?? []).sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }

    private var ready: Bool { !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isCreating }

    private func submit(start: Bool) {
        guard ready else { return }
        let images = screenshots.map { NewTask.Image(base64: $0.data.base64EncodedString(), mimeType: $0.mimeType) }
        let task = NewTask(title: title, details: details, images: images, project: projectName, approvePlan: approvePlan, start: start, model: chosenModel, thinkingLevel: chosenLevel)
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

/// The sheet's main button: solid accent color that dims only while it can't be pressed. Glass's
/// prominent style fades whenever the window isn't the active one, which made Start look disabled.
private struct StartButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(Color.accentColor.opacity(configuration.isPressed ? 0.8 : 1), in: .capsule)
            .shadow(color: .accentColor.opacity(isEnabled ? 0.35 : 0), radius: 6, y: 2)
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(.capsule)
    }
}

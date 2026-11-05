import AppKit
import SwiftUI

/// Your tasks, section by section in the order they need you: what's waiting on you first, then
/// what agents are on, what waits on others, what's paused, sessions no task knows about, ideas,
/// and what's done. `project` narrows it to one project's tasks.
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
                    ForEach(lanes) { TaskSection(lane: $0) }
                }
                .padding(.top, 6)
                .padding(.bottom, 16)
            }
        }
    }

    /// The sections with only the project's tasks; sessions no task knows about belong to no project.
    private var shownLanes: [TaskLane] {
        guard let project else { return model.taskLanes }
        return model.taskLanes.compactMap { lane in
            guard lane.id != "untracked" else { return nil }
            var lane = lane
            lane.cards = lane.cards.filter { $0.project?.id == project.id }
            return lane
        }
    }
}

/// One section: its header, then its cards (or sessions) unless it's folded or empty.
private struct TaskSection: View {
    let lane: TaskLane
    @AppStorage private var folded: Bool

    init(lane: TaskLane) {
        self.lane = lane
        // Done is history: it starts folded.
        _folded = AppStorage(wrappedValue: lane.id == "done", "tasks.\(lane.id).folded")
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
                ForEach(lane.cards) { TaskCardView(card: $0) }
            }
        }
    }
}

/// One task: what it is, how far along, why it's in its section, what its agent said last, its
/// plan and PRs, then its session and its one step forward. Clicking it shows its details and history.
struct TaskCardView: View {
    let card: TaskCard

    @State private var hovering = false
    @State private var showingDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 9) {
                VStack(alignment: .leading, spacing: 5) {
                    header
                    Text(card.title)
                        .font(.zoomed(.body).weight(.semibold))
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                StageBar(card: card)
                ReasonLine(reason: card.reason)
                if let status = card.status {
                    StatusText(status: status)
                }
                if card.plan != nil || !card.prs.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        if let plan = card.plan { PlanLine(plan: plan, card: card) }
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
                .shadow(color: .black.opacity(hovering ? 0.14 : 0.06), radius: hovering ? 6 : 2, y: hovering ? 3 : 1)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(hovering ? 0.14 : 0.07), lineWidth: 1)
        }
        .overlay(alignment: .leading) { TaskEdge(hue: card.hue) }
        .contentShape(.rect(cornerRadius: 12))
        .onTapGesture { showingDetails = true }
        .popover(isPresented: $showingDetails, arrowEdge: .trailing) { TaskDetailsPopover(card: card) }
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.15), value: hovering)
        .help("Show \(card.ref)'s details and history")
        .contextMenu { TaskMenuItems(card: card) }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text(card.ref)
                .fontWeight(.medium)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            if let project = card.project { ProjectChip(name: project.name) }
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

/// The project a task belongs to, as a small muted chip.
private struct ProjectChip: View {
    let name: String

    var body: some View {
        Label(name, systemImage: "folder")
            .labelStyle(.titleAndIcon)
            .font(.zoomed(size: 9, weight: .semibold))
            .lineLimit(1)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(Color.primary.opacity(0.07), in: .rect(cornerRadius: 4))
            .help("Project: \(name)")
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

/// The task's plan, and whether it waits for you; clicking shows it, with Approve while it waits.
private struct PlanLine: View {
    let plan: Plan
    let card: TaskCard

    @State private var hovering = false
    @State private var showing = false

    var body: some View {
        Button { showing = true } label: {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Image(systemName: "list.number").frame(width: 14 * Zoom.shared.scale)
                Text("Plan").fontWeight(.medium)
                Text(plan.awaiting ? "waiting for your approval" : plan.approved ? "approved" : "written")
                    .foregroundStyle(plan.awaiting ? AnyShapeStyle(Color.boardOrange) : AnyShapeStyle(.secondary))
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
        .help("Show the plan")
        .popover(isPresented: $showing, arrowEdge: .bottom) { PlanPopover(plan: plan, card: card, isPresented: $showing) }
    }
}

/// The plan as the agent wrote it, with Approve Plan while it waits for you.
private struct PlanPopover: View {
    let plan: Plan
    let card: TaskCard
    @Binding var isPresented: Bool

    @Environment(BoardModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("Plan").font(.zoomedHeadline)
                Text(card.ref).foregroundStyle(.secondary)
                Spacer()
                Text(plan.at, format: .relative(presentation: .named)).foregroundStyle(.secondary)
            }
            Text(card.title).font(.zoomed(.callout)).foregroundStyle(.secondary)
            Divider()
            ScrollView { MarkdownText(text: plan.text) }
                .frame(maxHeight: 420)
                .scrollBounceBehavior(.basedOnSize)
            if let approve = card.steps.first(where: { $0.action == "approve-plan" }) {
                HStack {
                    Spacer()
                    Button("Approve Plan") {
                        isPresented = false
                        // The popover already showed the plan: approving here needs no second ask.
                        var direct = approve
                        direct.confirm = nil
                        model.request(direct, on: .task(card.id))
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
        }
        .font(.zoomed(.body))
        .padding(16)
        .frame(width: 460 * Zoom.shared.scale)
    }
}

/// Agents write a little Markdown (code spans, bold, links); line breaks are theirs too.
private struct MarkdownText: View {
    let text: String

    var body: some View {
        let markdown = try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        Text(markdown ?? AttributedString(text))
            .textSelection(.enabled)
            .lineSpacing(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
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

/// The task's next step, a full-width button, or in its place what the agent is doing.
private struct TaskStepSlot: View {
    let card: TaskCard

    var body: some View {
        Group {
            if let running = card.running {
                RunningLabel(text: running).transition(.blurReplace)
            } else {
                ForEach(card.steps, id: \.self) { StepButton(step: $0, target: .task(card.id)) }
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
                if let project = card.project { ProjectChip(name: project.name) }
                Spacer()
                Text(card.stageLabel).fontWeight(.semibold).foregroundStyle(taskColor(card.hue))
            }
            Text(card.title).font(.zoomedHeadline).fixedSize(horizontal: false, vertical: true)
            if let details = card.details {
                MarkdownText(text: details).foregroundStyle(.secondary)
            }
            ReasonLine(reason: card.reason)
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
            if let project = card.project { ProjectChip(name: project.name) }
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

/// Jots down a task: what you want done, and optionally where, under which project, and whether you
/// approve its plan first. Start opens a session on it right away; Save as Idea keeps it for later.
struct NewTaskSheet: View {
    let project: Project?

    @Environment(BoardModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var details = ""
    @State private var projectName = ""
    @State private var folder = ""
    @State private var approvePlan = true
    @FocusState private var titleFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Form {
                TextField("Task", text: $title, prompt: Text("What do you want done?"))
                    .focused($titleFocused)
                TextField("Details", text: $details, prompt: Text("Anything the agent should know (optional)"), axis: .vertical)
                    .lineLimit(3...8)
                HStack {
                    TextField("Project", text: $projectName, prompt: Text("None"))
                    if !projects.isEmpty {
                        Menu {
                            Button("None") { projectName = "" }
                            Divider()
                            ForEach(projects) { project in Button(project.name) { projectName = project.name } }
                        } label: {
                            Image(systemName: "chevron.up.chevron.down")
                        }
                        .menuStyle(.button)
                        .menuIndicator(.hidden)
                        .fixedSize()
                        .help("Pick a project")
                    }
                }
                HStack {
                    TextField("Folder", text: $folder, prompt: Text("~"))
                    Menu {
                        ForEach(folders, id: \.self) { path in Button(path) { folder = path } }
                        if !folders.isEmpty { Divider() }
                        Button("Choose…") { chooseFolder() }
                    } label: {
                        Image(systemName: "folder")
                    }
                    .menuStyle(.button)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("Where its session starts")
                }
                Toggle("Approve its plan before the agent starts on it", isOn: $approvePlan)
            }
            .formStyle(.grouped)
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                if model.isCreating { ProgressView().controlSize(.small) }
                Button("Save as Idea") { submit(start: false) }
                    .disabled(!ready)
                Button("Start") { submit(start: true) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!ready)
            }
            .padding([.horizontal, .bottom], 20)
        }
        .font(.zoomed(.body))
        .frame(width: 520)
        .onAppear {
            projectName = project?.name ?? ""
            folder = folders.first ?? "~"
            titleFocused = true
        }
    }

    private var projects: [Project] { model.board?.tasks?.projects ?? [] }
    private var folders: [String] {
        let home = URL.homeDirectory.path(percentEncoded: false).replacing(/\/$/, with: "")
        return (model.board?.tasks?.folders ?? []).map { $0 == home ? "~" : $0.hasPrefix(home + "/") ? "~" + $0.dropFirst(home.count) : $0 }
    }

    private var ready: Bool { !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isCreating }

    private func submit(start: Bool) {
        let task = NewTask(title: title, details: details, project: projectName, folder: folder, approvePlan: approvePlan, start: start)
        Task {
            if await model.create(task) { dismiss() }
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        if panel.runModal() == .OK, let url = panel.url { folder = url.path(percentEncoded: false) }
    }
}

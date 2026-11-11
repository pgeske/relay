import AppKit
import SwiftUI

enum SidebarItem: Hashable {
    case tasks
    case project(Int)
    case all
    case lane(String)
}

struct BoardWindow: View {
    @Environment(BoardModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            Sidebar(selection: $model.section)
                .navigationSplitViewColumnWidth(min: 190 * zoom, ideal: 215 * zoom, max: 280 * zoom)
        } detail: {
            BoardContent(selection: model.section ?? .tasks)
                // Centered under the board you're looking at, not the whole window with its sidebar.
                .overlay(alignment: .bottom) { ToastView() }
        }
        // Text without a font of its own, like sidebar rows, follows the zoom too.
        .font(.zoomed(.body))
        .navigationTitle("Relay Board")
        .navigationSubtitle(status)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { model.composing = true } label: {
                    Label("New Task", systemImage: "plus")
                }
                .help("New task (⌘N)")
                .disabled(model.board?.tasks == nil)
            }
            ToolbarItem(placement: .primaryAction) {
                Button { model.refreshNow() } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                        .symbolEffect(.rotate.byLayer, options: .repeat(.continuous), isActive: model.isRefreshing)
                }
                .help("Refresh the board (⌘R)")
            }
        }
        .sheet(isPresented: $model.composing) { NewTaskSheet(project: selectedProject) }
        .overlay { ShipCelebration() }
        .alert(model.confirming?.confirm.title ?? "", isPresented: confirmingBinding, presenting: model.confirming) { pending in
            if pending.confirm.destructive {
                Button(pending.confirm.button, role: .destructive) { model.confirm(pending) }
                Button("Cancel", role: .cancel) {}
            } else {
                Button(pending.confirm.button) { model.confirm(pending) }.keyboardShortcut(.defaultAction)
                Button("Cancel", role: .cancel) {}
            }
        } message: { pending in
            Text(pending.confirm.message)
        }
        .task { model.start() }
    }

    private var zoom: CGFloat { Zoom.shared.scale }

    /// The project the sidebar shows, which a new task starts in.
    private var selectedProject: Project? {
        guard case .project(let id) = model.section else { return nil }
        return model.board?.tasks?.projects.first { $0.id == id }
    }

    private var confirmingBinding: Binding<Bool> {
        Binding(get: { model.confirming != nil }, set: { if !$0 { model.confirming = nil } })
    }

    /// When the board is from, and how soon it refreshes.
    private var status: String {
        guard let updatedAt = model.board?.updatedAt else { return model.isRefreshing ? "Loading…" : "" }
        let time = updatedAt.formatted(date: .omitted, time: .shortened)
        let cadence = model.board?.agentWorking == true ? "every \(model.board?.refreshSeconds ?? 10)s while an agent works" : "every minute"
        return "Updated \(time) · refreshes \(cadence)"
    }
}

private struct Sidebar: View {
    @Binding var selection: SidebarItem?
    @Environment(BoardModel.self) private var model
    @State private var naming: ProjectNaming?
    @State private var draftName = ""
    @State private var deleting: Project?
    /// Projects whose subprojects you folded away.
    @State private var collapsed: Set<Int> = []
    /// A change sent to the server, shown in place with a spinner until the board lists it.
    @State private var change: ProjectChange?

    var body: some View {
        List(selection: $selection) {
            Section("Tasks") {
                Label("All Tasks", systemImage: "checklist")
                    .badge(model.tasksWaitingOnYou)
                    .tag(SidebarItem.tasks)
            }
            Section {
                ForEach(projectLines) { line in
                    ProjectRow(line: line, collapsed: $collapsed, naming: startNaming, deleting: $deleting)
                }
                if projectLines.isEmpty {
                    Text("Group related tasks in a project.")
                        .font(.zoomed(.callout))
                        .foregroundStyle(.tertiary)
                        .selectionDisabled()
                }
            } header: {
                HStack {
                    Text("Projects")
                    Spacer()
                    Button { startNaming(.new(parent: nil)) } label: {
                        Image(systemName: "plus")
                            .font(.zoomed(size: 11, weight: .semibold))
                            .frame(width: 18, height: 18)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.borderless)
                    .disabled(model.board?.tasks == nil)
                    .help("New project")
                }
            }
            Section("Pull Requests") {
                Label("All Lanes", systemImage: "rectangle.grid.1x2")
                    .badge(model.lanes.filter { $0.id != "merged" }.reduce(0) { $0 + $1.cards.count })
                    .tag(SidebarItem.all)
                ForEach(model.lanes) { lane in
                    Label {
                        Text(lane.title)
                    } icon: {
                        Image(systemName: lane.symbol).foregroundStyle(lane.tint)
                    }
                    .badge(lane.cards.count)
                    .tag(SidebarItem.lane(lane.id))
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 6) {
                if model.tasksWaitingOnYou > 0 {
                    Label("\(model.tasksWaitingOnYou) task\(model.tasksWaitingOnYou == 1 ? "" : "s") need\(model.tasksWaitingOnYou == 1 ? "s" : "") you", systemImage: "bell.badge.fill")
                }
                if model.prsWaitingOnYou > 0 {
                    Label("\(model.prsWaitingOnYou) PR\(model.prsWaitingOnYou == 1 ? "" : "s") waiting on you", systemImage: "arrow.triangle.pull")
                }
                Button { startNaming(.new(parent: nil)) } label: {
                    Label("New Project", systemImage: "folder.badge.plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .foregroundStyle(.primary)
                .padding(.top, 4)
                .disabled(model.board?.tasks == nil)
                .help("Group tasks in a new project. Right-click a project for a subproject inside it.")
            }
            .font(.zoomed(.callout).weight(.medium))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18)
            .padding(.bottom, 14)
        }
        .alert(naming?.title ?? "", isPresented: namingBinding, presenting: naming) { naming in
            TextField("Name", text: $draftName)
            Button(naming.button) { save(naming) }
                .keyboardShortcut(.defaultAction)
                .disabled(draftName.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: { naming in
            Text(naming.message)
        }
        .alert("Delete \u{201C}\(deleting?.name ?? "")\u{201D}?", isPresented: deletingBinding, presenting: deleting) { project in
            Button("Delete Project", role: .destructive) { delete(project) }
            Button("Cancel", role: .cancel) {}
        } message: { project in
            if let parent = projects.first(where: { $0.id == project.parentId }) {
                Text("Its tasks and subprojects move up into \(parent.name). No task is deleted.")
            } else {
                Text("Its tasks leave it for no project, and its subprojects move to the top. No task is deleted.")
            }
        }
        .onChange(of: projects) {
            // The board caught up with the change: stop showing it as saving.
            switch change {
            case .creating(_, let path, _):
                guard let made = projects.first(where: { $0.path.caseInsensitiveCompare(path) == .orderedSame }) else { return }
                selection = .project(made.id)
            case .renaming(let id, let name):
                guard projects.contains(where: { $0.id == id && $0.name == name }) else { return }
            case .deleting(let id):
                guard !projects.contains(where: { $0.id == id }) else { return }
            case nil:
                return
            }
            change = nil
        }
    }

    private var projects: [Project] { model.board?.tasks?.projects ?? [] }

    /// The project rows to show, each parent followed by its subprojects unless you folded them away,
    /// with the change on its way to the server shown in place. The server sends projects sorted by name.
    private var projectLines: [ProjectLine] {
        let tree = Dictionary(grouping: projects, by: \.parentId)
        var lines: [ProjectLine] = []
        func add(_ parentId: Int?, depth: Int) {
            for var project in tree[parentId] ?? [] {
                var saving = false
                if case .renaming(project.id, let name) = change { project.name = name; saving = true }
                if case .deleting(project.id) = change { saving = true }
                lines.append(ProjectLine(project: project, depth: depth, hasSubprojects: tree[project.id] != nil, saving: saving))
                if !collapsed.contains(project.id) { add(project.id, depth: depth + 1) }
            }
            if case .creating(let name, let path, parentId) = change {
                let placeholder = Project(id: ProjectLine.placeholderId, name: name, path: path, parentId: parentId, ids: [], open: 0, needsYou: 0)
                lines.append(ProjectLine(project: placeholder, depth: depth, hasSubprojects: false, saving: true))
            }
        }
        add(nil, depth: 0)
        return lines
    }

    private var namingBinding: Binding<Bool> {
        Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })
    }

    private var deletingBinding: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    private func startNaming(_ what: ProjectNaming) {
        if case .rename(let project) = what { draftName = project.name } else { draftName = "" }
        naming = what
    }

    private func save(_ naming: ProjectNaming) {
        let name = draftName.trimmingCharacters(in: .whitespaces)
        Task {
            switch naming {
            case .new(let parent):
                if let parent { collapsed.remove(parent.id) }
                let path = parent.map { "\($0.path)/\(name)" } ?? name
                _ = await send(.creating(name: name, path: path, parentId: parent?.id)) { await model.project("create", name: name, parent: parent?.id) }
            case .rename(let project):
                guard name != project.name else { return }
                _ = await send(.renaming(id: project.id, name: name)) { await model.project("rename", project: project.id, name: name) }
            }
        }
    }

    private func delete(_ project: Project) {
        Task {
            guard await send(.deleting(id: project.id), { await model.project("delete", project: project.id) }) else { return }
            if case .project(let id) = selection, project.ids.contains(id) {
                selection = project.parentId.map { .project($0) } ?? .tasks
            }
        }
    }

    /// Shows `pending` in the sidebar while `request` goes to the server and until the board lists
    /// it; true once the server took it. A board that never catches up stops showing it after 10s.
    private func send(_ pending: ProjectChange, _ request: () async -> Bool) async -> Bool {
        change = pending
        guard await request() else {
            change = nil
            return false
        }
        Task {
            try? await Task.sleep(for: .seconds(10))
            if change == pending { change = nil }
        }
        return true
    }
}

/// A project change sent to the server that the board doesn't show yet.
private enum ProjectChange: Equatable {
    case creating(name: String, path: String, parentId: Int?)
    case renaming(id: Int, name: String)
    case deleting(id: Int)
}

/// What the sidebar is asking you to name: a new project (inside `parent`, for a subproject), or one to rename.
private enum ProjectNaming {
    case new(parent: Project?)
    case rename(Project)

    var title: String {
        switch self {
        case .new(nil): "New Project"
        case .new: "New Subproject"
        case .rename: "Rename Project"
        }
    }

    var message: String {
        switch self {
        case .new(nil): "A project groups related tasks. Right-click it later to add subprojects."
        case .new(let parent?): "It goes inside \(parent.name)."
        case .rename(let project): "Its tasks stay in it; only \(project.name)'s name changes."
        }
    }

    var button: String {
        switch self {
        case .new: "Create"
        case .rename: "Rename"
        }
    }
}

/// A project in the sidebar, indented under its parent. A project with subprojects has a chevron
/// at its end that folds them away; drawn flat rather than with DisclosureGroup, since the
/// sidebar's outline ignores a disclosure's starting state and showed new subprojects folded.
private struct ProjectRow: View {
    let line: ProjectLine
    @Binding var collapsed: Set<Int>
    let naming: (ProjectNaming) -> Void
    @Binding var deleting: Project?

    var body: some View {
        let project = line.project
        if project.id == ProjectLine.placeholderId {
            row.selectionDisabled()
        } else {
            row
                .badge(line.saving ? 0 : project.needsYou > 0 ? project.needsYou : project.open)
                .tag(SidebarItem.project(project.id))
                .help(project.path)
                .contextMenu {
                    Button("New Subproject…") { naming(.new(parent: project)) }
                    Button("Rename…") { naming(.rename(project)) }
                    Divider()
                    Button("Delete…", role: .destructive) { deleting = project }
                }
                .disabled(line.saving)
        }
    }

    private var row: some View {
        let project = line.project
        return HStack(spacing: 6) {
            Label(project.name, systemImage: "folder")
            Spacer(minLength: 0)
            if line.saving {
                ProgressView().controlSize(.small)
            } else if line.hasSubprojects {
                Button {
                    if collapsed.contains(project.id) { collapsed.remove(project.id) } else { collapsed.insert(project.id) }
                } label: {
                    Image(systemName: "chevron.right")
                        .font(.zoomed(size: 9, weight: .bold))
                        .rotationEffect(.degrees(collapsed.contains(project.id) ? 0 : 90))
                        .frame(width: 14, height: 14)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help(collapsed.contains(project.id) ? "Show its subprojects" : "Hide its subprojects")
            }
        }
        .padding(.leading, CGFloat(line.depth) * 16)
        .opacity(line.saving ? 0.6 : 1)
    }
}

/// One row of the sidebar's project tree.
private struct ProjectLine: Identifiable {
    /// The id of the row standing in for a project on its way to the server.
    static let placeholderId = -1

    var project: Project
    var depth: Int
    var hasSubprojects: Bool
    /// Its change is on its way to the server.
    var saving: Bool
    var id: Int { project.id }
}

/// The board, or why there isn't one.
private struct BoardContent: View {
    let selection: SidebarItem
    @Environment(BoardModel.self) private var model

    var body: some View {
        switch selection {
        case .tasks, .project:
            tasksContent
        case .all, .lane:
            pullRequestsContent
        }
    }

    /// Tasks don't need GitHub: they show whenever relay's server answers.
    @ViewBuilder private var tasksContent: some View {
        if model.board?.tasks != nil {
            VStack(spacing: 0) {
                if let failure = model.failure {
                    Banner(text: "\(failure.headline). Showing your tasks as they were.").padding([.horizontal, .top], 16)
                }
                TasksView(project: project)
            }
        } else if let failure = model.failure {
            FailureView(failure: failure)
        } else if model.board != nil {
            ContentUnavailableView {
                Label("relay's server is older than this app", systemImage: "arrow.down.app")
            } description: {
                Text("Tasks need a newer relay. Update it with relay update.")
            }
        } else {
            ProgressView("Loading your tasks…")
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var project: Project? {
        guard case .project(let id) = selection else { return nil }
        return model.board?.tasks?.projects.first { $0.id == id }
    }

    @ViewBuilder private var pullRequestsContent: some View {
        if let board = model.board, !board.lanes.isEmpty {
            VStack(spacing: 0) {
                if let problem = staleBoardProblem(board) {
                    Banner(text: problem).padding([.horizontal, .top], 16)
                }
                lanesView
            }
        } else if let failure = model.failure {
            FailureView(failure: failure)
        } else if let error = model.board?.error {
            ContentUnavailableView {
                Label("Couldn't load the board from GitHub", systemImage: "exclamationmark.icloud")
            } description: {
                Text(error).textSelection(.enabled)
                Text("Relay Board tries again every minute.")
            } actions: {
                Button("Try Again") { model.refreshNow() }
            }
        } else {
            ProgressView("Loading your pull requests…")
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder private var lanesView: some View {
        let lanes = model.lanes
        if lanes.allSatisfy(\.cards.isEmpty) {
            ContentUnavailableView("No pull requests", systemImage: "arrow.triangle.pull", description: Text("Your open pull requests show up here, from draft to merged."))
        } else if case .lane(let id) = selection, let lane = lanes.first(where: { $0.id == id }) {
            LaneGridView(lane: lane)
        } else {
            LanesView(lanes: lanes)
        }
    }

    /// Why the board on screen may be out of date: the server's GitHub fetch failed, or the server stopped answering.
    private func staleBoardProblem(_ board: Board) -> String? {
        let from = board.updatedAt.map { " Showing the board from \($0.formatted(date: .omitted, time: .shortened))." } ?? ""
        if let failure = model.failure {
            return "\(failure.headline).\(from)"
        }
        if let error = board.error {
            return "Couldn't refresh from GitHub: \(error).\(from)"
        }
        return nil
    }
}

private struct Banner: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.zoomed(.callout))
            .foregroundStyle(Color.boardOrange)
            .lineLimit(3)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Color.boardOrange.opacity(0.12), in: .rect(cornerRadius: 12))
    }
}

extension BoardError {
    var headline: String {
        switch self {
        case .serverNotRunning: "relay's server isn't running"
        case .noToken: "Can't read relay's token"
        case .unauthorized: "relay's server didn't accept this app's token"
        case .serverTooOld: "relay's server is older than this app"
        case .server(_, let message): "relay's server had a problem: \(message)"
        }
    }
}

/// No board to show, and what to do about it.
private struct FailureView: View {
    let failure: BoardError
    @Environment(BoardModel.self) private var model

    var body: some View {
        ContentUnavailableView {
            Label(failure.headline, systemImage: symbol)
        } description: {
            Text(explanation)
            if let command {
                CommandLine(command: command).padding(.top, 6)
            }
        } actions: {
            Button("Try Again") { model.refreshNow() }
                .buttonStyle(.glass)
                .controlSize(.large)
        }
    }

    private var symbol: String {
        switch failure {
        case .serverNotRunning: "server.rack"
        case .noToken, .unauthorized: "lock.shield"
        case .serverTooOld: "arrow.down.app"
        case .server: "exclamationmark.triangle"
        }
    }

    private var explanation: String {
        switch failure {
        case .serverNotRunning:
            "The board comes from relay's server on port \(model.client.server.port). Start it in the background, and it starts at every login:"
        case .noToken(let path):
            "Relay Board signs in to relay's server with the token at \(path), which the server creates when it first runs. Start it with:"
        case .unauthorized:
            "The token at \(model.client.server.tokenPath) doesn't match the server's. Restart the server so it reads the current one:"
        case .serverTooOld:
            "This version of relay has no board for the app. Update it:"
        case .server:
            "Relay Board tries again shortly."
        }
    }

    private var command: String? {
        switch failure {
        case .serverNotRunning, .noToken, .unauthorized: "relay server install"
        case .serverTooOld: "relay update"
        case .server: nil
        }
    }
}

/// A command to run in a terminal, with a button that copies it.
private struct CommandLine: View {
    let command: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 10) {
            Text(command).font(.zoomed(.body).monospaced()).textSelection(.enabled)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(command, forType: .string)
                copied = true
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc").contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(.borderless)
            .help("Copy")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .capsule)
    }
}

/// What the server said about the last control, floating over the board for a few seconds.
private struct ToastView: View {
    @Environment(BoardModel.self) private var model

    var body: some View {
        ZStack {
            if let toast = model.toast {
                ToastPill(toast: toast) {
                    if model.toast?.id == toast.id { model.toast = nil }
                }
                .padding(.bottom, 26)
                // Rises out of the bottom edge with a little give, and settles away in place.
                .transition(.asymmetric(
                    insertion: .offset(y: 24).combined(with: .scale(scale: 0.92, anchor: .bottom)).combined(with: .opacity),
                    removal: .scale(scale: 0.96).combined(with: .opacity)
                ))
                .id(toast.id)
            }
        }
        .animation(.spring(duration: 0.45, bounce: 0.3), value: model.toast)
    }
}

/// One toast: its icon in a soft badge of its color, then the message, on a slightly tinted glass pill.
private struct ToastPill: View {
    let toast: Toast
    let dismiss: () -> Void
    @State private var hovering = false
    @State private var shown = false

    private var tint: Color { toast.failed ? .boardRed : .boardGreen }

    var body: some View {
        let zoom = Zoom.shared.scale
        HStack(spacing: 10 * zoom) {
            Image(systemName: toast.failed ? "exclamationmark.triangle.fill" : toast.symbol)
                .font(.zoomed(size: 13, weight: .semibold))
                .foregroundStyle(tint)
                .symbolEffect(.bounce, value: shown)
                .frame(width: 28 * zoom, height: 28 * zoom)
                .background(tint.opacity(0.16), in: .circle)
            Text(toast.message)
                .font(.zoomed(.callout))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 7 * zoom)
        .padding(.trailing, 18 * zoom)
        .padding(.vertical, 7 * zoom)
        .frame(maxWidth: 520 * zoom)
        .glassEffect(.regular.tint(tint.opacity(0.07)).interactive(), in: .capsule)
        .shadow(color: .black.opacity(0.22), radius: 18, y: 8)
        .contentShape(.capsule)
        .onTapGesture(perform: dismiss)
        .onHover { hovering = $0 }
        .onAppear { shown = true }
        // Gone after a few seconds, but never from under the pointer: hovering holds it.
        .task(id: hovering) {
            guard !hovering else { return }
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            dismiss()
        }
    }
}

/// Confetti over the whole window for a task just shipped, unless you asked macOS to reduce motion.
private struct ShipCelebration: View {
    @Environment(BoardModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let shipment = model.shipment, !reduceMotion {
            ConfettiBurst()
                .id(shipment.id)
                .task(id: shipment.id) {
                    try? await Task.sleep(for: .seconds(ConfettiBurst.duration))
                    if model.shipment?.id == shipment.id { model.shipment = nil }
                }
        }
    }
}

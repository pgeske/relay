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
    @State private var selection: SidebarItem? = .tasks

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            Sidebar(selection: $selection)
                .navigationSplitViewColumnWidth(min: 190 * zoom, ideal: 215 * zoom, max: 280 * zoom)
        } detail: {
            BoardContent(selection: selection ?? .tasks)
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
        .overlay(alignment: .bottom) { ToastView() }
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
        guard case .project(let id) = selection else { return nil }
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

    var body: some View {
        List(selection: $selection) {
            Section("Tasks") {
                Label("All Tasks", systemImage: "checklist")
                    .badge(model.tasksWaitingOnYou)
                    .tag(SidebarItem.tasks)
                ForEach(model.board?.tasks?.projects ?? []) { project in
                    Label(project.name, systemImage: "folder")
                        .badge(project.needsYou > 0 ? project.needsYou : project.open)
                        .tag(SidebarItem.project(project.id))
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
            }
            .font(.zoomed(.callout).weight(.medium))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18)
            .padding(.bottom, 14)
        }
    }
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

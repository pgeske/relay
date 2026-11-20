import SwiftUI

/// A card's unshipped links in plain words, "Waits on" and "Blocks", each task as a chip in its
/// color. It names both sides even when the other card is folded or in another project. Clicking
/// it edits them.
struct DependencyLine: View {
    let card: TaskCard
    let waitsOn: [RelatedTask]
    let blocks: [RelatedTask]

    @Environment(BoardModel.self) private var model

    var body: some View {
        Button { model.editingDependencies = card } label: {
            // Both groups on one line when they fit, else one under the other.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { groups }
                VStack(alignment: .leading, spacing: 5) { groups }
            }
            .font(.zoomed(.caption))
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Change \(card.ref)'s dependencies")
    }

    @ViewBuilder private var groups: some View {
        if !waitsOn.isEmpty { group("Waits on", waitsOn) }
        if !blocks.isEmpty { group("Blocks", blocks) }
    }

    private func group(_ label: String, _ tasks: [RelatedTask]) -> some View {
        HStack(spacing: 4) {
            Text(label).foregroundStyle(.secondary).fixedSize()
            ForEach(tasks.prefix(3)) { RelatedTaskChip(task: $0) }
            if tasks.count > 3 { Text("+\(tasks.count - 3)").fontWeight(.semibold).foregroundStyle(.secondary).fixedSize() }
            // A lone link has room to say what the other task is.
            if waitsOn.count + blocks.count == 1 {
                Text(tasks[0].title).foregroundStyle(.secondary).lineLimit(1).layoutPriority(-1)
            }
        }
    }
}

/// Another task named on a card: a dot in its color and its id, like its own card's header.
private struct RelatedTaskChip: View {
    let task: RelatedTask

    var body: some View {
        let color = task.hue.map(taskColor) ?? .secondary
        HStack(spacing: 3) {
            Circle().fill(color).frame(width: 6 * Zoom.shared.scale)
            Text(task.ref).monospacedDigit()
        }
        .fontWeight(.semibold)
        .foregroundStyle(.primary)
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 5)
        .padding(.vertical, 1.5)
        .background(color.opacity(0.16), in: .rect(cornerRadius: 4))
        .help("\(task.ref): \(task.title)")
    }
}

/// On a card linked to the focused task, how the two relate, in the focused task's color.
struct TaskLinkBadge: View {
    let focus: TaskLinkFocus
    let role: TaskLinkRole

    var body: some View {
        Text(role == .prerequisite ? "\(focus.ref) waits on this" : "Waits on \(focus.ref)")
            .fontWeight(.semibold)
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .background(taskColor(focus.hue), in: .capsule)
    }
}

struct DependencySheet: View {
    let card: TaskCard

    @Environment(BoardModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Dependencies").font(.zoomedHeadline)
            Text("\(card.ref) · \(card.title)").foregroundStyle(.secondary)
            TextField("Find a prerequisite by title or ID", text: $query)
                .textFieldStyle(.roundedBorder)
            List {
                if let linked = card.dependsOn, !linked.isEmpty {
                    Section("Depends on") {
                        ForEach(linked) { task in
                            HStack {
                                relationLabel(task)
                                Spacer()
                                Button("Remove") { change(task.id, adding: false) }
                                    .accessibilityLabel("Remove dependency on \(task.ref)")
                            }
                        }
                    }
                }
                if let dependents = card.neededBy, !dependents.isEmpty {
                    Section("Needed by") { ForEach(dependents) { relationLabel($0) } }
                }
                Section("Add a prerequisite") {
                    let choices = candidates
                    if choices.isEmpty { Text("No matching tasks").foregroundStyle(.secondary) }
                    ForEach(choices) { task in
                        HStack {
                            Text(task.ref).monospacedDigit().foregroundStyle(.secondary)
                            Text(task.title).lineLimit(1).help(task.title)
                            Spacer()
                            Button("Add") { change(task.id, adding: true) }
                                .accessibilityLabel("Add dependency on \(task.ref)")
                        }
                    }
                }
            }
            .listStyle(.inset)
            .disabled(sending)
            HStack {
                if let error { Text(error).foregroundStyle(.red) }
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
        .font(.zoomed(.body))
        .padding(18)
        .frame(width: 480 * Zoom.shared.scale, height: 420 * Zoom.shared.scale)
    }

    private func relationLabel(_ task: RelatedTask) -> some View {
        HStack {
            Text(task.ref).monospacedDigit().foregroundStyle(.secondary)
            Text(task.title).lineLimit(1).help(task.title)
            if task.shipped { Text("Shipped").font(.zoomed(.caption)).foregroundStyle(.secondary) }
        }
    }

    private var candidates: [TaskCard] {
        let linked = Set((card.dependsOn ?? []).map(\.id))
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        // Use all projects, not just the sidebar's selection. Shipped tasks can still be found by searching.
        return model.taskColumns.flatMap(\.cards).filter { task in
            task.id != card.id && !linked.contains(task.id) && (search.isEmpty ? task.stage != "done" :
                task.title.localizedCaseInsensitiveContains(search) || task.ref.localizedCaseInsensitiveContains(search))
        }.sorted { $0.id > $1.id }
    }

    private func change(_ prerequisite: Int, adding: Bool) {
        guard !sending else { return }
        sending = true
        Task {
            defer { sending = false }
            if await model.changeDependency(on: card.id, prerequisite: prerequisite, adding: adding) {
                dismiss()
            } else {
                error = model.toast?.message
            }
        }
    }
}

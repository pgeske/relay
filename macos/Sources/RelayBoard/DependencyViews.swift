import SwiftUI

/// Only open prerequisites take space on a card, and never more than one line.
struct DependencyLine: View {
    let card: TaskCard
    let first: RelatedTask
    let others: Int

    @Environment(BoardModel.self) private var model

    var body: some View {
        Button { model.editingDependencies = card } label: {
            HStack(spacing: 4) {
                Image(systemName: "link")
                Text("Depends on \(first.ref)").fontWeight(.medium).fixedSize()
                Text(first.title).lineLimit(1)
                if others > 0 { Text("+\(others)").fontWeight(.semibold).fixedSize() }
            }
            .font(.zoomed(.caption))
            .foregroundStyle(.secondary)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Depends on \(first.ref): \(first.title) — show all dependencies")
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

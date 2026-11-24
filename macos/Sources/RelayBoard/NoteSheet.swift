import AppKit
import SwiftUI

/// Spacious document reader for a task's plan or delivery note, opened from Overview, task cards,
/// details popovers, or clicking Approve Plan. Shows the full Markdown comfortably with its action
/// buttons (Approve Plan, Ship It / Not Yet, Open Session) pinned at the bottom.
struct NoteSheet: View {
    let viewed: ViewedNote
    let windowSize: CGSize

    @Environment(BoardModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var initialRevision: String?
    @State private var copied = false

    private var card: TaskCard? { model.taskCards[viewed.taskId] }

    private struct Content {
        var heading: String
        var badge: String
        var badgeSymbol: String
        var badgeTint: Color
        var text: String
        var at: Date
        var planRevision: String?
        var stepActions: [String]
    }

    private var content: Content? {
        guard let card else { return nil }
        switch viewed.kind {
        case .plan:
            guard let plan = card.plan else { return nil }
            let badge: String
            let symbol: String
            let tint: Color
            if plan.awaiting {
                badge = "Needs approval"
                symbol = "hand.raised.fill"
                tint = .boardOrange
            } else if plan.approved {
                badge = "Approved"
                symbol = "checkmark.circle.fill"
                tint = .boardGreen
            } else {
                badge = "Plan"
                symbol = "list.number"
                tint = .secondary
            }
            return Content(
                heading: "Plan",
                badge: badge,
                badgeSymbol: symbol,
                badgeTint: tint,
                text: plan.text,
                at: plan.at,
                planRevision: plan.revision,
                stepActions: ["approve-plan"]
            )
        case .delivery:
            guard let finish = card.finish else { return nil }
            return Content(
                heading: "Delivered",
                badge: finish.awaiting ? "Ready to ship" : "Sent back",
                badgeSymbol: finish.awaiting ? "gift.fill" : "arrow.uturn.backward",
                badgeTint: finish.awaiting ? .boardGreen : .secondary,
                text: finish.text ?? "The agent didn't say what it did.",
                at: finish.at,
                planRevision: nil,
                stepActions: ["ship", "send-back"]
            )
        }
    }

    var body: some View {
        let zoom = Zoom.shared.scale
        let width = min(max(780 * zoom, 560), max(560, windowSize.width - 80))
        let height = min(max(700 * zoom, 480), max(460, windowSize.height - 80))

        Group {
            if let card, let content {
                let steps = card.steps.filter { content.stepActions.contains($0.action) }
                let revised = content.planRevision != nil && initialRevision != nil && content.planRevision != initialRevision
                VStack(alignment: .leading, spacing: 0) {
                    header(card: card, content: content, revised: revised, zoom: zoom)
                    Divider()
                    ScrollView {
                        MarkdownText(text: content.text, style: .document)
                            .frame(maxWidth: 680 * zoom, alignment: .leading)
                            .padding(.horizontal, 34 * zoom)
                            .padding(.vertical, 24 * zoom)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                    .background(Color(nsColor: .textBackgroundColor))
                    Divider()
                    footer(card: card, content: content, steps: steps, zoom: zoom)
                }
                .onAppear {
                    initialRevision = content.planRevision
                }
            } else {
                ContentUnavailableView("Nothing to show", systemImage: "doc.text")
                    .onAppear { dismiss() }
            }
        }
        .font(.zoomed(.body))
        .frame(width: width, height: height)
    }

    private func header(card: TaskCard, content: Content, revised: Bool, zoom: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 10 * zoom) {
            HStack(alignment: .center, spacing: 8 * zoom) {
                HStack(spacing: 6 * zoom) {
                    Circle().fill(taskColor(card.hue)).frame(width: 8 * zoom, height: 8 * zoom)
                    Text(card.ref)
                        .font(.zoomed(.callout).weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                Label(content.badge, systemImage: content.badgeSymbol)
                    .font(.zoomed(.caption).weight(.semibold))
                    .foregroundStyle(content.badgeTint)
                    .padding(.horizontal, 8 * zoom)
                    .padding(.vertical, 3 * zoom)
                    .background(content.badgeTint.opacity(0.14), in: .capsule)
                Text("·").foregroundStyle(.tertiary)
                Text(content.at, format: .relative(presentation: .named))
                    .font(.zoomed(.callout))
                    .foregroundStyle(.secondary)
                    .help(content.at.formatted(date: .abbreviated, time: .shortened))
                Spacer(minLength: 8)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(content.text, forType: .string)
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.zoomed(.caption).weight(.medium))
                        .foregroundStyle(copied ? AnyShapeStyle(Color.boardGreen) : AnyShapeStyle(.secondary))
                        .contentTransition(.symbolEffect(.replace))
                        .padding(.horizontal, 8 * zoom)
                        .padding(.vertical, 4 * zoom)
                        .background(.quaternary.opacity(0.6), in: .capsule)
                }
                .buttonStyle(.plain)
                .help("Copy the \(content.heading.lowercased()) as Markdown")
                .task(id: copied) {
                    guard copied else { return }
                    try? await Task.sleep(for: .seconds(1.5))
                    copied = false
                }
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.zoomed(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24 * zoom, height: 24 * zoom)
                        .background(.quaternary.opacity(0.6), in: .circle)
                        .contentShape(.circle)
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .help("Close (Esc)")
            }
            Text(card.title)
                .font(.zoomed(.title2).weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
            if revised {
                Label("The agent updated this plan while you were reading. Review the latest version before approving.", systemImage: "exclamationmark.circle.fill")
                    .font(.zoomed(.callout))
                    .foregroundStyle(Color.boardOrange)
                    .padding(.horizontal, 10 * zoom)
                    .padding(.vertical, 6 * zoom)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.boardOrange.opacity(0.12), in: .rect(cornerRadius: 8 * zoom, style: .continuous))
            }
        }
        .padding(.horizontal, 28 * zoom)
        .padding(.top, 20 * zoom)
        .padding(.bottom, 16 * zoom)
    }

    private func footer(card: TaskCard, content: Content, steps: [BoardAction], zoom: CGFloat) -> some View {
        HStack(spacing: 10 * zoom) {
            if let session = card.session {
                let opening = model.isSending(session.open, on: .task(card.id))
                Button {
                    model.request(session.open, on: .task(card.id))
                } label: {
                    HStack(spacing: 6) {
                        if opening { ProgressView().controlSize(.mini) } else { Image(systemName: "terminal") }
                        Text("Open Session")
                    }
                    .font(.zoomed(.body).weight(.medium))
                    .padding(.horizontal, 2)
                }
                .buttonStyle(.glass)
                .disabled(opening)
                .help("Show \(card.ref)'s session in your terminal to discuss or revise this")
            }
            Spacer(minLength: 0)
            if !steps.isEmpty {
                Button("Close") { dismiss() }
                    .buttonStyle(.glass)
                ForEach(steps.dropFirst().reversed(), id: \.self) { step in
                    Button {
                        run(step, on: card, content: content)
                    } label: {
                        Label(step.label, systemImage: step.symbol)
                            .font(.zoomed(.body).weight(.medium))
                            .padding(.horizontal, 2)
                    }
                    .buttonStyle(.glass)
                    .help(step.hint)
                }
                if let primary = steps.first {
                    Button {
                        run(primary, on: card, content: content)
                    } label: {
                        HStack(spacing: 6) {
                            Label(primary.label, systemImage: primary.symbol)
                                .font(.zoomed(.body).weight(.semibold))
                            Text("⌘↩").font(.zoomed(.callout)).opacity(0.75)
                        }
                        .padding(.horizontal, 2)
                    }
                    .buttonStyle(SolidCapsuleButtonStyle(tint: primary.tint))
                    .keyboardShortcut(.return, modifiers: .command)
                    .help("\(primary.hint) (⌘↩)")
                }
            } else {
                Button("Done") { dismiss() }
                    .buttonStyle(.glass)
            }
        }
        .lineLimit(1)
        .controlSize(.large)
        .padding(.horizontal, 24 * zoom)
        .padding(.vertical, 14 * zoom)
    }

    private func run(_ step: BoardAction, on card: TaskCard, content: Content) {
        dismiss()
        if step.action == "approve-plan", let revision = content.planRevision {
            model.approvePlan(step, for: card.id, revision: revision)
        } else {
            // The sheet already showed the note: acting on it here needs no second ask.
            var direct = step
            direct.confirm = nil
            model.request(direct, on: .task(card.id))
        }
    }
}

import AppKit
import SwiftUI

/// One pull request: a header, a few status rows in a fixed order, what needs you, and a footer with
/// the session and the card's next step. Clicking the card opens the PR in the browser; its rows,
/// session, and step buttons act on their own.
struct CardView: View {
    let card: Card
    /// Merged cards recede: there's nothing left to do on them.
    var muted = false

    @Environment(BoardModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 5) {
                header
                Text(card.title)
                    .font(.zoomed(.body).weight(.semibold))
                    .foregroundStyle(muted ? .secondary : .primary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !card.rows.isEmpty {
                StatusRows(card: card)
            }
            if !card.notices.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(card.notices, id: \.self) { NoticeLine(notice: $0, card: card) }
                }
            }
            if card.session != nil || !card.steps.isEmpty || card.running != nil {
                Divider()
                Footer(card: card)
            }
        }
        .padding(12)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(color: .black.opacity(hovering ? 0.14 : 0.06), radius: hovering ? 6 : 2, y: hovering ? 3 : 1)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(hovering ? 0.14 : 0.07), lineWidth: 1)
        }
        .overlay(alignment: .topTrailing) {
            if hovering, let close = card.close { closeButton(close) }
        }
        .contentShape(.rect(cornerRadius: 12))
        .onTapGesture { openURL(card.url) }
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.15), value: hovering)
        .help("Open \(card.ref) on GitHub")
        .contextMenu { menu }
    }

    private var header: some View {
        HStack(spacing: 6) {
            HStack(spacing: 3) {
                Text(card.repoName).fontWeight(.medium)
                Text(verbatim: "#\(card.number)").monospacedDigit()
            }
            .foregroundStyle(.secondary)
            .help(card.repo)
            if let ticket = card.ticket { TicketChip(ticket: ticket) }
            Spacer(minLength: 4)
            age
        }
        .font(.zoomed(.caption))
        .lineLimit(1)
    }

    private var age: some View {
        HStack(spacing: 3) {
            if card.stale && card.mergedAt == nil { Image(systemName: "moon.zzz.fill") }
            Text(card.age.text)
        }
        .foregroundStyle(card.age.tone == .muted ? AnyShapeStyle(.tertiary) : AnyShapeStyle(card.age.tone.color))
        .help(card.age.hint ?? "")
    }

    private func closeButton(_ close: BoardAction) -> some View {
        Button { model.request(close, on: card) } label: {
            Image(systemName: "xmark")
                .font(.zoomed(size: 8, weight: .bold))
                .foregroundStyle(.secondary)
                .frame(width: 18, height: 18)
                .background(.thinMaterial, in: .circle)
                .overlay(Circle().strokeBorder(Color.primary.opacity(0.1)))
        }
        .buttonStyle(.plain)
        .help(close.hint)
        .offset(x: 6, y: -6)
        .transition(.opacity.combined(with: .scale(scale: 0.8)))
    }

    @ViewBuilder private var menu: some View {
        Button("Open Pull Request") { openURL(card.url) }
        Button("Copy Link") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(card.url.absoluteString, forType: .string)
        }
        if let session = card.session {
            Divider()
            Button(session.open.label) { model.request(session.open, on: card) }
        }
        ForEach(card.steps, id: \.self) { step in
            Button(step.confirm == nil ? step.label : "\(step.label)…") { model.request(step, on: card) }
        }
        if let close = card.close {
            Divider()
            Button(close.label, role: .destructive) { model.request(close, on: card) }
        }
    }
}

/// The ticket key a PR's title started with, as a small muted chip.
private struct TicketChip: View {
    let ticket: String

    var body: some View {
        Text(ticket)
            .font(.zoomed(size: 9, weight: .semibold))
            .monospacedDigit()
            .lineLimit(1)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(Color.primary.opacity(0.07), in: .rect(cornerRadius: 4))
            .help("Ticket \(ticket)")
    }
}

/// The card's status, one row per thing it waits on: labels in a column of their own, values beside them.
private struct StatusRows: View {
    let card: Card

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 5) {
            ForEach(card.rows, id: \.kind) { row in
                GridRow(alignment: .firstTextBaseline) {
                    // Symbols differ in width and baseline; a fixed centered box lines the labels up.
                    HStack(alignment: .center, spacing: 5) {
                        Image(systemName: row.symbol)
                            .frame(width: 16 * Zoom.shared.scale, alignment: .center)
                        Text(row.label).lineLimit(1).fixedSize()
                    }
                    .foregroundStyle(.secondary)
                    .gridColumnAlignment(.leading)
                    if let items = row.items, !items.isEmpty {
                        RowItems(row: row, items: items, card: card)
                    } else {
                        RowValue(row: row, card: card)
                    }
                }
            }
        }
        .font(.zoomed(.subheadline))
    }
}

/// A status row's value, colored by its tone. Some act when clicked: red CI asks the session to fix
/// it, an agent's result shows what it wrote, and the Slack row opens the approval ask.
private struct RowValue: View {
    let row: Row
    let card: Card

    @Environment(BoardModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var hovering = false
    @State private var showingDetail = false

    var body: some View {
        if row.action != nil || row.detail != nil || row.link != nil {
            Button(action: activate) { content }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
                .pointerStyle(.link)
                .help(row.hint ?? "")
                .disabled(sending)
                .popover(isPresented: $showingDetail, arrowEdge: .bottom) {
                    if let detail = row.detail { DetailPopover(detail: detail, card: card) }
                }
        } else {
            content.help(row.hint ?? "")
        }
    }

    private var sending: Bool {
        row.action.map { model.isSending($0, on: card) } ?? false
    }

    private func activate() {
        if let action = row.action {
            model.request(action, on: card)
        } else if row.detail != nil {
            showingDetail = true
        } else if let link = row.link {
            openURL(link)
        }
    }

    private var content: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            ToneDot(tone: row.tone, running: row.running || sending)
            Text(row.value)
                .fontWeight(.medium)
                .foregroundStyle(row.tone.textStyle)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if let action = row.action {
                Label(action.label, systemImage: "wrench.adjustable.fill")
                    .font(.zoomed(.caption).weight(.semibold))
                    .foregroundStyle(row.tone.color)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(row.tone.color.opacity(hovering ? 0.22 : 0.12), in: .capsule)
                    .fixedSize()
            } else if row.detail != nil {
                Image(systemName: "chevron.down").font(.zoomed(size: 7, weight: .bold)).foregroundStyle(.secondary)
            } else if row.link != nil {
                Image(systemName: "arrow.up.right").font(.zoomed(size: 8, weight: .bold)).foregroundStyle(row.tone.color)
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 1)
        .background(Color.primary.opacity(hovering && row.action == nil ? 0.07 : 0), in: .rect(cornerRadius: 5))
        .padding(.horizontal, -4)
        .contentShape(.rect)
    }
}

/// A row about several things, a line each, like each Slack ask for the PR's approval. Past two, the
/// rest fold into "+N more", which shows them all.
private struct RowItems: View {
    let row: Row
    let items: [RowItem]
    let card: Card

    private let shown = 2
    @State private var hovering = false
    @State private var showingAll = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(items.prefix(shown).enumerated()), id: \.offset) { _, item in
                ItemLine(item: item)
            }
            if items.count > shown {
                Button { showingAll = true } label: { more }
                    .buttonStyle(.plain)
                    .onHover { hovering = $0 }
                    .pointerStyle(.link)
                    .help("Show all \(items.count)")
                    .popover(isPresented: $showingAll, arrowEdge: .bottom) { ItemsPopover(title: row.label, items: items, card: card) }
            }
        }
        // Takes the value column's whole width, so the grid sizes the rows above at that width too.
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var more: some View {
        HStack(spacing: 3) {
            Text("+\(items.count - shown) more")
            Image(systemName: "chevron.down").font(.zoomed(size: 7, weight: .bold))
        }
        .font(.zoomed(.caption).weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
        .padding(.vertical, 1)
        .background(Color.primary.opacity(hovering ? 0.07 : 0), in: .rect(cornerRadius: 5))
        .padding(.horizontal, -4)
        // In line with the lines' text, past their dots.
        .padding(.leading, 9 * Zoom.shared.scale + 5)
        .contentShape(.rect)
    }
}

/// One line of a row's list, in its tone, opening its link: a dot, or a check once it's taken care
/// of, then its text and a quieter note, which goes under the text when both don't fit on one line.
private struct ItemLine: View {
    let item: RowItem

    @Environment(\.openURL) private var openURL
    @State private var hovering = false

    var body: some View {
        if let link = item.link {
            Button { openURL(link) } label: { content }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
                .pointerStyle(.link)
                .help(item.hint ?? "")
        } else {
            content.help(item.hint ?? "")
        }
    }

    private var content: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            if item.done {
                Image(systemName: "checkmark")
                    .font(.zoomed(size: 8, weight: .heavy))
                    .foregroundStyle(Color.boardGreen)
                    .frame(width: 9 * Zoom.shared.scale)
            } else {
                ToneDot(tone: item.tone, running: false)
            }
            // One line when it fits; else the note goes under the text, which may wrap.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    label
                    if let note = item.note { Text(verbatim: "· \(note)").foregroundStyle(.secondary) }
                    arrow
                }
                .lineLimit(1)
                .fixedSize()
                VStack(alignment: .leading, spacing: 1) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        label.lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        arrow
                    }
                    if let note = item.note { Text(note).foregroundStyle(.secondary).lineLimit(1) }
                }
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 1)
        .background(Color.primary.opacity(hovering ? 0.07 : 0), in: .rect(cornerRadius: 5))
        .padding(.horizontal, -4)
        .contentShape(.rect)
    }

    private var label: some View {
        Text(item.text).fontWeight(.medium).foregroundStyle(item.tone.textStyle)
    }

    @ViewBuilder private var arrow: some View {
        if item.link != nil {
            Image(systemName: "arrow.up.right").font(.zoomed(size: 8, weight: .bold)).foregroundStyle(item.tone.color)
        }
    }
}

/// Every line of a row's list, for a card that shows only the first few.
private struct ItemsPopover: View {
    let title: String
    let items: [RowItem]
    let card: Card

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title).font(.zoomedHeadline)
                Text(verbatim: "\(card.repoName) #\(card.number)").font(.zoomed(.body)).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    ItemLine(item: item)
                }
            }
            .font(.zoomed(.subheadline))
        }
        .padding(14)
        .frame(minWidth: 220 * Zoom.shared.scale, alignment: .leading)
    }
}

/// A row's state at a glance: a dot in its tone, dashed when nothing ran yet, a spinner while the session works on it.
private struct ToneDot: View {
    let tone: Tone
    let running: Bool

    var body: some View {
        Group {
            if running {
                Image(systemName: "progress.indicator")
                    .symbolEffect(.variableColor.iterative, options: .repeat(.continuous))
            } else {
                Image(systemName: tone == .ghost ? "circle.dashed" : "circle.fill")
            }
        }
        .font(.zoomed(size: running ? 9 : 7, weight: .bold))
        .foregroundStyle(tone.color)
        .frame(width: 9 * Zoom.shared.scale)
    }
}

/// What needs you on the card, in one line.
private struct NoticeLine: View {
    let notice: Notice
    let card: Card

    @State private var hovering = false
    @State private var showingDetail = false

    var body: some View {
        if let detail = notice.detail {
            Button { showingDetail = true } label: { content }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
                .pointerStyle(.link)
                .help(notice.hint ?? "")
                .popover(isPresented: $showingDetail, arrowEdge: .bottom) { DetailPopover(detail: detail, card: card) }
        } else {
            content.help(notice.hint ?? "")
        }
    }

    private var content: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: notice.tone == .bad ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
            Text(notice.text).fixedSize(horizontal: false, vertical: true)
            if notice.detail != nil {
                Image(systemName: "chevron.down").font(.zoomed(size: 7, weight: .bold))
            }
        }
        .font(.zoomed(.subheadline).weight(.medium))
        .foregroundStyle(notice.tone.color)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(notice.tone.color.opacity(hovering ? 0.16 : 0.09), in: .rect(cornerRadius: 6))
        .contentShape(.rect)
    }
}

/// The omp session in charge of the PR, and the card's next step, or the request the session is on.
private struct Footer: View {
    let card: Card

    @Environment(BoardModel.self) private var model
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            if let session = card.session {
                Button { model.request(session.open, on: card) } label: { label(session) }
                    .buttonStyle(.plain)
                    .onHover { hovering = $0 }
                    .help(session.open.hint)
                    .disabled(model.isSending(session.open, on: card))
            }
            Spacer(minLength: 0)
            if let running = card.running {
                RunningLabel(text: running)
            } else {
                ForEach(card.steps, id: \.self) { StepButton(step: $0, card: card) }
            }
        }
    }

    private func label(_ session: Session) -> some View {
        HStack(spacing: 6) {
            if model.isSending(session.open, on: card) {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: "terminal").imageScale(.medium).foregroundStyle(.secondary)
            }
            Text(session.title).lineLimit(1).truncationMode(.tail)
            if !session.busy, session.state != .open {
                Text(session.state == .working ? "working" : "closed")
                    .foregroundStyle(session.state == .working ? Color.boardAmber : Color.secondary)
            }
        }
        .font(.zoomed(.caption))
        .foregroundStyle(.primary.opacity(0.85))
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(Color.primary.opacity(hovering ? 0.08 : 0), in: .rect(cornerRadius: 6))
        .padding(.horizontal, -6)
        .contentShape(.rect)
    }
}

/// A request the session is on, where the step button was: a spinner on a breathing capsule.
private struct RunningLabel: View {
    let text: String

    var body: some View {
        HStack(spacing: 5) {
            ProgressView().controlSize(.mini).scaleEffect(0.75).frame(width: 10, height: 10)
            Text(text)
        }
        .font(.zoomed(.caption).weight(.semibold))
        .lineLimit(1)
        .foregroundStyle(Color.boardAmber)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background {
            Capsule().fill(Color.boardAmber).phaseAnimator([0.1, 0.24]) { fill, opacity in
                fill.opacity(opacity)
            } animation: { _ in
                .easeInOut(duration: 0.9)
            }
        }
        .fixedSize()
    }
}

private struct StepButton: View {
    let step: BoardAction
    let card: Card

    @Environment(BoardModel.self) private var model

    var body: some View {
        let sending = model.isSending(step, on: card)
        Button { model.request(step, on: card) } label: {
            HStack(spacing: 5) {
                if sending { ProgressView().controlSize(.mini).tint(.white) }
                Text(step.label)
            }
        }
        .buttonStyle(StepButtonStyle(tint: step.action == "merge" ? .boardGreen : .accentColor))
        // The step is the card's point; the session title next to it truncates instead.
        .fixedSize()
        .disabled(sending)
        .help(step.hint)
    }
}

/// A card's one step forward: a small filled capsule in the step's color, legible in an inactive window too.
private struct StepButtonStyle: ButtonStyle {
    let tint: Color
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.zoomed(.caption).weight(.semibold))
            .lineLimit(1)
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(tint.opacity(isEnabled ? 1 : 0.6), in: .capsule)
            .overlay(Capsule().fill(.black.opacity(configuration.isPressed ? 0.18 : 0)))
            .contentShape(.capsule)
    }
}

import AppKit
import SwiftUI

/// One pull request: a header with the card's "…" menu, a few status rows in a fixed order, what
/// needs you, then the session and the card's next step, each on a row of its own. It fills the height
/// it's offered, the extra above the footer, so the footers of a row of cards line up. Clicking the
/// card opens the PR in the browser; its rows, session, step, and menu act on their own.
struct CardView: View {
    let card: Card

    @Environment(\.openURL) private var openURL
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 5) {
                    header
                    Text(card.title)
                        .font(.zoomed(.body).weight(.semibold))
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
            }
            Spacer(minLength: 0)
            if card.session != nil || !card.steps.isEmpty || card.running != nil {
                VStack(alignment: .leading, spacing: 10) {
                    Divider()
                    VStack(alignment: .leading, spacing: 8) {
                        if let session = card.session { SessionLine(card: card, session: session) }
                        StepSlot(card: card)
                    }
                }
                .padding(.top, 10)
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
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(hovering ? 0.14 : 0.07), lineWidth: 1)
        }
        // A PR that's part of a task wears the task's color down its edge, like the task's own card.
        .overlay(alignment: .leading) {
            if let task = card.task { TaskEdge(hue: task.hue) }
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
            if let task = card.task { TaskChipView(chip: task) }
            Spacer(minLength: 4)
            age
            CardMenu { menu }
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

    private var menu: some View { CardMenuItems(card: card) }
}

/// A card's actions, in its "…" menu and its right-click menu alike.
struct CardMenuItems: View {
    let card: Card

    @Environment(BoardModel.self) private var model
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button("Open in Browser", systemImage: "safari") { openURL(card.url) }
        Button("Copy Link", systemImage: "link") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(card.url.absoluteString, forType: .string)
        }
        if let session = card.session {
            Divider()
            Button(session.open.label, systemImage: "terminal") { model.request(session.open, on: card) }
        }
        ForEach(card.steps, id: \.self) { step in
            Button(step.confirm == nil ? step.label : "\(step.label)…", systemImage: step.symbol) { model.request(step, on: card) }
        }
        if let close = card.close {
            Divider()
            Button(close.label, systemImage: "xmark.circle", role: .destructive) { model.request(close, on: card) }
        }
    }
}

/// The ticket key a PR's title started with, as a small muted chip.
struct TicketChip: View {
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
struct ToneDot: View {
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

/// The "…" button in the card's corner: the card's menu, always there but quiet until the pointer's on it.
struct CardMenu<Items: View>: View {
    @ViewBuilder let items: Items
    @State private var hovering = false

    var body: some View {
        let scale = Zoom.shared.scale
        Menu { items } label: {
            Image(systemName: "ellipsis")
                .font(.zoomed(size: 12, weight: .semibold))
                .foregroundStyle(hovering ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .frame(width: 26 * scale, height: 20 * scale)
                .background(Color.primary.opacity(hovering ? 0.08 : 0), in: .rect(cornerRadius: 6 * scale))
                .contentShape(.rect)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        // As tall as the header's text, and flush with the card's edge.
        .padding(.vertical, -5 * scale)
        .padding(.trailing, -6 * scale)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help("More actions")
    }
}

/// The omp session in charge of the PR, on a row of its own: clicking it opens the session.
private struct SessionLine: View {
    let card: Card
    let session: Session

    @Environment(BoardModel.self) private var model
    @State private var hovering = false

    var body: some View {
        Button { model.request(session.open, on: card) } label: { label }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            .help(session.open.hint)
            .disabled(model.isSending(session.open, on: card))
    }

    private var label: some View {
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
}

/// The card's next step, a full-width button, or in its place the request the session is on, so the
/// card keeps its shape. Cards with neither have no slot.
private struct StepSlot: View {
    let card: Card

    var body: some View {
        Group {
            if let running = card.running {
                RunningLabel(text: running)
                    .transition(.blurReplace)
            } else {
                ForEach(card.steps, id: \.self) { StepButton(step: $0, target: .pr(card.ref)) }
            }
        }
        .animation(.smooth(duration: 0.3), value: card.running)
    }
}

/// A step button's size, which the running request takes on too.
@MainActor enum StepMetrics {
    static var height: CGFloat { 28 * Zoom.shared.scale }
    static var radius: CGFloat { 8 * Zoom.shared.scale }
    static var font: Font { .zoomed(.callout).weight(.semibold) }
}

/// A request the session is on, where the step button was: a spinner on a breathing fill.
struct RunningLabel: View {
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            Spinner()
            Text(text)
        }
        .font(StepMetrics.font)
        .lineLimit(1)
        .foregroundStyle(Color.boardAmber)
        .frame(maxWidth: .infinity, minHeight: StepMetrics.height)
        .background {
            RoundedRectangle(cornerRadius: StepMetrics.radius, style: .continuous)
                .fill(Color.boardAmber)
                .phaseAnimator([0.1, 0.2]) { fill, opacity in
                    fill.opacity(opacity)
                } animation: { _ in
                    .easeInOut(duration: 0.9)
                }
        }
        .overlay {
            RoundedRectangle(cornerRadius: StepMetrics.radius, style: .continuous)
                .strokeBorder(Color.boardAmber.opacity(0.3), lineWidth: 1)
        }
        .help("The session is on it")
    }
}

/// A spinner that takes its color from the text around it.
struct Spinner: View {
    var body: some View {
        Image(systemName: "progress.indicator")
            .symbolEffect(.variableColor.iterative, options: .repeat(.continuous))
    }
}

/// The card's one step forward, the width of the card.
struct StepButton: View {
    let step: BoardAction
    let target: ActionTarget

    @Environment(BoardModel.self) private var model
    @State private var clicks = 0

    var body: some View {
        let sending = model.isSending(step, on: target)
        Button {
            clicks += 1
            model.request(step, on: target)
        } label: {
            HStack(spacing: 6) {
                Group {
                    if sending { Spinner() } else { Image(systemName: step.symbol) }
                }
                .contentTransition(.symbolEffect(.replace))
                Text(step.label)
            }
        }
        .buttonStyle(StepButtonStyle(fill: step.fill))
        .disabled(sending)
        .sensoryFeedback(.alignment, trigger: clicks)
        .help(step.hint)
    }
}

/// A card's step: a filled bar in the step's color, legible in an inactive window too, that lights up
/// under the pointer and gives a little when pressed.
private struct StepButtonStyle: ButtonStyle {
    let fill: Color

    func makeBody(configuration: Configuration) -> some View {
        StepButtonBody(configuration: configuration, fill: fill)
    }
}

private struct StepButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let fill: Color

    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: StepMetrics.radius, style: .continuous)
        let pressed = configuration.isPressed
        configuration.label
            .font(StepMetrics.font)
            .lineLimit(1)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: StepMetrics.height)
            .background {
                shape
                    .fill(fill.opacity(isEnabled ? 1 : 0.7))
                    .overlay(shape.fill(.linearGradient(colors: [.white.opacity(0.14), .clear], startPoint: .top, endPoint: .bottom)))
                    .shadow(color: fill.opacity(hovering && !pressed ? 0.35 : 0.15), radius: hovering && !pressed ? 4 : 1, y: 1)
            }
            .overlay(shape.fill(pressed ? Color.black.opacity(0.16) : Color.white.opacity(hovering && isEnabled ? 0.1 : 0)))
            .overlay(shape.strokeBorder(.white.opacity(0.12), lineWidth: 1))
            .contentShape(shape)
            .scaleEffect(pressed ? 0.97 : 1)
            .onHover { hovering = $0 }
            .pointerStyle(isEnabled ? .link : nil)
            .animation(.easeOut(duration: 0.12), value: hovering)
            .animation(.spring(duration: 0.2, bounce: 0.4), value: pressed)
    }
}

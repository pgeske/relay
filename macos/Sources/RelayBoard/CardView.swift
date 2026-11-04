import AppKit
import SwiftUI

/// One pull request. Clicking it opens the PR in the browser; its tags, session, and step buttons
/// act on their own.
struct CardView: View {
    let card: Card
    /// Merged cards recede: there's nothing left to do on them.
    var muted = false

    @Environment(BoardModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            Text(card.title)
                .font(.zoomed(.body).weight(.semibold))
                .foregroundStyle(muted ? .secondary : .primary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !card.tags.isEmpty || card.ticket != nil {
                FlowLayout {
                    if let ticket = card.ticket { TicketChip(ticket: ticket) }
                    ForEach(card.tags, id: \.self) { TagChip(tag: $0, card: card) }
                }
            }
            if card.session != nil || !card.steps.isEmpty {
                Divider().padding(.top, 2)
                SessionRow(card: card)
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
            Spacer(minLength: 4)
            if card.mergedAt == nil { age }
        }
        .font(.zoomed(.caption))
        .lineLimit(1)
    }

    @ViewBuilder private var age: some View {
        if card.stale {
            Label("Stale \(card.idleDays)d", systemImage: "moon.zzz.fill")
                .labelStyle(.titleAndIcon)
                .foregroundStyle(Color.boardOrange)
                .help("No activity for \(card.idleDays) days")
        } else {
            Text(card.idleDays == 0 ? "Today" : "\(card.idleDays)d")
                .foregroundStyle(.tertiary)
                .help(card.idleDays == 0 ? "Active today" : "Last activity \(card.idleDays) day\(card.idleDays == 1 ? "" : "s") ago")
        }
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

/// The omp session in charge of the PR, and the steps that ask it to move the PR to its next lane.
private struct SessionRow: View {
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
            ForEach(card.steps, id: \.self) { StepButton(step: $0, card: card) }
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

import SwiftUI

/// Answers the agent's open `ask` question from the phone, in place of the composer.
/// The picks are sent to the server, which presses the same keys a person would in the TUI.
struct AskPanel: View {
    let chat: ChatStore
    let call: Block.ToolCall

    @State private var picks: [Int: Set<Int>] = [:]
    @State private var typed: [Int: String] = [:]
    @State private var isSending = false
    @Environment(\.appTheme) private var theme

    private var questions: [Block.AskQuestion] { call.ask ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                        questionSection(index: index, question: question)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 420)
            .fixedSize(horizontal: false, vertical: true)

            submitButton
        }
        .padding(14)
        .background(theme.elevatedSurface, in: panelShape)
        .overlay(panelShape.strokeBorder(theme.separator, lineWidth: 1))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(theme.background)
        // A new question replaces the old one in place; start it with a clean slate.
        .onChange(of: call.id) { _, _ in
            picks = [:]
            typed = [:]
            isSending = false
        }
    }

    private var panelShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 24, style: .continuous)
    }

    private var header: some View {
        HStack {
            Label("The agent is asking", systemImage: "questionmark.bubble")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(theme.secondaryText)
            Spacer()
            Button {
                Task { await chat.sendKeys(["Escape"]) }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.secondaryText)
                    .frame(width: 30, height: 30)
                    .background(theme.separator, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(isSending)
            .accessibilityLabel("Dismiss question")
        }
    }

    private func questionSection(index: Int, question: Block.AskQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(question.question)
                .font(.body.weight(.semibold))
                .foregroundStyle(theme.primaryText)
            if question.multi {
                Text("Pick any")
                    .font(.caption)
                    .foregroundStyle(theme.tertiaryText)
            }

            ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
                optionRow(
                    option: option,
                    recommended: question.recommended == optionIndex,
                    multi: question.multi,
                    selected: picks[index, default: []].contains(optionIndex)
                ) {
                    toggle(option: optionIndex, in: index, multi: question.multi)
                }
            }

            TextField("Other (type your own)", text: typedBinding(for: index, multi: question.multi), axis: .vertical)
                .lineLimit(1...4)
                .font(.body)
                .foregroundStyle(theme.primaryText)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(theme.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func optionRow(
        option: Block.AskQuestion.Option,
        recommended: Bool,
        multi: Bool,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selectionIcon(multi: multi, selected: selected))
                    .font(.system(size: 18))
                    .foregroundStyle(selected ? theme.accent : theme.tertiaryText)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(option.label)
                            .font(.body)
                            .foregroundStyle(theme.primaryText)
                        if recommended {
                            Text("Recommended")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(theme.accent)
                        }
                    }
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryText)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                selected ? theme.accent.opacity(0.15) : theme.background,
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func selectionIcon(multi: Bool, selected: Bool) -> String {
        switch (multi, selected) {
        case (true, true): "checkmark.square.fill"
        case (true, false): "square"
        case (false, true): "largecircle.fill.circle"
        case (false, false): "circle"
        }
    }

    private var submitButton: some View {
        Button {
            Task { await submit() }
        } label: {
            HStack {
                if isSending {
                    ProgressView().controlSize(.small)
                }
                Text(isSending ? "Sending" : "Send answer")
                    .font(.body.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .foregroundStyle(canSubmit ? theme.accentForeground : theme.tertiaryText)
            .background(canSubmit ? theme.accent : theme.separator, in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!canSubmit)
    }

    // MARK: - Answers

    /// Single-select: one pick or typed text, never both (typing replaces the pick, like the TUI).
    private func toggle(option: Int, in question: Int, multi: Bool) {
        if multi {
            picks[question, default: []].formSymmetricDifference([option])
        } else {
            picks[question] = [option]
            typed[question] = nil
        }
    }

    private func typedBinding(for question: Int, multi: Bool) -> Binding<String> {
        Binding {
            typed[question] ?? ""
        } set: { text in
            typed[question] = text
            if !multi, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                picks[question] = []
            }
        }
    }

    private var answers: [AskAnswer] {
        questions.indices.map { index in
            let custom = typed[index]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return AskAnswer(
                options: picks[index, default: []].sorted(),
                custom: custom.isEmpty ? nil : custom
            )
        }
    }

    private var canSubmit: Bool {
        !isSending && !questions.isEmpty && answers.allSatisfy { !$0.options.isEmpty || $0.custom != nil }
    }

    private func submit() async {
        isSending = true
        guard await chat.answerAsk(call, answers: answers) else {
            isSending = false
            return
        }
        // The panel disappears once omp writes the answer. If that never happens (say the
        // terminal dialog was hidden), let the user try again instead of spinning forever.
        try? await Task.sleep(for: .seconds(10))
        isSending = false
    }
}

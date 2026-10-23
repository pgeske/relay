import SwiftUI

/// Composer chip showing the session's model and thinking level, e.g. "Opus 5.5 Medium".
/// Tapping it opens a menu to change either one.
struct ModelPicker: View {
    let chat: ChatStore

    @Environment(\.appTheme) private var theme

    var body: some View {
        Menu {
            thinkingSection
            modelSection
        } label: {
            HStack(spacing: 5) {
                Text(modelLabel)
                    .foregroundStyle(theme.primaryText)
                if let level = chat.currentThinkingLevel, hasThinking {
                    Text(Self.levelLabel(level))
                        .foregroundStyle(theme.secondaryText)
                }
            }
            .font(.subheadline)
            .lineLimit(1)
            .padding(.horizontal, 14)
            .frame(height: 36)
            .background(theme.separator, in: Capsule())
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Model and thinking level")
    }

    // MARK: - Menu

    @ViewBuilder
    private var thinkingSection: some View {
        if let levels = chat.currentModelOption?.thinkingLevels, !levels.isEmpty {
            Section("Thinking") {
                ForEach(levels, id: \.self) { level in
                    Button {
                        Task { await chat.selectThinkingLevel(level) }
                    } label: {
                        checkmarkLabel(Self.levelLabel(level), isSelected: level == chat.currentThinkingLevel)
                    }
                }
            }
        }
    }

    private var modelSection: some View {
        Section("Model") {
            ForEach(providers, id: \.self) { provider in
                Menu(provider) {
                    ForEach(chat.models.filter { $0.provider == provider }) { option in
                        Button {
                            Task { await chat.selectModel(option.selector) }
                        } label: {
                            checkmarkLabel(option.name, isSelected: option.selector == chat.currentModel)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func checkmarkLabel(_ title: String, isSelected: Bool) -> some View {
        if isSelected {
            Label(title, systemImage: "checkmark")
        } else {
            Text(title)
        }
    }

    // MARK: - Labels

    /// Providers in the order the server lists them, without repeats.
    private var providers: [String] {
        var seen: Set<String> = []
        return chat.models.map(\.provider).filter { seen.insert($0).inserted }
    }

    /// Models without reasoning have no levels; the chip then shows only the model.
    private var hasThinking: Bool {
        guard let option = chat.currentModelOption else { return true }
        return !option.thinkingLevels.isEmpty
    }

    private var modelLabel: String {
        if let option = chat.currentModelOption {
            return Self.shortName(option.name)
        }
        guard let selector = chat.currentModel else { return "Model" }
        return selector.split(separator: "/").last.map(String.init) ?? selector
    }

    /// "Claude Opus 5.5" reads as "Opus 5.5" in a chip that is already about models.
    static func shortName(_ name: String) -> String {
        name.hasPrefix("Claude ") ? String(name.dropFirst("Claude ".count)) : name
    }

    static func levelLabel(_ level: String) -> String {
        switch level {
        case "xhigh": "Extra High"
        default: level.prefix(1).uppercased() + level.dropFirst()
        }
    }
}

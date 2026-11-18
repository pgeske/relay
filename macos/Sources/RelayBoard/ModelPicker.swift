import SwiftUI

/// The model chip's popover, a finder like omp's `/switch`: type a few letters of a model ("op55",
/// "gpt 6.2") and press Return. ↑/↓ move through the matches, and Tab (⇧Tab back) steps the
/// thinking level for the highlighted model, so a whole choice takes a few keystrokes. Models
/// picked lately, then omp's default, come first, so "op" lands on the Opus you use.
struct ModelPicker: View {
    let choices: ModelChoices
    @Binding var model: String?
    @Binding var level: String?
    let offersDefault: Bool
    let done: () -> Void

    @State private var query = ""
    /// Selectors picked here lately, newest first, one per line.
    @AppStorage("recentModels") private var recentModels = ""
    /// Every row with its search text, built once when the popover opens.
    @State private var corpus: [(row: Row, text: FuzzyText)] = []
    @State private var rows: [Row] = []
    @State private var highlight = 0
    @FocusState private var searching: Bool

    /// A model to pick, or nil for omp's default.
    struct Row: Identifiable {
        let option: ModelOption?
        var id: String { option?.selector ?? "default" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            searchField
                .padding(12)
            Divider()
            thinkingRow
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            Divider()
            list
            Divider()
            Text("↑↓ move · ⇥ thinking · ↩ pick · esc close")
                .font(.zoomed(.caption))
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .frame(width: 520 * Zoom.shared.scale)
        .onAppear(perform: load)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search models", text: $query)
                .textFieldStyle(.plain)
                .focusEffectDisabled()
                .font(.zoomed(.title3))
                .focused($searching)
                .onSubmit { choose() }
                .onKeyPress(.upArrow) { move(-1) }
                .onKeyPress(.downArrow) { move(1) }
                .onKeyPress(keys: [.tab]) { press in stepLevel(press.modifiers.contains(.shift) ? -1 : 1) }
                // Some keyboards send ⇧Tab as its own "backtab" character.
                .onKeyPress(keys: [KeyEquivalent("\u{19}")]) { _ in stepLevel(-1) }
                .onChange(of: query) { filter() }
        }
    }

    /// The highlighted model's thinking levels, the chosen one filled in. Clicking one sets it
    /// without closing, so you can still pick the model after.
    private var thinkingRow: some View {
        HStack(spacing: 2) {
            Text("Thinking")
                .font(.zoomed(.callout))
                .foregroundStyle(.secondary)
                .padding(.trailing, 4)
            if levelChoices.isEmpty {
                Text("Not for this model")
                    .font(.zoomed(.callout))
                    .foregroundStyle(.tertiary)
            }
            ForEach(levelChoices, id: \.self) { choice in
                let selected = choice == level
                Button { level = choice } label: {
                    Text(choice.map(Self.shortLevelLabel) ?? "Default")
                        .font(.zoomed(.callout).weight(selected ? .semibold : .regular))
                        .foregroundStyle(selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                        .fixedSize()
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(selected ? AnyShapeStyle(.tint.opacity(0.18)) : AnyShapeStyle(.clear), in: .capsule)
                        .contentShape(.capsule)
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
        .lineLimit(1)
    }

    /// Up to nine levels share one row, so the longer names shrink: "Extra High" reads as "XHigh".
    private static func shortLevelLabel(_ level: String) -> String {
        switch level {
        case "minimal": "Min"
        case "medium": "Med"
        case "xhigh": "XHigh"
        default: ModelOption.levelLabel(level)
        }
    }

    private var list: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 1) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        rowView(row, highlighted: index == highlight)
                            .id(row.id)
                            .onTapGesture {
                                highlight = index
                                choose()
                            }
                    }
                }
                .padding(6)
            }
            .frame(height: 320 * Zoom.shared.scale)
            .overlay {
                if rows.isEmpty {
                    Text("No models match").foregroundStyle(.secondary)
                }
            }
            .onChange(of: highlight) {
                if rows.indices.contains(highlight) { proxy.scrollTo(rows[highlight].id) }
            }
            .onChange(of: rows.first?.id) {
                // Opening on the current model: start the list there rather than at the top.
                if rows.indices.contains(highlight) { proxy.scrollTo(rows[highlight].id, anchor: .center) }
            }
        }
    }

    private func rowView(_ row: Row, highlighted: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark")
                .font(.zoomed(size: 10, weight: .bold))
                .opacity(row.option?.selector == model ? 1 : 0)
            if let option = row.option {
                Text(option.shortName)
                Spacer(minLength: 8)
                Text(option.provider)
                    .font(.zoomed(.callout))
                    .foregroundStyle(.secondary)
            } else {
                Text("Default")
                Spacer(minLength: 8)
                if let name = choices.option(choices.defaults.model)?.shortName {
                    Text(name)
                        .font(.zoomed(.callout))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .lineLimit(1)
        .font(.zoomed(.body))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(highlighted ? AnyShapeStyle(.tint.opacity(0.22)) : AnyShapeStyle(.clear), in: .rect(cornerRadius: 5))
        .contentShape(.rect)
    }

    /// The levels Tab steps through: omp's default first for a session yet to start.
    private var levelChoices: [String?] {
        let highlighted = rows.indices.contains(highlight) ? rows[highlight] : nil
        let selector = highlighted.map { $0.option?.selector ?? choices.defaults.model } ?? model ?? choices.defaults.model
        let levels = choices.option(selector)?.thinkingLevels ?? []
        guard !levels.isEmpty else { return [] }
        return (offersDefault ? [nil] : []) + levels.map(Optional.some)
    }

    private func load() {
        // Recent picks and omp's default lead; the rest keep omp's order.
        let leading = recentModels.split(separator: "\n").map(String.init) + [choices.defaults.model].compactMap { $0 }
        let rank = Dictionary(leading.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        let models = choices.models.enumerated()
            .sorted { (rank[$0.element.selector] ?? .max, $0.offset) < (rank[$1.element.selector] ?? .max, $1.offset) }
            .map { Row(option: $0.element) }
        let all = (offersDefault ? [Row(option: nil)] : []) + models
        corpus = all.map { row in
            (row, FuzzyText(row.option.map { "\($0.name) \($0.provider)" } ?? "Default"))
        }
        rows = all
        highlight = all.firstIndex { $0.option?.selector == model } ?? 0
        searching = true
    }

    /// Ranks the rows against the query, best first; ties keep the order they open in.
    private func filter() {
        let words = FuzzyQuery(query)
        if words.isEmpty {
            rows = corpus.map(\.row)
        } else {
            rows = corpus.enumerated()
                .compactMap { index, entry in words.score(entry.text).map { (entry.row, $0, index) } }
                .sorted { ($0.1, $0.2) < ($1.1, $1.2) }
                .map(\.0)
        }
        highlight = 0
    }

    private func move(_ step: Int) -> KeyPress.Result {
        guard !rows.isEmpty else { return .handled }
        highlight = min(max(highlight + step, 0), rows.count - 1)
        return .handled
    }

    private func stepLevel(_ step: Int) -> KeyPress.Result {
        let levels = levelChoices
        guard !levels.isEmpty else { return .handled }
        let current = levels.firstIndex(of: level) ?? (step > 0 ? -1 : levels.count)
        level = levels[(current + step + levels.count) % levels.count]
        return .handled
    }

    /// Picks the highlighted model and closes. A thinking level the new model doesn't take is
    /// dropped, like omp's `/switch` would.
    private func choose() {
        guard rows.indices.contains(highlight) else { return }
        let selector = rows[highlight].option?.selector
        model = selector
        let levels = choices.option(selector ?? choices.defaults.model)?.thinkingLevels ?? []
        if offersDefault, let chosen = level, !levels.contains(chosen) { level = nil }
        if let selector {
            let others = recentModels.split(separator: "\n").map(String.init).filter { $0 != selector }
            recentModels = ([selector] + others.prefix(7)).joined(separator: "\n")
        }
        done()
    }
}

/// What someone typed into a finder, split into words. Every word has to turn up in a text for
/// it to match, in order though not necessarily together ("op55" matches "Opus 5.5"); case,
/// spaces, and punctuation don't count.
struct FuzzyQuery {
    private let words: [[Character]]

    init(_ query: String) {
        words = query.split(whereSeparator: \.isWhitespace)
            .map { FuzzyText($0).characters }
            .filter { !$0.isEmpty }
    }

    var isEmpty: Bool { words.isEmpty }

    /// How well the text matches, lower being better; nil when it doesn't.
    func score(_ text: FuzzyText) -> Double? {
        var total = 0.0
        for word in words {
            guard let score = text.score(word) else { return nil }
            total += score
        }
        return total
    }
}

/// A text prepared for matching: just its letters and digits, lowercased, each marked with
/// whether it starts a word.
struct FuzzyText {
    let characters: [Character]
    private let wordStarts: [Bool]

    init(_ text: some StringProtocol) {
        var characters: [Character] = []
        var wordStarts: [Bool] = []
        var previous: Character?
        for character in text.lowercased() {
            guard character.isLetter || character.isNumber else {
                previous = nil
                continue
            }
            // "gpt-6.2" has words gpt, 6, and 2; so does "gpt6.2".
            wordStarts.append(previous.map { $0.isLetter != character.isLetter } ?? true)
            characters.append(character)
            previous = character
        }
        self.characters = characters
        self.wordStarts = wordStarts
    }

    /// The word in one run ranks first: as whole words, then at a word's start, then inside one.
    /// Failing that, its letters spread out in order rank after, tighter first. Where in the text doesn't count,
    /// so equal matches keep the list's order (recent picks first) rather than favoring "OpenAI"
    /// over "Claude Opus" for "op".
    func score(_ word: [Character]) -> Double? {
        guard !word.isEmpty, word.count <= characters.count else { return word.isEmpty ? 0 : nil }
        var best: Double?
        for start in 0...(characters.count - word.count) where characters[start] == word[0] {
            guard characters[start..<start + word.count].elementsEqual(word) else { continue }
            let end = start + word.count
            // Whole words ("6.2" in "GPT-6.2 Sol") beat a word's start ("6.2" in "qwen3.6 27B").
            let score: Double = !wordStarts[start] ? 1 : end == characters.count || wordStarts[end] ? 0 : 0.5
            if score == 0 { return 0 }
            best = min(best ?? score, score)
        }
        if let best { return best }

        var next = 0
        var first = -1
        var last = 0
        for (index, character) in characters.enumerated() where next < word.count && character == word[next] {
            if first < 0 { first = index }
            last = index
            next += 1
        }
        guard next == word.count else { return nil }
        return 2 + Double(last - first + 1 - word.count) * 0.05
    }
}

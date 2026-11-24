import AppKit
import SwiftUI

/// How roomy Markdown should look: compact inside tight popovers, or spacious in the document reader.
enum MarkdownStyle {
    case compact
    case document
}

/// Markdown as agents write it in plans and task details, laid out block by block: paragraphs,
/// numbered and bulleted lists with hanging indents, checklists, headings, horizontal rules, code
/// blocks, quotes, and tables. Line breaks are the agent's, as they wrote them.
struct MarkdownText: View {
    let text: String
    var style: MarkdownStyle = .compact

    var body: some View {
        let blocks = MarkdownBlock.parse(text)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                MarkdownBlockView(block: block, style: style)
                    .padding(.top, index == 0 ? 0 : block.spacing(after: blocks[index - 1], style: style) * Zoom.shared.scale)
            }
        }
        .font(style == .document ? .zoomed(size: 14.5, weight: .regular) : nil)
        .tint(Color.boardBlue)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One block of the text: a paragraph, heading, rule, code block, or table, maybe inside a list item or a quote.
struct MarkdownBlock {
    enum Kind {
        case paragraph
        case heading(level: Int)
        case code(language: String?)
        case rule
        /// Rows of cells, the first one the header.
        case table([[AttributedString]])
    }

    var kind: Kind
    var content: AttributedString
    /// How many lists it's inside: 0 outside any.
    var depth = 0
    /// The list item's number or bullet; nil outside lists, for checklists, and for an item's later paragraphs.
    var marker: String?
    /// True when the innermost list containing this block is numbered.
    var ordered = false
    /// Non-nil for `- [ ]` / `- [x]` checklist items.
    var checked: Bool?
    var quoted = false
    /// Which list item, outermost list, and table it's in, to group blocks that belong together.
    var item: Int?
    var list: Int?
    var table: Int?

    /// Space above this block when it follows `previous`, at 100% zoom: items of one list sit
    /// close together, while headings, top-level numbered steps, and callouts breathe.
    func spacing(after previous: MarkdownBlock, style: MarkdownStyle) -> CGFloat {
        if case .rule = kind { return style == .document ? 16 : 10 }
        if case .rule = previous.kind { return style == .document ? 16 : 10 }
        if case .heading(let level) = kind {
            if style == .document { return level <= 2 ? 22 : 16 }
            return 14
        }
        if case .heading = previous.kind { return style == .document ? 8 : 6 }
        if list != nil, list == previous.list {
            if style == .document, depth == 1, ordered, marker != nil { return 12 }
            if style == .document { return 6 }
            return 5
        }
        if style == .document {
            switch kind {
            case .code, .table: return 14
            default: break
            }
            switch previous.kind {
            case .code, .table: return 14
            default: break
            }
            if quoted != previous.quoted { return 14 }
            return 12
        }
        return 10
    }

    static func parse(_ text: String) -> [MarkdownBlock] {
        var all: [MarkdownBlock] = []
        for section in splitSections(text) {
            switch section {
            case .rule:
                all.append(MarkdownBlock(kind: .rule, content: AttributedString()))
            case .text(let chunk):
                all.append(contentsOf: parseChunk(chunk))
            }
        }
        return all
    }

    private enum Section {
        case text(String)
        case rule
    }

    /// Splits out standalone horizontal rules (`---`, `***`, `___`) outside fenced code blocks,
    /// since `AttributedString(markdown:)` drops thematic breaks that carry no characters.
    private static func splitSections(_ text: String) -> [Section] {
        var sections: [Section] = []
        var buffer: [String] = []
        var inCode = false

        func flush() {
            let joined = buffer.joined(separator: "\n")
            if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                sections.append(.text(joined))
            }
            buffer.removeAll(keepingCapacity: true)
        }

        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                inCode.toggle()
                buffer.append(line)
                continue
            }
            if !inCode, isHorizontalRule(line) {
                flush()
                sections.append(.rule)
                continue
            }
            buffer.append(line)
        }
        flush()
        return sections
    }

    private static func isHorizontalRule(_ line: String) -> Bool {
        // Indented 4+ spaces is an indented code block, not a rule.
        guard !line.hasPrefix("    "), !line.hasPrefix("\t") else { return false }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 3 else { return false }
        let compact = trimmed.filter { !$0.isWhitespace }
        guard compact.count >= 3, let first = compact.first, first == "-" || first == "*" || first == "_" else { return false }
        return compact.allSatisfy { $0 == first }
    }

    private static func parseChunk(_ text: String) -> [MarkdownBlock] {
        guard let parsed = try? AttributedString(markdown: keepingLineBreaks(text), options: .init(interpretedSyntax: .full)) else {
            return [MarkdownBlock(kind: .paragraph, content: AttributedString(text))]
        }
        var blocks: [MarkdownBlock] = []
        var current: PresentationIntent?
        var row: Int?
        var column: Int?
        for run in parsed.runs {
            var piece = AttributedString(parsed[run.range])
            if run.inlinePresentationIntent?.contains(.code) == true {
                piece.backgroundColor = Color.primary.opacity(0.08)
            }
            let intent = run.presentationIntent
            // Runs of one block share its intent; a new intent starts the next block.
            if intent == current, !blocks.isEmpty, row == nil {
                blocks[blocks.count - 1].content += piece
                continue
            }
            current = intent
            var block = MarkdownBlock(kind: .paragraph, content: piece)
            var cell: (row: Int, column: Int)?
            let components = intent?.components ?? []
            for (index, component) in components.enumerated() {
                switch component.kind {
                case .header(let level): block.kind = .heading(level: level)
                case .codeBlock(let languageHint):
                    let cleaned = languageHint?.trimmingCharacters(in: .whitespacesAndNewlines)
                    block.kind = .code(language: cleaned?.isEmpty == true ? nil : cleaned)
                case .blockQuote: block.quoted = true
                case .orderedList, .unorderedList:
                    block.depth += 1
                    block.list = component.identity // Components run innermost first, so the last list is the outermost.
                case .listItem(let ordinal) where block.item == nil:
                    // The innermost item, whose list comes right after it.
                    block.item = component.identity
                    let ordered = components.indices.contains(index + 1) && components[index + 1].kind == .orderedList
                    let nested = components[index...].count { $0.kind == .orderedList || $0.kind == .unorderedList } > 1
                    block.ordered = ordered
                    block.marker = ordered ? "\(ordinal)." : nested ? "◦" : "•"
                case .tableCell(let columnIndex): cell = (0, columnIndex)
                case .tableHeaderRow: cell?.row = component.identity
                case .tableRow: cell?.row = component.identity
                case .table: block.table = component.identity
                default: break
                }
            }
            if let cell, let table = block.table {
                // A table's cells arrive one run (or more) at a time: gather them into its rows.
                if let last = blocks.indices.last, blocks[last].table == table, case .table(var rows) = blocks[last].kind {
                    if cell.row != row {
                        rows.append([piece])
                    } else if cell.column != column {
                        rows[rows.count - 1].append(piece)
                    } else {
                        rows[rows.count - 1][rows[rows.count - 1].count - 1] += piece
                    }
                    blocks[last].kind = .table(rows)
                } else {
                    block.kind = .table([[piece]])
                    blocks.append(block)
                }
                row = cell.row
                column = cell.column
                continue
            }
            row = nil
            column = nil
            if let item = block.item, let previous = blocks.last, previous.item == item {
                block.marker = nil // A later paragraph of the same item lines up under its text.
            }
            if case .code = block.kind, block.content.characters.last == "\n" {
                block.content.characters.removeLast()
            }
            blocks.append(block)
        }
        // Convert unordered `- [ ]` / `- [x]` items into checklist blocks once their full text is gathered.
        for index in blocks.indices where blocks[index].depth > 0 && !blocks[index].ordered && blocks[index].marker != nil {
            let plain = String(blocks[index].content.characters)
            if plain.hasPrefix("[ ] ") || plain.hasPrefix("[x] ") || plain.hasPrefix("[X] ") {
                let isChecked = plain.hasPrefix("[x] ") || plain.hasPrefix("[X] ")
                let end = blocks[index].content.characters.index(blocks[index].content.startIndex, offsetBy: 4)
                blocks[index].content.removeSubrange(blocks[index].content.startIndex..<end)
                blocks[index].checked = isChecked
                blocks[index].marker = nil
            }
        }
        return blocks
    }

    /// Agents mean their line breaks, where Markdown would join the lines into one paragraph. So
    /// each line breaks where they broke it, and a line back at the margin after a list starts a
    /// new paragraph rather than running on into the last item. Code blocks stay as they are.
    private static func keepingLineBreaks(_ text: String) -> String {
        var lines: [String] = []
        var inCode = false
        var inList = false
        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                inCode.toggle()
                lines.append(line)
                continue
            }
            if inCode {
                lines.append(line)
                continue
            }
            // A list goes on through blank lines and indented lines, which can be an item's later paragraphs.
            if trimmed.wholeMatch(of: /([-*+]|\d{1,3}[.)])(\s.*)?/) != nil {
                inList = true
            } else if inList, line.first?.isWhitespace == false {
                lines.append("")
                inList = false
            }
            // Two trailing spaces make a line break; headings and table rows end their line anyway.
            let breaks = !trimmed.isEmpty && !trimmed.hasPrefix("#") && !trimmed.hasPrefix("|")
            lines.append(breaks ? line + "  " : line)
        }
        return lines.joined(separator: "\n")
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let style: MarkdownStyle

    private var isDocument: Bool { style == .document }
    private var isStepBadge: Bool { isDocument && block.depth == 1 && block.ordered }

    var body: some View {
        let scale = Zoom.shared.scale
        if case .rule = block.kind {
            Divider()
        } else {
            let row = HStack(alignment: isStepBadge ? .top : .firstTextBaseline, spacing: (isStepBadge ? 10 : 6) * scale) {
                if block.depth > 0 {
                    listGutter(scale: scale)
                }
                content
            }
            .padding(.leading, CGFloat(max(block.depth - 1, 0)) * (isDocument ? 28 : 24) * scale)

            if block.quoted {
                row
                    .padding(.leading, (isDocument ? 14 : 12) * scale)
                    .padding(.trailing, isDocument ? 12 * scale : 0)
                    .padding(.vertical, isDocument ? 8 * scale : 0)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background {
                        if isDocument {
                            RoundedRectangle(cornerRadius: 6 * scale, style: .continuous)
                                .fill(Color.primary.opacity(0.035))
                        }
                    }
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(isDocument ? AnyShapeStyle(Color.accentColor.opacity(0.45)) : AnyShapeStyle(.quaternary))
                            .frame(width: 3 * scale)
                    }
                    .foregroundStyle(.secondary)
            } else {
                row
            }
        }
    }

    @ViewBuilder private func listGutter(scale: CGFloat) -> some View {
        if let checked = block.checked {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .font(.zoomed(size: isDocument ? 13 : 11.5, weight: .medium))
                .foregroundStyle(checked ? AnyShapeStyle(Color.boardGreen) : AnyShapeStyle(.secondary))
                .frame(width: (isDocument ? 20 : 18) * scale, alignment: .center)
        } else if isStepBadge {
            if let marker = block.marker {
                let number = marker.hasSuffix(".") ? String(marker.dropLast()) : marker
                Text(number)
                    .font(.zoomed(size: 11, weight: .semibold).monospacedDigit())
                    .foregroundStyle(Color.accentColor)
                    .frame(minWidth: 20 * scale, minHeight: 20 * scale)
                    .padding(.horizontal, number.count > 1 ? 4 * scale : 0)
                    .background(Color.accentColor.opacity(0.14), in: .capsule)
            } else {
                Color.clear.frame(width: 20 * scale, height: 1)
            }
        } else {
            Text(block.marker ?? "")
                .fontWeight(.semibold)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: (isDocument ? 22 : 18) * scale, alignment: .trailing)
        }
    }

    @ViewBuilder private var content: some View {
        let scale = Zoom.shared.scale
        switch block.kind {
        case .rule:
            EmptyView()
        case .paragraph:
            Text(block.content)
                .lineSpacing((isDocument ? 5 : 3) * scale)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .heading(let level):
            VStack(alignment: .leading, spacing: 6 * scale) {
                Text(block.content)
                    .font(headingFont(level: level))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if isDocument, level <= 2 {
                    Divider().opacity(level == 1 ? 0.9 : 0.5)
                }
            }
        case .code(let language):
            CodeBlockView(content: block.content, language: language, style: style)
        case .table(let rows):
            let columns = rows.map(\.count).max() ?? 0
            let table = TableLayout(columns: columns, horizontalSpacing: (isDocument ? 18 : 14) * scale, verticalSpacing: (isDocument ? 8 : 5) * scale) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                    // Short rows get empty cells, so every row starts in the first column.
                    ForEach(0..<columns, id: \.self) { column in
                        Text(cells.indices.contains(column) ? cells[column] : "")
                            .fontWeight(index == 0 ? .semibold : nil)
                            .foregroundStyle(index == 0 ? Color.primary : Color.primary.opacity(0.9))
                    }
                    if index == 0 { Divider().layoutValue(key: TableRule.self, value: true) }
                }
            }
            if isDocument {
                table
                    .font(.zoomed(size: 13.5, weight: .regular))
                    .padding(12 * scale)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.025), in: .rect(cornerRadius: 8 * scale, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 8 * scale, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.09), lineWidth: 1)
                    }
            } else {
                table
            }
        }
    }

    private func headingFont(level: Int) -> Font {
        if isDocument {
            return switch level {
            case 1: .zoomed(size: 20, weight: .bold)
            case 2: .zoomed(size: 17, weight: .bold)
            case 3: .zoomed(size: 15.5, weight: .semibold)
            default: .zoomed(size: 14.5, weight: .semibold)
            }
        }
        return level <= 2 ? .zoomed(.title3).weight(.semibold) : .zoomed(.body).weight(.semibold)
    }
}

/// A fenced code block: wrapped lines on a soft surface, with its language and a hover copy button in document mode.
private struct CodeBlockView: View {
    let content: AttributedString
    let language: String?
    let style: MarkdownStyle

    @State private var hovering = false
    @State private var copied = false

    var body: some View {
        let scale = Zoom.shared.scale
        let isDocument = style == .document
        let radius = (isDocument ? 8 : 6) * scale
        VStack(alignment: .leading, spacing: 0) {
            if isDocument, let language {
                HStack {
                    Text(language)
                        .font(.zoomed(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    Spacer()
                    copyButton(scale: scale)
                }
                .padding(.horizontal, 12 * scale)
                .padding(.vertical, 6 * scale)
                .background(Color.primary.opacity(0.03))
                Divider().opacity(0.5)
            }
            // Long lines wrap: a sideways scroller inside the sheet's own scroller is fiddly to use.
            Text(content)
                .font(.system(size: (isDocument ? 12.5 : BoardTextStyle.callout.rawValue) * scale, design: .monospaced))
                .lineSpacing((isDocument ? 3.5 : 2) * scale)
                .fixedSize(horizontal: false, vertical: true)
                .padding((isDocument ? 12 : 10) * scale)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .topTrailing) {
                    if isDocument, language == nil, hovering || copied {
                        copyButton(scale: scale)
                            .padding(8 * scale)
                    }
                }
        }
        .background(Color.primary.opacity(isDocument ? 0.04 : 0.05), in: .rect(cornerRadius: radius, style: .continuous))
        .overlay {
            if isDocument {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.09), lineWidth: 1)
            }
        }
        .clipShape(.rect(cornerRadius: radius, style: .continuous))
        .onHover { hovering = $0 }
    }

    private func copyButton(scale: CGFloat) -> some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(String(content.characters), forType: .string)
            copied = true
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.zoomed(size: 11, weight: .medium))
                .foregroundStyle(copied ? AnyShapeStyle(Color.boardGreen) : AnyShapeStyle(.secondary))
                .contentTransition(.symbolEffect(.replace))
                .padding(4 * scale)
                .background(.background.opacity(0.8), in: .rect(cornerRadius: 5 * scale))
        }
        .buttonStyle(.plain)
        .help(copied ? "Copied" : "Copy code")
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}
/// Marks a view in a `TableLayout` as a line across the whole table, on a row of its own.
private struct TableRule: LayoutValueKey {
    static let defaultValue = false
}

/// A Markdown table's cells in rows of `columns`, each row as tall as its tallest cell. SwiftUI's
/// Grid measured wrapped cells at one width and drew them at another, so a tall row spilled over
/// the text below the table. This measures every cell at the width it's drawn at.
private struct TableLayout: Layout {
    let columns: Int
    let horizontalSpacing: CGFloat
    let verticalSpacing: CGFloat

    private struct Row {
        var subviews: [LayoutSubview]
        var isRule: Bool
        var height: CGFloat = 0
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let (widths, rows) = measure(subviews, width: proposal.width)
        return CGSize(width: tableWidth(widths), height: tableHeight(rows))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let (widths, rows) = measure(subviews, width: bounds.width)
        var y = bounds.minY
        for row in rows {
            if row.isRule {
                row.subviews[0].place(at: CGPoint(x: bounds.minX, y: y), proposal: ProposedViewSize(width: tableWidth(widths), height: row.height))
            } else {
                var x = bounds.minX
                for (column, cell) in row.subviews.enumerated() {
                    // Cells sit centered in their row's height, like Grid's leading alignment.
                    let height = cell.sizeThatFits(ProposedViewSize(width: widths[column], height: nil)).height
                    cell.place(at: CGPoint(x: x, y: y + (row.height - height) / 2), proposal: ProposedViewSize(width: widths[column], height: height))
                    x += widths[column] + horizontalSpacing
                }
            }
            y += row.height + verticalSpacing
        }
    }

    /// The columns' widths within `width`, and the rows with their heights at those widths.
    private func measure(_ subviews: Subviews, width: CGFloat?) -> ([CGFloat], [Row]) {
        var rows: [Row] = []
        for subview in subviews {
            if subview[TableRule.self] {
                rows.append(Row(subviews: [subview], isRule: true))
            } else if let last = rows.indices.last, !rows[last].isRule, rows[last].subviews.count < columns {
                rows[last].subviews.append(subview)
            } else {
                rows.append(Row(subviews: [subview], isRule: false))
            }
        }
        var ideal = [CGFloat](repeating: 0, count: columns)
        for row in rows where !row.isRule {
            for (column, cell) in row.subviews.enumerated() {
                ideal[column] = max(ideal[column], cell.sizeThatFits(.unspecified).width)
            }
        }
        let widths = fitting(ideal, into: (width ?? .infinity) - horizontalSpacing * CGFloat(max(columns - 1, 0)))
        for index in rows.indices {
            rows[index].height = rows[index].isRule
                ? rows[index].subviews[0].sizeThatFits(ProposedViewSize(width: tableWidth(widths), height: nil)).height
                : rows[index].subviews.enumerated().map { column, cell in
                    cell.sizeThatFits(ProposedViewSize(width: widths[column], height: nil)).height
                }.max() ?? 0
        }
        return (widths, rows)
    }

    /// Columns that fit keep their ideal widths. When the table is too wide, narrow columns keep
    /// theirs and the wide ones share what's left equally, wrapping their text.
    private func fitting(_ ideal: [CGFloat], into available: CGFloat) -> [CGFloat] {
        guard ideal.reduce(0, +) > available else { return ideal }
        var widths = ideal
        var remaining = max(available, 0)
        var unsized = Array(ideal.indices).sorted { ideal[$0] < ideal[$1] }
        while let narrowest = unsized.first, ideal[narrowest] <= remaining / CGFloat(unsized.count) {
            remaining -= ideal[narrowest]
            unsized.removeFirst()
        }
        for column in unsized { widths[column] = remaining / CGFloat(unsized.count) }
        return widths
    }

    private func tableWidth(_ widths: [CGFloat]) -> CGFloat {
        widths.reduce(0, +) + horizontalSpacing * CGFloat(max(widths.count - 1, 0))
    }

    private func tableHeight(_ rows: [Row]) -> CGFloat {
        rows.map(\.height).reduce(0, +) + verticalSpacing * CGFloat(max(rows.count - 1, 0))
    }
}

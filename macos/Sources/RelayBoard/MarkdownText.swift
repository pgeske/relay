import SwiftUI

/// Markdown as agents write it in plans and task details, laid out block by block: paragraphs,
/// numbered and bulleted lists with hanging indents, headings, code blocks, quotes, and tables.
/// Line breaks are the agent's, as they wrote them.
struct MarkdownText: View {
    let text: String

    var body: some View {
        let blocks = MarkdownBlock.parse(text)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                MarkdownBlockView(block: block)
                    .padding(.top, index == 0 ? 0 : block.spacing(after: blocks[index - 1]) * Zoom.shared.scale)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One block of the text: a paragraph, heading, code block, or table, maybe inside a list item or a quote.
struct MarkdownBlock {
    enum Kind {
        case paragraph
        case heading(level: Int)
        case code
        /// Rows of cells, the first one the header.
        case table([[AttributedString]])
    }

    var kind: Kind
    var content: AttributedString
    /// How many lists it's inside: 0 outside any.
    var depth = 0
    /// The list item's number or bullet; nil outside lists, and for an item's later paragraphs.
    var marker: String?
    var quoted = false
    /// Which list item, outermost list, and table it's in, to group blocks that belong together.
    var item: Int?
    var list: Int?
    var table: Int?

    /// Space above this block when it follows `previous`, at 100% zoom: items of one list sit
    /// close together, a heading stands apart from what came before it.
    func spacing(after previous: MarkdownBlock) -> CGFloat {
        if case .heading = kind { return 14 }
        if case .heading = previous.kind { return 6 }
        if list != nil, list == previous.list { return 5 }
        return 10
    }

    static func parse(_ text: String) -> [MarkdownBlock] {
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
                case .codeBlock: block.kind = .code
                case .blockQuote: block.quoted = true
                case .orderedList, .unorderedList:
                    block.depth += 1
                    block.list = component.identity // Components run innermost first, so the last list is the outermost.
                case .listItem(let ordinal) where block.item == nil:
                    // The innermost item, whose list comes right after it.
                    block.item = component.identity
                    let ordered = components.indices.contains(index + 1) && components[index + 1].kind == .orderedList
                    let nested = components[index...].count { $0.kind == .orderedList || $0.kind == .unorderedList } > 1
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

    var body: some View {
        let scale = Zoom.shared.scale
        HStack(alignment: .firstTextBaseline, spacing: 6 * scale) {
            if block.depth > 0 {
                Text(block.marker ?? "")
                    .fontWeight(.semibold)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(width: 18 * scale, alignment: .trailing)
            }
            content
        }
        .padding(.leading, CGFloat(max(block.depth - 1, 0)) * 24 * scale)
        .padding(.leading, block.quoted ? 12 * scale : 0)
        .overlay(alignment: .leading) {
            if block.quoted {
                RoundedRectangle(cornerRadius: 1.5).fill(.quaternary).frame(width: 3 * scale)
            }
        }
        .foregroundStyle(block.quoted ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
    }

    @ViewBuilder private var content: some View {
        let scale = Zoom.shared.scale
        switch block.kind {
        case .paragraph:
            Text(block.content)
                .lineSpacing(3 * scale)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .heading(let level):
            Text(block.content)
                .font(level <= 2 ? .zoomed(.title3).weight(.semibold) : .zoomed(.body).weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .code:
            // Long lines wrap: a sideways scroller inside the popover's own scroller is fiddly to use.
            Text(block.content)
                .font(.system(size: BoardTextStyle.callout.rawValue * scale, design: .monospaced))
                .lineSpacing(2 * scale)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10 * scale)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.05), in: .rect(cornerRadius: 6))
        case .table(let rows):
            let columns = rows.map(\.count).max() ?? 0
            TableLayout(columns: columns, horizontalSpacing: 14 * scale, verticalSpacing: 5 * scale) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                    // Short rows get empty cells, so every row starts in the first column.
                    ForEach(0..<columns, id: \.self) { column in
                        Text(cells.indices.contains(column) ? cells[column] : "")
                            .fontWeight(index == 0 ? .semibold : nil)
                    }
                    if index == 0 { Divider().layoutValue(key: TableRule.self, value: true) }
                }
            }
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

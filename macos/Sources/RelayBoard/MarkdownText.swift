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
            Grid(alignment: .leading, horizontalSpacing: 14 * scale, verticalSpacing: 5 * scale) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                    GridRow {
                        ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                            Text(cell)
                                .fontWeight(index == 0 ? .semibold : nil)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if index == 0 { Divider().gridCellUnsizedAxes(.horizontal) }
                }
            }
        }
    }
}

import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// A screenshot pasted or dropped into a new task's details, sent with the task for its agent to read.
struct Screenshot: Identifiable {
    let id = UUID()
    let data: Data
    let mimeType: String
    let image: NSImage

    /// The formats the server saves as they are; anything else is converted to PNG.
    private static let sentAsIs: [(UTType, String)] = [(.png, "image/png"), (.jpeg, "image/jpeg"), (.gif, "image/gif"), (.webP, "image/webp")]

    /// Every image on a pasteboard: image files (Finder, a screenshot's thumbnail), else image data
    /// (a screenshot copied to the clipboard). Empty when it holds none, so text pastes as text.
    static func all(on pasteboard: NSPasteboard) -> [Screenshot] {
        let files = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if !files.isEmpty { return files.compactMap(fromFile) }
        for (type, mimeType) in sentAsIs {
            if let data = pasteboard.data(forType: NSPasteboard.PasteboardType(type.identifier)), let image = NSImage(data: data) {
                return [Screenshot(data: data, mimeType: mimeType, image: image)]
            }
        }
        // Text that also comes with a picture of itself (rich text, a web page's selection) pastes as text.
        guard pasteboard.string(forType: .string) == nil, let image = NSImage(pasteboard: pasteboard) else { return [] }
        return asPNG(image).map { [$0] } ?? []
    }

    /// Whether `all(on:)` would find an image, without reading any: checked on every drag movement.
    static func isOn(_ pasteboard: NSPasteboard) -> Bool {
        if pasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) {
            return pasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true, .urlReadingContentsConformToTypes: [UTType.image.identifier]])
        }
        if pasteboard.availableType(from: sentAsIs.map { NSPasteboard.PasteboardType($0.0.identifier) }) != nil { return true }
        return pasteboard.string(forType: .string) == nil && NSImage.canInit(with: pasteboard)
    }

    private static func fromFile(_ url: URL) -> Screenshot? {
        guard let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .image),
              let data = try? Data(contentsOf: url), let image = NSImage(data: data) else { return nil }
        if let (_, mimeType) = sentAsIs.first(where: { type.conforms(to: $0.0) }) {
            return Screenshot(data: data, mimeType: mimeType, image: image)
        }
        return asPNG(image)
    }

    private static func asPNG(_ image: NSImage) -> Screenshot? {
        guard let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return nil }
        return Screenshot(data: png, mimeType: "image/png", image: image)
    }
}

/// A plain-text box for a task's details that takes screenshots too: pasting or dropping an image
/// hands it to `onScreenshots` instead of the text. SwiftUI's text fields drop pasted images.
/// ⌘↩ calls `onSubmit`: SwiftUI's keyboard shortcuts don't hear keys typed into an AppKit text view.
/// As a chat's message box (`sendsOnReturn`), ↩ sends too and ⇧↩ starts a new line, and the box
/// grows with what you type, up to `maxLines`, then scrolls.
struct DetailsEditor: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    var sendsOnReturn = false
    var maxLines = 10
    /// Takes the keyboard once it's on screen.
    var focusOnAppear = false
    let onSubmit: () -> Void
    let onScreenshots: ([Screenshot]) -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = ScreenshotTextView.scrollableTextView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        // Only while scrolling, so a short note doesn't sit beside an empty scroll track.
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        let textView = scrollView.documentView as! ScreenshotTextView
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.textContainerInset = NSSize(width: 0, height: 4)
        textView.textContainer?.lineFragmentPadding = 0
        // A plain-text view only takes dropped text; add image files and image data.
        textView.registerForDraggedTypes(textView.registeredDraggedTypes + [.fileURL] + NSImage.imageTypes.map { NSPasteboard.PasteboardType($0) })
        if focusOnAppear {
            DispatchQueue.main.async { textView.window?.makeFirstResponder(textView) }
        }
        return scrollView
    }

    /// A chat's box is as tall as its text, between one line and `maxLines`; a task's details fill their frame.
    /// The text is measured on a copy: SwiftUI probes several widths, and squeezing the live text view's
    /// container to a probe would leave the text wrapping at that width once the box is laid out wider.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView scrollView: NSScrollView, context: Context) -> CGSize? {
        guard sendsOnReturn, let width = proposal.width, let textView = scrollView.documentView as? NSTextView,
              let font = textView.font else { return nil }
        let storage = NSTextStorage(string: textView.string, attributes: [.font: font])
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = textView.textContainer?.lineFragmentPadding ?? 0
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: container)
        let line = layout.defaultLineHeight(for: font)
        let inset = textView.textContainerInset.height * 2
        let height = min(max(layout.usedRect(for: container).height, line), line * CGFloat(maxLines))
        return CGSize(width: width, height: ceil(height + inset))
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        let textView = scrollView.documentView as! ScreenshotTextView
        textView.onScreenshots = onScreenshots
        textView.onSubmit = onSubmit
        textView.sendsOnReturn = sendsOnReturn
        textView.placeholder = placeholder
        let font = NSFont.systemFont(ofSize: (sendsOnReturn ? 14 : BoardTextStyle.body.rawValue) * Zoom.shared.scale)
        if textView.font != font {
            textView.font = font
            textView.typingAttributes[.font] = font
        }
        if textView.string != text { textView.string = text }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: DetailsEditor

        init(parent: DetailsEditor) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

/// The text view behind `DetailsEditor`: plain text, but images pasted or dropped on it become screenshots.
final class ScreenshotTextView: NSTextView {
    var onScreenshots: ([Screenshot]) -> Void = { _ in }
    var onSubmit: () -> Void = {}
    var sendsOnReturn = false
    var placeholder = "" { didSet { needsDisplay = true } }

    /// A plain-text view turns Paste off when the clipboard holds only an image, so ⌘V would never reach `paste`.
    override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(paste(_:)), Screenshot.isOn(.general) { return true }
        return super.validateUserInterfaceItem(item)
    }

    override func keyDown(with event: NSEvent) {
        let isReturn = event.keyCode == 36 || event.keyCode == 76  // Return, or Enter on a keypad
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
        // While an input method is composing (Japanese, say), Return picks the text instead.
        if isReturn, !hasMarkedText(), modifiers == .command || (sendsOnReturn && modifiers.isEmpty) {
            onSubmit()
        } else if isReturn, sendsOnReturn, modifiers == .shift || modifiers == .option {
            insertNewlineIgnoringFieldEditor(nil)
        } else {
            super.keyDown(with: event)
        }
    }

    override func paste(_ sender: Any?) {
        let screenshots = Screenshot.all(on: .general)
        if screenshots.isEmpty { super.paste(sender) } else { onScreenshots(screenshots) }
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        Screenshot.isOn(sender.draggingPasteboard) ? .copy : super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
        Screenshot.isOn(sender.draggingPasteboard) ? .copy : super.draggingUpdated(sender)
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        let screenshots = Screenshot.all(on: sender.draggingPasteboard)
        if screenshots.isEmpty { return super.performDragOperation(sender) }
        onScreenshots(screenshots)
        return true
    }

    override func didChangeText() {
        super.didChangeText()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, let font else { return }
        // Wrapped to the text's width, so a long placeholder runs onto more lines instead of off the edge.
        let inset = textContainer?.lineFragmentPadding ?? 0
        let rect = NSRect(x: textContainerOrigin.x + inset, y: textContainerOrigin.y, width: bounds.width - textContainerOrigin.x - 2 * inset, height: bounds.height)
        (placeholder as NSString).draw(in: rect, withAttributes: [.font: font, .foregroundColor: NSColor.placeholderTextColor])
    }
}

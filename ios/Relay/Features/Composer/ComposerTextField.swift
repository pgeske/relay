import SwiftUI
import UIKit

/// Multi-line message field that also accepts pasted images.
///
/// SwiftUI's `TextField` only pastes text, so with a screenshot on the clipboard
/// its Paste action never appears. This wraps a `UITextView` that offers Paste
/// whenever the clipboard holds images and hands them to `onPasteImages`.
struct ComposerTextField: UIViewRepresentable {
    @Binding var text: String
    let textColor: Color
    let maxLines: Int
    let onPasteImages: ([UIImage]) -> Void

    func makeUIView(context: Context) -> ImagePastingTextView {
        let textView = ImagePastingTextView()
        textView.delegate = context.coordinator
        textView.font = .preferredFont(forTextStyle: .body)
        textView.adjustsFontForContentSizeCategory = true
        textView.backgroundColor = .clear
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return textView
    }

    func updateUIView(_ textView: ImagePastingTextView, context: Context) {
        context.coordinator.text = $text
        textView.onPasteImages = onPasteImages
        textView.textColor = UIColor(textColor)
        // Only push external edits (dictation, clearing after send); rewriting the
        // text on every keystroke would reset the cursor and break autocorrect.
        if textView.text != text {
            textView.text = text
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView textView: ImagePastingTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let lineHeight = textView.font?.lineHeight ?? UIFont.preferredFont(forTextStyle: .body).lineHeight
        let contentHeight = textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let height = min(max(contentHeight, lineHeight), lineHeight * CGFloat(maxLines))
        return CGSize(width: width, height: height.rounded(.up))
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var text: Binding<String>

        init(text: Binding<String>) {
            self.text = text
        }

        func textViewDidChange(_ textView: UITextView) {
            text.wrappedValue = textView.text
        }
    }
}

final class ImagePastingTextView: UITextView {
    var onPasteImages: (([UIImage]) -> Void)?

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), UIPasteboard.general.hasImages {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        let pasteboard = UIPasteboard.general
        if pasteboard.hasImages, let images = pasteboard.images, !images.isEmpty {
            onPasteImages?(images)
            return
        }
        super.paste(sender)
    }
}

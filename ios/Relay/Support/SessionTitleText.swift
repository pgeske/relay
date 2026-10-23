import SwiftUI

extension Text {
    /// omp prefixes session titles with Nerd Font icons, which live in Unicode's Private Use
    /// Areas and render as "?" boxes in system fonts. This draws just those characters with
    /// the bundled Symbols Nerd Font and leaves the rest in the surrounding font.
    init(sessionTitle title: String, textStyle: Font.TextStyle) {
        var attributed = AttributedString()
        for character in title {
            var piece = AttributedString(String(character))
            if character.unicodeScalars.contains(where: Self.isPrivateUse) {
                piece.font = .custom("SymbolsNF", size: UIFont.preferredFont(forTextStyle: textStyle.uiKit).pointSize, relativeTo: textStyle)
            }
            attributed.append(piece)
        }
        self.init(attributed)
    }

    private static func isPrivateUse(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0xE000...0xF8FF, 0xF0000...0x10FFFF: true
        default: false
        }
    }
}

private extension Font.TextStyle {
    var uiKit: UIFont.TextStyle {
        switch self {
        case .largeTitle: .largeTitle
        case .title: .title1
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .subheadline: .subheadline
        case .callout: .callout
        case .caption: .caption1
        case .caption2: .caption2
        case .footnote: .footnote
        default: .body
        }
    }
}

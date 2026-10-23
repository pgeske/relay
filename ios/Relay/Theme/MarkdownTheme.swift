@preconcurrency import MarkdownUI
import SwiftUI

extension AppTheme {
    /// A MarkdownUI theme built from the active palette.
    ///
    /// Theme builders are escaping closures that run during SwiftUI rendering,
    /// so they are always invoked on the main actor.
    @MainActor
    var markdownTheme: MarkdownUI.Theme {
        MarkdownUI.Theme()
            .text {
                ForegroundColor(primaryText)
            }
            .code {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.94))
                ForegroundColor(inlineCodeForeground)
                BackgroundColor(inlineCodeBackground)
            }
            .link {
                ForegroundColor(link)
            }
            .heading1 { configuration in
                heading(configuration, size: 1.9)
            }
            .heading2 { configuration in
                heading(configuration, size: 1.6)
            }
            .heading3 { configuration in
                heading(configuration, size: 1.35)
            }
            .heading4 { configuration in
                heading(configuration, size: 1.2)
            }
            .heading5 { configuration in
                heading(configuration, size: 1.08)
            }
            .heading6 { configuration in
                heading(configuration, size: 1)
            }
            .paragraph { configuration in
                configuration.label
                    .relativeLineSpacing(.em(0.22))
                    .markdownMargin(top: .zero, bottom: .em(0.9))
            }
            .blockquote { configuration in
                configuration.label
                    .markdownTextStyle {
                        ForegroundColor(secondaryText)
                    }
                    .padding(.vertical, 4)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(separator)
                            .frame(width: 3)
                    }
                    .markdownMargin(top: .zero, bottom: .em(1))
            }
            .codeBlock { configuration in
                ScrollView(.horizontal, showsIndicators: true) {
                    configuration.label
                        .fixedSize(horizontal: true, vertical: false)
                        .relativeLineSpacing(.em(0.15))
                        .padding(10)
                        .markdownTextStyle {
                            FontFamilyVariant(.monospaced)
                            FontSize(.em(0.9))
                            ForegroundColor(primaryText)
                        }
                }
                .background(
                    codeBackground,
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
                .markdownMargin(top: .zero, bottom: .em(1))
            }
            .tableCell { configuration in
                configuration.label
                    .markdownTextStyle {
                        if configuration.row == 0 {
                            FontWeight(.semibold)
                        }
                        ForegroundColor(primaryText)
                    }
                    .fixedSize(horizontal: false, vertical: true)
            }
            .thematicBreak {
                Rectangle()
                    .fill(separator)
                    .frame(height: 1)
                    .markdownMargin(top: .em(1), bottom: .em(1))
            }
    }

    @MainActor
    private func heading(_ configuration: BlockConfiguration, size: CGFloat) -> some View {
        configuration.label
            .markdownMargin(top: .em(1.2), bottom: .em(0.6))
            .markdownTextStyle {
                FontWeight(.semibold)
                FontSize(.em(size))
                ForegroundColor(primaryText)
            }
    }
}

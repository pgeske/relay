import AppKit
import SwiftUI

/// Relay Board: where each of your pull requests is, from draft to merged, read from relay's
/// server. Its buttons hand each step to the omp session in charge of the PR.
@main
struct RelayBoardApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = BoardModel()
    private let zoom = Zoom.shared

    var body: some Scene {
        Window("Relay Board", id: "board") {
            BoardWindow()
                .environment(model)
                .frame(minWidth: 820, minHeight: 520)
        }
        .defaultSize(width: 1720, height: 980)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(before: .toolbar) {
                Button("Refresh") { model.refreshNow() }
                    .keyboardShortcut("r")
                Divider()
                Button("Actual Size") { zoom.reset() }
                    .keyboardShortcut("0")
                Button("Zoom In") { zoom.zoomIn() }
                    .keyboardShortcut("+")
                    .disabled(!zoom.canZoomIn)
                Button("Zoom Out") { zoom.zoomOut() }
                    .keyboardShortcut("-")
                    .disabled(!zoom.canZoomOut)
                Divider()
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// The board is the app's one window: closing it quits.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

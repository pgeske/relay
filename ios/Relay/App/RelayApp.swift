import SwiftUI

@main
struct RelayApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                .task {
                    VoiceModelWarmer.warmUpIfPreviouslyUsed()
                }
        }
    }
}

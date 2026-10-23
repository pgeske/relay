import SwiftUI

/// Starts a session right away when there is one host; with several, asks which one first.
struct NewSessionButton<Label: View>: View {
    let model: AppModel
    @ViewBuilder let label: () -> Label

    var body: some View {
        if model.hosts.count > 1 {
            Menu {
                Section("New session on") {
                    ForEach(model.hosts) { host in
                        Button(host.name) {
                            Task { await model.createNewSession(on: host) }
                        }
                    }
                }
            } label: {
                label()
            }
        } else if let host = model.hosts.first {
            Button {
                Task { await model.createNewSession(on: host) }
            } label: {
                label()
            }
        }
    }
}

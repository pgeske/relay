import SwiftUI

struct ChatScreen: View {
    private let session: HostedSession
    private let model: AppModel

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.appTheme) private var theme
    @State private var chat: ChatStore

    init(session: HostedSession, model: AppModel) {
        self.session = session
        self.model = model
        _chat = State(initialValue: ChatStore(session: session.session, api: session.api))
    }

    /// Shown in the header only when there are several hosts to tell apart.
    private var hostName: String? {
        guard model.hosts.count > 1 else { return nil }
        return model.hosts.first { $0.id == session.hostID }?.name
    }

    var body: some View {
        VStack(spacing: 0) {
            MessageListView(store: chat, api: session.api)
            // While omp shows its ask dialog, keystrokes go to the dialog, not the message box.
            if let ask = chat.pendingAsk {
                AskPanel(chat: chat, call: ask)
            } else {
                ComposerView(chat: chat) { message in
                    model.showError(message)
                }
            }
        }
        // Fill behind the keyboard too; otherwise the window's black shows around its rounded top.
        .background(theme.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(theme.secondaryBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                HStack(spacing: 14) {
                    Button {
                        model.isShowingSessions = true
                    } label: {
                        Image(systemName: "sidebar.left")
                    }
                    Button {
                        model.isShowingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            ToolbarItem(placement: .principal) {
                ChatHeader(
                    title: chat.info.displayTitle,
                    hostName: hostName,
                    working: chat.working,
                    connection: chat.connection
                )
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    Task { await chat.startNewConversation() }
                } label: {
                    if chat.isStartingNewConversation {
                        ProgressView()
                            .tint(theme.accent)
                    } else {
                        Image(systemName: "square.and.pencil")
                    }
                }
                .disabled(chat.isStartingNewConversation)
                .accessibilityLabel("New conversation in this session")
                NewSessionButton(model: model) {
                    Image(systemName: "plus")
                }
                .disabled(model.isCreatingSession)
            }
        }
        .task {
            await chat.start()
        }
        .onDisappear {
            chat.stop()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                chat.foregrounded()
            }
        }
        .onChange(of: chat.errorMessage) { _, message in
            guard let message else { return }
            model.showError(message)
            chat.errorMessage = nil
        }
        .onChange(of: chat.connection) { _, connection in
            if connection == .disconnected {
                model.handleSessionClosed(session.id)
            }
        }
    }
}

private struct ChatHeader: View {
    let title: String
    let hostName: String?
    let working: Bool
    let connection: ConnectionState

    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(spacing: 1) {
            Text(sessionTitle: title, textStyle: .headline)
                .font(.headline)
                .foregroundStyle(theme.primaryText)
                .lineLimit(1)
                .truncationMode(.tail)

            HStack(spacing: 4) {
                if working {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(theme.working)
                } else {
                    Circle()
                        .fill(connectionColor)
                        .frame(width: 5, height: 5)
                }
                Text(statusLine)
                    .font(.caption2)
                    .foregroundStyle(theme.secondaryText)
            }
        }
        .frame(maxWidth: 210)
    }

    private var statusLine: String {
        var parts = working ? ["Working…", connection.label] : [connection.label]
        if let hostName {
            parts.append(hostName)
        }
        return parts.joined(separator: " · ")
    }

    private var connectionColor: Color {
        switch connection {
        case .connected: theme.connected
        case .connecting, .reconnecting: theme.pending
        case .disconnected: theme.error
        }
    }
}

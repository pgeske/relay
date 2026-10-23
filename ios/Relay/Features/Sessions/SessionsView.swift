import SwiftUI

struct SessionsView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.appTheme) private var theme
    @State private var pendingClose: HostedSession?

    var body: some View {
        NavigationStack {
            List {
                if model.hosts.isEmpty {
                    Section {
                        Text("Run `relay pair` on your computer and scan the code with the Camera app, or add a host manually in Settings.")
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryText)
                            .listRowBackground(theme.secondaryBackground)
                    }
                } else {
                    Section {
                        NewSessionButton(model: model) {
                            HStack(spacing: 10) {
                                if model.isCreatingSession {
                                    ProgressView()
                                } else {
                                    Image(systemName: "plus.circle.fill")
                                        .foregroundStyle(theme.accent)
                                }
                                Text("New session")
                                    .fontWeight(.semibold)
                                    .foregroundStyle(theme.primaryText)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 4)
                        }
                        .disabled(model.isCreatingSession)
                        .listRowBackground(theme.secondaryBackground)
                    }
                }

                ForEach(model.sessions.hosts) { host in
                    Section {
                        ForEach(host.sessions) { session in
                            sessionRow(host.hosted(session))
                        }

                        if let error = host.lastError {
                            Text(error)
                                .font(.footnote)
                                .foregroundStyle(theme.error)
                                .listRowBackground(theme.elevatedSurface)
                        } else if host.hasLoaded && host.sessions.isEmpty {
                            Text("No sessions")
                                .font(.footnote)
                                .foregroundStyle(theme.tertiaryText)
                                .listRowBackground(theme.secondaryBackground)
                        }
                    } header: {
                        HostSectionHeader(host: host)
                    }
                }
            }
            // Plain rather than inset-grouped: inset rows have rounded section corners that
            // turn square while a row is swiped, which looks broken.
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(theme.secondaryBackground)
            .refreshable {
                await model.sessions.refresh()
            }
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(theme.secondaryBackground, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.sessions.refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .confirmationDialog(
                "Close this session?",
                isPresented: Binding(
                    get: { pendingClose != nil },
                    set: { if !$0 { pendingClose = nil } }
                ),
                titleVisibility: .visible,
                presenting: pendingClose
            ) { session in
                Button("Close session", role: .destructive) {
                    Task { await model.close(session) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { session in
                Text("This stops the tmux window running “\(session.session.displayTitle)”.")
            }
            .task {
                model.sessions.startPolling()
                await model.sessions.refresh()
            }
            .onDisappear {
                model.sessions.stopPolling()
            }
        }
    }

    // A plain tap gesture, not a Button: a Button's press handling
    // competes with the swipe and makes it hitch as it starts.
    private func sessionRow(_ session: HostedSession) -> some View {
        let isCurrent = session.id == model.currentSession?.id
        return SessionRow(session: session.session, isCurrent: isCurrent)
            .onTapGesture {
                model.select(session)
                dismiss()
            }
            .listRowBackground(isCurrent ? theme.elevatedSurface : theme.secondaryBackground)
            .listRowSeparatorTint(theme.separator)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                // Not `role: .destructive`: that makes SwiftUI remove the row
                // immediately, before the confirmation dialog appears.
                Button {
                    pendingClose = session
                } label: {
                    Label("Close", systemImage: "xmark")
                }
                .tint(theme.error)
            }
    }
}

/// A host's name, like a folder heading, plus whether it can be reached.
private struct HostSectionHeader: View {
    let host: HostSessions

    @Environment(\.appTheme) private var theme

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "desktopcomputer")
            Text(host.host.name)
            Spacer(minLength: 0)
            if host.lastError != nil {
                Label("Offline", systemImage: "wifi.slash")
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(theme.error)
            } else if !host.hasLoaded {
                ProgressView()
                    .controlSize(.mini)
            }
        }
        .foregroundStyle(theme.secondaryText)
    }
}

struct SessionRow: View {
    let session: Session
    let isCurrent: Bool

    @Environment(\.appTheme) private var theme

    var body: some View {
        HStack(spacing: 12) {
            SessionStatusDot(status: session.status, unread: session.unread)
                .frame(width: 16)

            VStack(alignment: .leading, spacing: 3) {
                Text(sessionTitle: session.displayTitle, textStyle: .body)
                    .font(.body)
                    .foregroundStyle(theme.primaryText)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    Text(session.directoryName)
                    if let updated = relativeUpdated {
                        Text("·")
                        Text(updated)
                    }
                }
                .font(.caption)
                .foregroundStyle(theme.secondaryText)
                .lineLimit(1)
            }

            Spacer(minLength: 0)

            if session.focused {
                Image(systemName: "macbook")
                    .font(.caption)
                    .foregroundStyle(theme.tertiaryText)
            }
            if isCurrent {
                Image(systemName: "checkmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(theme.accent)
            }
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }

    private var relativeUpdated: String? {
        guard let date = session.updatedDate else { return nil }
        return date.formatted(.relative(presentation: .named))
    }
}

struct SessionStatusDot: View {
    let status: SessionStatus
    let unread: Bool

    @Environment(\.appTheme) private var theme

    var body: some View {
        if status == .working {
            ProgressView()
                .controlSize(.mini)
                .tint(theme.working)
        } else {
            Circle()
                .fill(unread ? theme.unread : theme.tertiaryText.opacity(0.5))
                .frame(width: 8, height: 8)
                .frame(maxWidth: .infinity)
        }
    }
}

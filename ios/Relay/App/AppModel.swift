import Foundation
import Observation

struct Banner: Identifiable, Equatable {
    enum Kind {
        case error
        case success
    }

    let id = UUID()
    let message: String
    var kind: Kind = .error
}

/// Top-level app state: the hosts, the session drawer, and the current chat.
@MainActor
@Observable
final class AppModel {
    private(set) var hosts: [Host]
    private(set) var sessions: SessionsStore
    private(set) var currentSession: HostedSession?
    private(set) var didFinishLaunching = false
    private(set) var isCreatingSession = false
    private(set) var configRevision = 0

    var isShowingSessions = false
    var isShowingSettings = false
    var banner: Banner?

    init() {
        let hosts = AppConfig.hosts
        self.hosts = hosts
        self.sessions = SessionsStore(hosts: hosts)
    }

    func start() async {
        guard !didFinishLaunching else { return }
        await retry()
    }

    /// Loads every host at once and opens a session as soon as a good pick is known,
    /// without waiting on hosts that are slow or offline. `reportErrors` is off after
    /// host edits, whose confirmation shouldn't be replaced by an offline banner.
    func retry(reportErrors: Bool = true) async {
        await withTaskGroup(of: Void.self) { group in
            for host in sessions.hosts {
                group.addTask { await host.refresh() }
            }
            for await _ in group {
                chooseInitialSessionIfNeeded()
            }
        }
        didFinishLaunching = true
        chooseInitialSessionIfNeeded()
        if reportErrors, currentSession == nil,
           let failed = sessions.hosts.first(where: { $0.lastError != nil }),
           let error = failed.lastError {
            showError(error, from: failed.host)
        }
    }

    func select(_ session: HostedSession) {
        currentSession = session
        AppConfig.lastSession = session.id
    }

    func createNewSession(on host: Host) async {
        guard !isCreatingSession, let store = sessions.store(for: host.id) else { return }
        isCreatingSession = true
        defer { isCreatingSession = false }

        do {
            let session = try await store.createSession()
            select(store.hosted(session))
            isShowingSessions = false
        } catch {
            showError(APIError.describe(error), from: host)
        }
    }

    func close(_ session: HostedSession) async {
        guard let store = sessions.store(for: session.hostID) else { return }
        do {
            try await store.close(session.session)
            if currentSession?.id == session.id {
                currentSession = nil
                AppConfig.lastSession = nil
                chooseInitialSessionIfNeeded()
            }
        } catch {
            showError(APIError.describe(error), from: store.host)
        }
    }

    /// Called when the live stream reports that a tmux pane went away.
    func handleSessionClosed(_ key: SessionKey) {
        guard currentSession?.id == key else { return }
        currentSession = nil
        AppConfig.lastSession = nil
        Task {
            await sessions.store(for: key.hostID)?.refresh()
            chooseInitialSessionIfNeeded(excluding: key)
        }
    }

    // MARK: - Hosts

    /// Adds the host, or replaces the one with the same id.
    func save(_ host: Host) {
        var updated = hosts
        if let index = updated.firstIndex(where: { $0.id == host.id }) {
            updated[index] = host
        } else {
            updated.append(host)
        }
        setHosts(updated)
    }

    func delete(_ host: Host) {
        setHosts(hosts.filter { $0.id != host.id })
    }

    /// Handles `relay://pair?url=…&token=…&name=…` from the QR code `relay pair` shows.
    func handlePairingLink(_ url: URL) {
        guard url.scheme?.lowercased() == "relay", url.host?.lowercased() == "pair" else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String {
            (items.first { $0.name == name }?.value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let token = value("token")
        guard let baseURL = Host.baseURL(from: value("url")), !token.isEmpty else {
            showError("That pairing code is incomplete. Run relay pair again and rescan.")
            return
        }
        let linkName = value("name")
        let name = linkName.isEmpty ? Host.defaultName(for: baseURL) : linkName

        // Re-pairing a known computer refreshes its token instead of adding a duplicate.
        let isUpdate: Bool
        if var existing = hosts.first(where: { $0.hasSameBaseURL(as: baseURL) }) {
            existing.name = name
            existing.token = token
            save(existing)
            isUpdate = true
        } else {
            save(Host(name: name, baseURL: baseURL, token: token))
            isUpdate = false
        }

        // Show where the host landed; Settings already lists it if it's open.
        if !isShowingSettings {
            isShowingSessions = true
        }
        banner = Banner(message: isUpdate ? "Updated \(name)." : "Paired with \(name).", kind: .success)
    }

    private func setHosts(_ newHosts: [Host]) {
        let oldHosts = hosts
        hosts = newHosts
        AppConfig.hosts = newHosts
        sessions.update(hosts: newHosts)

        if let current = currentSession {
            let old = oldHosts.first { $0.id == current.hostID }
            let new = newHosts.first { $0.id == current.hostID }
            if new == nil {
                currentSession = nil
                AppConfig.lastSession = nil
            } else if old?.baseURL != new?.baseURL || old?.token != new?.token {
                // Reopen the same chat through the new connection.
                currentSession = nil
                configRevision += 1
            }
        }

        if currentSession == nil {
            didFinishLaunching = false
            Task { await retry(reportErrors: false) }
        }
    }

    // MARK: - Banners

    func showError(_ message: String) {
        banner = Banner(message: message)
    }

    /// Names the host in the message once there is more than one to tell apart.
    func showError(_ message: String, from host: Host) {
        showError(hosts.count > 1 ? "\(host.name): \(message)" : message)
    }

    private func chooseInitialSessionIfNeeded(excluding excluded: SessionKey? = nil) {
        guard currentSession == nil else { return }

        let available = sessions.allSessions.filter { $0.id != excluded }

        if let saved = AppConfig.lastSession {
            if let match = available.first(where: { $0.id == saved }) {
                select(match)
                return
            }
            // Give the saved session's host a chance to answer before picking another.
            if sessions.store(for: saved.hostID)?.hasLoaded == false {
                return
            }
        }
        if let focused = available.first(where: { $0.session.focused }) {
            currentSession = focused
            return
        }
        currentSession = available.first
    }
}

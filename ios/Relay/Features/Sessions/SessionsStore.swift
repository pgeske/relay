import Foundation
import Observation

/// A session together with the host it runs on and the client that reaches it.
struct HostedSession: Identifiable {
    let session: Session
    let hostID: UUID
    let api: APIClient

    var id: SessionKey { SessionKey(hostID: hostID, sessionID: session.id) }
}

/// One host's session list. Each host loads and polls on its own, so an
/// offline host never holds up or clears the others.
@MainActor
@Observable
final class HostSessions: Identifiable {
    let id: UUID
    private(set) var host: Host
    let api: APIClient
    private(set) var sessions: [Session] = []
    /// True once the first refresh finished, whether or not it succeeded.
    private(set) var hasLoaded = false
    private(set) var lastError: String?

    private var pollTask: Task<Void, Never>?

    init(host: Host) {
        self.id = host.id
        self.host = host
        self.api = APIClient(host: host)
    }

    /// Renames in place; only a new URL or token needs a new client.
    func rename(to host: Host) {
        self.host = host
    }

    func hosted(_ session: Session) -> HostedSession {
        HostedSession(session: session, hostID: id, api: api)
    }

    func refresh() async {
        do {
            let fetched = try await api.fetchSessions()
            // Only publish real changes; reassigning every poll re-renders the list and
            // interrupts in-progress swipes.
            if fetched != sessions {
                sessions = fetched
            }
            lastError = nil
            hasLoaded = true
        } catch is CancellationError {
            // The view went away; leave state untouched.
        } catch {
            if Task.isCancelled { return }
            lastError = APIError.describe(error)
            hasLoaded = true
        }
    }

    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard let self, !Task.isCancelled else { return }
                await self.refresh()
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    func createSession() async throws -> Session {
        let session = try await api.createSession()
        await refresh()
        return session
    }

    func close(_ session: Session) async throws {
        try await api.deleteSession(id: session.id)
        sessions.removeAll { $0.id == session.id }
        await refresh()
    }
}

/// The session lists of every host, in the user's host order.
@MainActor
@Observable
final class SessionsStore {
    private(set) var hosts: [HostSessions] = []
    private var isPolling = false

    init(hosts: [Host]) {
        update(hosts: hosts)
    }

    /// Every known session, grouped by host in host order.
    var allSessions: [HostedSession] {
        hosts.flatMap { host in host.sessions.map(host.hosted) }
    }

    var hasLoadedAll: Bool {
        hosts.allSatisfy(\.hasLoaded)
    }

    func store(for hostID: UUID) -> HostSessions? {
        hosts.first { $0.id == hostID }
    }

    /// Keeps the loaded state of hosts whose URL and token didn't change.
    func update(hosts newHosts: [Host]) {
        let existing = hosts
        hosts = newHosts.map { host in
            if let store = existing.first(where: { $0.id == host.id }),
               store.host.baseURL == host.baseURL, store.host.token == host.token {
                store.rename(to: host)
                return store
            }
            let store = HostSessions(host: host)
            if isPolling {
                store.startPolling()
            }
            return store
        }
        for store in existing where !hosts.contains(where: { $0 === store }) {
            store.stopPolling()
        }
    }

    /// Refreshes every host concurrently and returns once all have answered or failed.
    func refresh() async {
        await withTaskGroup(of: Void.self) { group in
            for host in hosts {
                group.addTask { await host.refresh() }
            }
        }
    }

    func startPolling() {
        isPolling = true
        hosts.forEach { $0.startPolling() }
    }

    func stopPolling() {
        isPolling = false
        hosts.forEach { $0.stopPolling() }
    }
}

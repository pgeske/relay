import Foundation

/// One computer running the relay server.
struct Host: Codable, Identifiable, Hashable, Sendable {
    let id: UUID
    var name: String
    var baseURL: URL
    var token: String

    init(id: UUID = UUID(), name: String, baseURL: URL, token: String) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.token = token
    }

    /// Parses a user- or link-supplied base URL; only http(s) URLs with a host qualify.
    static func baseURL(from string: String) -> URL? {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.host?.isEmpty == false
        else { return nil }
        return url
    }

    /// The name a host gets when none is given, e.g. from a bare URL.
    static func defaultName(for url: URL) -> String {
        url.host ?? "Mac"
    }

    /// Whether two base URLs point at the same server, ignoring a trailing slash.
    func hasSameBaseURL(as url: URL) -> Bool {
        Self.normalized(baseURL) == Self.normalized(url)
    }

    private static func normalized(_ url: URL) -> String {
        var string = url.absoluteString.lowercased()
        while string.hasSuffix("/") {
            string.removeLast()
        }
        return string
    }
}

/// Identifies a session across hosts; tmux pane ids are only unique per host.
struct SessionKey: Codable, Hashable, Sendable {
    let hostID: UUID
    let sessionID: String
}

/// Values persisted in UserDefaults.
enum AppConfig {
    private enum Keys {
        static let hosts = "omp.hosts"
        static let lastSession = "omp.lastSession"
        static let voiceModelUnlocked = "omp.voiceModelUnlocked"

        // Single-server settings from before multiple hosts; migrated once.
        static let legacyServerURL = "omp.serverURL"
        static let legacyToken = "omp.token"
        static let legacyLastSession = "omp.lastSessionID"
    }

    static var hosts: [Host] {
        get {
            let defaults = UserDefaults.standard
            if let data = defaults.data(forKey: Keys.hosts) {
                return (try? JSONDecoder().decode([Host].self, from: data)) ?? []
            }
            return migrateLegacyServer()
        }
        set {
            if let data = try? JSONEncoder().encode(newValue) {
                UserDefaults.standard.set(data, forKey: Keys.hosts)
            }
        }
    }

    static var lastSession: SessionKey? {
        get {
            UserDefaults.standard.data(forKey: Keys.lastSession)
                .flatMap { try? JSONDecoder().decode(SessionKey.self, from: $0) }
        }
        set {
            if let newValue, let data = try? JSONEncoder().encode(newValue) {
                UserDefaults.standard.set(data, forKey: Keys.lastSession)
            } else {
                UserDefaults.standard.removeObject(forKey: Keys.lastSession)
            }
        }
    }

    /// Set after the first successful dictation so the model can be warmed at launch.
    static var voiceModelUnlocked: Bool {
        get { UserDefaults.standard.bool(forKey: Keys.voiceModelUnlocked) }
        set { UserDefaults.standard.set(newValue, forKey: Keys.voiceModelUnlocked) }
    }

    /// Turns the old single-server URL and token into the first host, then drops the old keys.
    private static func migrateLegacyServer() -> [Host] {
        let defaults = UserDefaults.standard
        let token = (defaults.string(forKey: Keys.legacyToken) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        var migrated: [Host] = []
        if let url = Host.baseURL(from: defaults.string(forKey: Keys.legacyServerURL) ?? ""),
           !token.isEmpty {
            let host = Host(name: Host.defaultName(for: url), baseURL: url, token: token)
            migrated = [host]
            if let sessionID = defaults.string(forKey: Keys.legacyLastSession) {
                lastSession = SessionKey(hostID: host.id, sessionID: sessionID)
            }
        }

        hosts = migrated
        defaults.removeObject(forKey: Keys.legacyServerURL)
        defaults.removeObject(forKey: Keys.legacyToken)
        defaults.removeObject(forKey: Keys.legacyLastSession)
        return migrated
    }
}

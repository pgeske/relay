import Foundation

/// Where relay's server is and how to sign in to it. The board's endpoints answer only this
/// computer, and only with the token relay's server keeps in its config directory (mode 600):
/// this app can read that file, a web page can't.
struct RelayServer: Sendable {
    var port: Int
    var tokenFile: URL

    /// `relay board` passes RELAY_PORT and XDG_CONFIG_HOME along when they're set; otherwise relay's defaults.
    static func fromEnvironment() -> RelayServer {
        let environment = ProcessInfo.processInfo.environment
        let port = environment["RELAY_PORT"].flatMap { Int($0) } ?? 7878
        let configHome = environment["XDG_CONFIG_HOME"].flatMap { $0.isEmpty ? nil : URL(filePath: $0, directoryHint: .isDirectory) }
            ?? URL.homeDirectory.appending(path: ".config", directoryHint: .isDirectory)
        return RelayServer(port: port, tokenFile: configHome.appending(path: "relay/token"))
    }

    /// The token file's path as a person would type it.
    var tokenPath: String {
        let home = URL.homeDirectory.path(percentEncoded: false)
        let path = tokenFile.path(percentEncoded: false)
        return path.hasPrefix(home) ? "~/" + path.dropFirst(home.count).drop { $0 == "/" } : path
    }
}

enum BoardError: Error, Equatable {
    /// Nothing answers on relay's port.
    case serverNotRunning
    case noToken(path: String)
    /// The server didn't take the token.
    case unauthorized
    /// The server has no board endpoints yet.
    case serverTooOld
    case server(status: Int, message: String)
}

struct ActionResult: Sendable {
    var ok: Bool
    var status: Int
    var message: String
}

struct BoardClient: Sendable {
    var server: RelayServer

    private static let session = URLSession(configuration: .ephemeral)

    func board() async throws -> Board {
        let (data, response) = try await send("api/board")
        switch response.statusCode {
        case 200:
            do {
                return try Self.decoder().decode(Board.self, from: data)
            } catch {
                throw BoardError.server(status: 200, message: "relay's server sent a board this app can't read")
            }
        case 401: throw BoardError.unauthorized
        case 404: throw BoardError.serverTooOld
        default: throw BoardError.server(status: response.statusCode, message: Self.message(in: data) ?? "HTTP \(response.statusCode)")
        }
    }

    /// Runs one of a card's controls. The server answers every outcome with a sentence to show,
    /// so only failing to reach it throws. `plan` names the plan an Approve Plan is for.
    func perform(_ action: String, on target: ActionTarget, plan: String? = nil) async throws -> ActionResult {
        let path: String
        let body: Data
        switch target {
        case .pr(let ref):
            path = "api/board/actions/\(action)"
            body = try JSONSerialization.data(withJSONObject: ["pr": ref])
        case .task(let id):
            path = "api/board/tasks/actions/\(action)"
            var fields: [String: Any] = ["task": id]
            if let plan { fields["plan"] = plan }
            body = try JSONSerialization.data(withJSONObject: fields)
        case .session(let file):
            path = "api/board/tasks/actions/\(action)"
            body = try JSONSerialization.data(withJSONObject: ["session": file])
        }
        return try await post(path, body: body)
    }

    /// Creates a task, starting a session on it when the sheet asked to.
    func create(_ task: NewTask) async throws -> ActionResult {
        try await post("api/board/tasks", body: try JSONEncoder().encode(task))
    }

    /// Makes, renames, or deletes a project: `action` is create, rename, or delete.
    func project(_ action: String, project: Int? = nil, name: String? = nil, parent: Int? = nil) async throws -> ActionResult {
        var fields: [String: Any] = [:]
        if let project { fields["project"] = project }
        if let name { fields["name"] = name }
        if let parent { fields["parent"] = parent }
        return try await post("api/board/projects/\(action)", body: try JSONSerialization.data(withJSONObject: fields))
    }

    /// The models omp can start a task's sessions on, and its default.
    func models() async throws -> ModelChoices {
        let (data, response) = try await send("api/models")
        guard response.statusCode == 200 else {
            throw BoardError.server(status: response.statusCode, message: Self.message(in: data) ?? "HTTP \(response.statusCode)")
        }
        return try JSONDecoder().decode(ModelChoices.self, from: data)
    }

    private func post(_ path: String, body: Data) async throws -> ActionResult {
        let (data, response) = try await send(path, method: "POST", body: body)
        let ok = (200..<300).contains(response.statusCode)
        let fallback = ok ? "Done" : "Something went wrong (HTTP \(response.statusCode))"
        return ActionResult(ok: ok, status: response.statusCode, message: Self.message(in: data) ?? fallback)
    }

    private func send(_ path: String, method: String = "GET", body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        let token: String
        do {
            token = try String(contentsOf: server.tokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            throw BoardError.noToken(path: server.tokenPath)
        }
        guard !token.isEmpty else { throw BoardError.noToken(path: server.tokenPath) }

        // A step can wait for a closed session to reopen, and the board for GitHub: be patient.
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(server.port)/\(path)")!, timeoutInterval: 120)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        do {
            let (data, response) = try await Self.session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw BoardError.server(status: 0, message: "relay's server sent no HTTP response") }
            return (data, http)
        } catch let error as URLError where [.cannotConnectToHost, .cannotFindHost, .networkConnectionLost].contains(error.code) {
            throw BoardError.serverNotRunning
        }
    }

    /// The `message` or `error` sentence of a server reply.
    private static func message(in data: Data) -> String? {
        let body = try? JSONDecoder().decode([String: String].self, from: data)
        return body?["message"] ?? body?["error"]
    }

    /// Dates arrive as ISO 8601, with fractional seconds from relay and without from GitHub.
    private static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text)) ?? (try? Date.ISO8601FormatStyle().parse(text)) {
                return date
            }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not an ISO 8601 date: \(text)"))
        }
        return decoder
    }
}

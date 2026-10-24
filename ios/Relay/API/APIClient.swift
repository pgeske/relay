import Foundation

struct APIError: LocalizedError, Sendable {
    let message: String
    let statusCode: Int?

    var errorDescription: String? { message }

    static func describe(_ error: Error) -> String {
        if let apiError = error as? APIError {
            return apiError.message
        }
        if error is CancellationError {
            return "Cancelled."
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cannotConnectToHost, .cannotFindHost:
                return "Can't reach this computer. Is relay running and is Tailscale connected?"
            case .timedOut:
                return "The server took too long to respond."
            case .notConnectedToInternet, .networkConnectionLost:
                return "Network connection lost."
            case .cancelled:
                return "Cancelled."
            default:
                return urlError.localizedDescription
            }
        }
        return error.localizedDescription
    }
}

struct InputImage: Encodable, Sendable {
    let base64: String
    let mimeType: String
}

/// Talks to one host's relay server. Every request carries the bearer token;
/// the base URL may be plain HTTP over Tailscale.
struct APIClient: Sendable {
    let host: Host
    let session: URLSession

    /// Short enough that an asleep or offline host shows as offline promptly.
    private static let listTimeout: TimeInterval = 10

    init(host: Host) {
        self.host = host

        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 600
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: configuration)
    }

    // MARK: - Endpoints

    func health() async throws -> HealthResponse {
        try await send(try request(path: "/api/health", timeout: Self.listTimeout))
    }

    func fetchSessions() async throws -> [Session] {
        let response: SessionsResponse = try await send(
            try request(path: "/api/sessions", timeout: Self.listTimeout)
        )
        return response.sessions
    }

    func createSession(cwd: String? = nil) async throws -> Session {
        struct Body: Encodable { let cwd: String? }
        struct Response: Decodable { let session: Session }
        let body = try JSONEncoder().encode(Body(cwd: cwd))
        let response: Response = try await send(
            try request(path: "/api/sessions", method: "POST", body: body)
        )
        return response.session
    }

    func deleteSession(id: String) async throws {
        let _: OkResponse = try await send(
            try request(path: "/api/sessions/\(Self.encoded(id))", method: "DELETE")
        )
    }

    func fetchMessages(sessionID: String, before: String? = nil, limit: Int = 60) async throws -> MessagesPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before {
            query.append(URLQueryItem(name: "before", value: before))
        }
        return try await send(
            try request(path: "/api/sessions/\(Self.encoded(sessionID))/messages", query: query)
        )
    }

    func sendInput(sessionID: String, text: String, images: [InputImage]) async throws {
        struct Body: Encodable {
            let text: String
            let images: [InputImage]?
        }
        let body = try JSONEncoder().encode(
            Body(text: text, images: images.isEmpty ? nil : images)
        )
        let _: OkResponse = try await send(
            try request(
                path: "/api/sessions/\(Self.encoded(sessionID))/input",
                method: "POST",
                body: body
            )
        )
    }

    func sendKeys(sessionID: String, keys: [String]) async throws {
        struct Body: Encodable { let keys: [String] }
        let body = try JSONEncoder().encode(Body(keys: keys))
        let _: OkResponse = try await send(
            try request(
                path: "/api/sessions/\(Self.encoded(sessionID))/keys",
                method: "POST",
                body: body
            )
        )
    }

    func fetchModels() async throws -> [ModelOption] {
        let response: ModelsResponse = try await send(try request(path: "/api/models"))
        return response.models
    }

    /// Switches the session's model and/or thinking level; pass nil to leave one unchanged.
    func setModel(sessionID: String, model: String?, thinkingLevel: String?) async throws {
        struct Body: Encodable {
            let model: String?
            let thinkingLevel: String?
        }
        let body = try JSONEncoder().encode(Body(model: model, thinkingLevel: thinkingLevel))
        let _: OkResponse = try await send(
            try request(
                path: "/api/sessions/\(Self.encoded(sessionID))/model",
                method: "POST",
                body: body
            )
        )
    }

    /// `serverPath` is the server-relative, already percent-encoded image path.
    func imageData(serverPath: String) async throws -> Data {
        let path = serverPath.hasPrefix("/") ? serverPath : "/" + serverPath
        let request = try request(path: path)
        let (data, response) = try await session.data(for: request)
        try Self.validate(data: data, response: response)
        return data
    }

    func eventRequest(sessionID: String) throws -> URLRequest {
        var request = try request(path: "/api/sessions/\(Self.encoded(sessionID))/events")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        return request
    }

    /// WebSocket request for a live voice call with this session's omp `/live` mode.
    func liveCallRequest(sessionID: String) throws -> URLRequest {
        var request = try request(path: "/api/sessions/\(Self.encoded(sessionID))/live")
        guard let url = request.url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw APIError(message: "Invalid server URL.", statusCode: nil)
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        request.url = components.url
        return request
    }

    // MARK: - Request plumbing

    private func request(
        path: String,
        method: String = "GET",
        query: [URLQueryItem] = [],
        body: Data? = nil,
        timeout: TimeInterval? = nil
    ) throws -> URLRequest {
        guard var components = URLComponents(url: host.baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError(message: "Invalid server URL.", statusCode: nil)
        }
        var basePath = components.percentEncodedPath
        if basePath.hasSuffix("/") {
            basePath.removeLast()
        }
        components.percentEncodedPath = basePath + path
        if !query.isEmpty {
            components.queryItems = query
        }
        guard let url = components.url else {
            throw APIError(message: "Invalid server URL.", statusCode: nil)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        if let timeout {
            request.timeoutInterval = timeout
        }
        request.setValue("Bearer \(host.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        try Task.checkCancellation()
        let (data, response) = try await session.data(for: request)
        try Self.validate(data: data, response: response)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(message: "Unexpected response from the server.", statusCode: Self.statusCode(of: response))
        }
    }

    static func validate(data: Data, response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw APIError(message: "No response from the server.", statusCode: nil)
        }
        guard (200..<300).contains(http.statusCode) else {
            let serverMessage = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw APIError(
                message: serverMessage ?? "Server error (\(http.statusCode)).",
                statusCode: http.statusCode
            )
        }
    }

    private static func statusCode(of response: URLResponse) -> Int? {
        (response as? HTTPURLResponse)?.statusCode
    }

    /// Percent-encodes a path component completely, so a pane id like "%72"
    /// becomes "%2572" as the server expects.
    private static func encoded(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? component
    }
}

private struct OkResponse: Decodable {
    let ok: Bool
}

private struct ErrorBody: Decodable {
    let error: String
}

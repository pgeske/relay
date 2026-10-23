import Foundation

enum SSEEvent: Sendable {
    case message(Message)
    case status(Session)
    case reset(sessionFile: String?)
    case closed
}

/// Minimal Server-Sent Events reader for GET /api/sessions/:id/events.
struct SSEClient: Sendable {
    let api: APIClient

    func events(sessionID: String) -> AsyncThrowingStream<SSEEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let request = try api.eventRequest(sessionID: sessionID)
                    let (bytes, response) = try await api.session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw APIError(message: "No response from the server.", statusCode: nil)
                    }
                    guard (200..<300).contains(http.statusCode) else {
                        throw APIError(
                            message: "Live updates unavailable (\(http.statusCode)).",
                            statusCode: http.statusCode
                        )
                    }

                    var eventName = "message"
                    var dataLines: [String] = []

                    // Not `bytes.lines`: it skips empty lines, and an empty line is what ends
                    // each SSE event, so events would never be dispatched.
                    for try await line in Self.lines(of: bytes) {
                        try Task.checkCancellation()

                        if line.isEmpty {
                            if let event = Self.decode(name: eventName, data: dataLines.joined(separator: "\n")) {
                                continuation.yield(event)
                                if case .closed = event {
                                    continuation.finish()
                                    return
                                }
                            }
                            eventName = "message"
                            dataLines.removeAll(keepingCapacity: true)
                            continue
                        }

                        if line.hasPrefix(":") {
                            continue
                        }

                        let field: String
                        var value: String
                        if let separator = line.firstIndex(of: ":") {
                            field = String(line[line.startIndex..<separator])
                            value = String(line[line.index(after: separator)...])
                            if value.hasPrefix(" ") {
                                value.removeFirst()
                            }
                        } else {
                            field = line
                            value = ""
                        }

                        switch field {
                        case "event":
                            eventName = value
                        case "data":
                            dataLines.append(value)
                        default:
                            break
                        }
                    }

                    continuation.finish()
                } catch {
                    if Task.isCancelled || error is CancellationError {
                        continuation.finish()
                    } else {
                        continuation.finish(throwing: error)
                    }
                }
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Splits a byte stream on "\n" (dropping a trailing "\r"), keeping empty lines.
    private static func lines(of bytes: URLSession.AsyncBytes) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var buffer: [UInt8] = []
                    for try await byte in bytes {
                        guard byte == UInt8(ascii: "\n") else {
                            buffer.append(byte)
                            continue
                        }
                        if buffer.last == UInt8(ascii: "\r") {
                            buffer.removeLast()
                        }
                        continuation.yield(String(decoding: buffer, as: UTF8.self))
                        buffer.removeAll(keepingCapacity: true)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func decode(name: String, data: String) -> SSEEvent? {
        if name == "closed" {
            return .closed
        }
        guard !data.isEmpty, let payload = data.data(using: .utf8) else {
            return nil
        }

        let decoder = JSONDecoder()
        switch name {
        case "message":
            return (try? decoder.decode(Message.self, from: payload)).map(SSEEvent.message)
        case "status":
            return (try? decoder.decode(Session.self, from: payload)).map(SSEEvent.status)
        case "reset":
            let reset = try? decoder.decode(ResetPayload.self, from: payload)
            return .reset(sessionFile: reset?.sessionFile)
        default:
            return nil
        }
    }

    private struct ResetPayload: Decodable {
        let sessionFile: String?
    }
}

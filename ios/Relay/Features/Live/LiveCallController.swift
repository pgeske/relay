import Foundation
import Observation

/// One live voice call: a WebSocket to the relay server, which drives omp's `/live` mode
/// on the computer. Binary frames carry audio both ways; text frames carry call events.
@MainActor
@Observable
final class LiveCallController {
    /// omp's live phase: connecting, listening, working, speaking, muted, or error.
    private(set) var phase = "connecting"
    private(set) var isMuted = false
    private(set) var isEnded = false
    private(set) var errorMessage: String?
    /// 0…1, smoothed: how loud the user and the agent are right now.
    private(set) var micLevel: Float = 0
    private(set) var agentLevel: Float = 0

    private let audio = LiveAudioEngine()
    /// The newest phase from the server; `phase` may lag it briefly (see `showPhase`).
    private var latestPhase = "connecting"
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?

    private struct Event: Decodable {
        let type: String
        let phase: String?
        let error: String?
    }

    func start(chat: ChatStore) async {
        guard await VoiceController.requestMicrophonePermission() else {
            finish(error: "Microphone access is off. Enable it in Settings.")
            return
        }
        let request: URLRequest
        do {
            request = try chat.liveCallRequest()
        } catch {
            finish(error: APIError.describe(error))
            return
        }

        let socket = URLSession.shared.webSocketTask(with: request)
        self.socket = socket
        socket.resume()

        do {
            try audio.start { [weak self] data, level in
                socket.send(.data(data)) { _ in }
                Task { @MainActor in self?.micLevel = Self.smoothed(self?.micLevel ?? 0, level) }
            }
        } catch {
            finish(error: "Couldn't start the microphone: \(error.localizedDescription)")
            return
        }

        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await socket.receive()
                    self?.handle(message)
                } catch {
                    self?.finish(error: "Lost the connection to the computer.")
                    return
                }
            }
        }
    }

    func toggleMute() {
        isMuted.toggle()
        audio.setMuted(isMuted)
        if isMuted { micLevel = 0 }
    }

    func hangUp() {
        finish(error: nil)
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .data(let data):
            agentLevel = Self.smoothed(agentLevel, audio.play(data))
        case .string(let text):
            guard let event = try? JSONDecoder().decode(Event.self, from: Data(text.utf8)) else { return }
            if event.type == "phase", let phase = event.phase {
                showPhase(phase)
            } else if event.type == "ended" {
                finish(error: event.error)
            }
        @unknown default:
            break
        }
    }

    /// omp flips to "listening" between every sentence it speaks; wait a moment before
    /// showing that, so the label doesn't flicker while the agent is still talking.
    private func showPhase(_ next: String) {
        latestPhase = next
        guard next == "listening", phase == "speaking" else {
            phase = next
            return
        }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.2))
            guard let self, self.latestPhase == "listening" else { return }
            self.phase = "listening"
        }
    }

    /// Stops audio and closes the socket; the server then ends live mode on the computer.
    private func finish(error: String?) {
        guard !isEnded else { return }
        isEnded = true
        errorMessage = error
        receiveTask?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil)
        audio.stop()
        micLevel = 0
        agentLevel = 0
    }

    /// Rises immediately, falls gently, so the animation doesn't flicker.
    private static func smoothed(_ current: Float, _ next: Float) -> Float {
        next > current ? next : current * 0.8 + next * 0.2
    }
}

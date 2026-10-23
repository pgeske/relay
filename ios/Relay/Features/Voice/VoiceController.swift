import AVFoundation
import Observation

/// Tap-to-record dictation backed by FluidAudio's Parakeet models.
@MainActor
@Observable
final class VoiceController {
    enum State: Equatable {
        case idle
        case preparing
        case recording
        case transcribing
    }

    private(set) var state: State = .idle
    private(set) var level: Float = 0
    var errorMessage: String?

    private let recorder = AudioRecorder()
    private let engine = SpeechEngine.shared

    var statusText: String? {
        switch state {
        case .preparing: "Preparing voice model…"
        case .transcribing: "Transcribing…"
        case .idle, .recording: nil
        }
    }

    /// Starts recording. Returns an error message when it can't start.
    func start() async -> String? {
        guard state == .idle else { return nil }

        guard await Self.requestMicrophonePermission() else {
            return "Microphone access is off. Enable it in Settings."
        }

        state = .preparing
        do {
            // Load (and on first use, download) the model before recording so
            // the first dictation isn't also waiting on a download.
            try await engine.load()
            try recorder.start { [weak self] level in
                Task { @MainActor in
                    self?.level = level
                }
            }
            level = 0
            state = .recording
            return nil
        } catch {
            _ = recorder.stop()
            level = 0
            state = .idle
            return "Voice model unavailable: \(error.localizedDescription)"
        }
    }

    /// Stops recording and returns the transcript. Errors land in `errorMessage`.
    func stopAndTranscribe() async -> String? {
        guard state == .recording else { return nil }

        let samples = recorder.stop()
        level = 0
        state = .transcribing
        defer { state = .idle }

        guard samples.count >= 4_000 else {
            errorMessage = "That recording was too short."
            return nil
        }

        do {
            let transcript = try await engine.transcribe(samples)
            AppConfig.voiceModelUnlocked = true
            return transcript
        } catch {
            errorMessage = "Transcription failed: \(error.localizedDescription)"
            return nil
        }
    }

    private static func requestMicrophonePermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        @unknown default:
            return false
        }
    }
}

/// Loads the Parakeet model once, off the main actor, after the first use.
enum VoiceModelWarmer {
    @MainActor
    static func warmUpIfPreviouslyUsed() {
        guard AppConfig.voiceModelUnlocked else { return }
        Task.detached(priority: .utility) {
            try? await SpeechEngine.shared.load()
        }
    }
}

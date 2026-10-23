import FluidAudio
import Foundation

enum VoiceEngineError: LocalizedError {
    case notLoaded

    var errorDescription: String? {
        "The speech model didn't load."
    }
}

/// Serializes model loading and transcription. Core ML work runs on this
/// actor's executor, never the main actor.
actor SpeechEngine {
    static let shared = SpeechEngine()

    private var manager: AsrManager?
    private var loadTask: Task<Void, Error>?

    /// Downloads (first run) and loads Parakeet TDT v3. Safe to call repeatedly.
    func load() async throws {
        if manager != nil { return }

        if let loadTask {
            try await loadTask.value
            return
        }

        let task = Task { [self] in
            let models = try await AsrModels.downloadAndLoad(version: .v3)
            self.manager = AsrManager(config: .default, models: models)
        }
        loadTask = task

        do {
            try await task.value
            loadTask = nil
        } catch {
            loadTask = nil
            throw error
        }
    }

    /// Expects 16 kHz mono Float32 samples, which is what AudioRecorder produces.
    func transcribe(_ samples: [Float]) async throws -> String {
        try await load()
        guard let manager else { throw VoiceEngineError.notLoaded }

        // Parakeet needs at least one second of audio.
        var audio = samples
        if audio.count < 16_000 {
            audio.append(contentsOf: repeatElement(Float(0), count: 16_000 - audio.count))
        }

        var decoderState = TdtDecoderState.make()
        let result = try await manager.transcribe(audio, decoderState: &decoderState)
        return result.text
    }
}

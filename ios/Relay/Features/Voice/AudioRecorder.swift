import AVFoundation

enum RecorderError: LocalizedError {
    case audioSetupFailed

    var errorDescription: String? {
        "Couldn't set up the microphone."
    }
}

/// Records from the microphone and converts to 16 kHz mono Float32.
/// The audio tap runs on a realtime thread; shared state is lock-protected.
final class AudioRecorder: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
    )!

    private var converter: AVAudioConverter?
    private var collected: [Float] = []
    private var isRecording = false

    func start(onLevel: @escaping @Sendable (Float) -> Void) throws {
        guard !isRecording else { return }

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement)
        try audioSession.setActive(true)

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0,
              let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            try? audioSession.setActive(false)
            throw RecorderError.audioSetupFailed
        }

        lock.lock()
        collected.removeAll(keepingCapacity: true)
        self.converter = converter
        lock.unlock()

        input.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            self.append(buffer)
            onLevel(Self.level(of: buffer))
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            try? audioSession.setActive(false)
            throw error
        }

        isRecording = true
    }

    func stop() -> [Float] {
        guard isRecording else { return [] }
        isRecording = false

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        lock.lock()
        let samples = collected
        collected.removeAll()
        converter = nil
        lock.unlock()

        return samples
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let converter = self.converter
        lock.unlock()
        guard let converter else { return }

        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
            return
        }

        var suppliedInput = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, outStatus in
            if suppliedInput {
                outStatus.pointee = .noDataNow
                return nil
            }
            suppliedInput = true
            outStatus.pointee = .haveData
            return buffer
        }

        guard conversionError == nil,
              status != .error,
              output.frameLength > 0,
              let channel = output.floatChannelData?[0] else {
            return
        }

        let frames = Int(output.frameLength)
        let chunk = Array(UnsafeBufferPointer(start: channel, count: frames))

        lock.lock()
        collected.append(contentsOf: chunk)
        lock.unlock()
    }

    /// RMS level mapped from roughly -50 dBFS…0 dBFS onto 0…1.
    private static func level(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else {
            return 0
        }

        let frames = Int(buffer.frameLength)
        var sum: Float = 0
        for index in 0..<frames {
            let sample = channel[index]
            sum += sample * sample
        }

        let rms = sqrt(sum / Float(frames))
        let decibels = 20 * log10(max(rms, 0.000_001))
        return min(1, max(0, (decibels + 50) / 50))
    }
}

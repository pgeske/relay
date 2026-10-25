import AVFoundation

/// The phone's end of a live call: sends the mic out and plays the agent's voice back,
/// both as 24 kHz 16-bit mono PCM (the relay server's wire format).
/// Voice processing turns on Apple's echo cancellation, so the agent doesn't hear its
/// own voice coming out of the phone speaker. Audio callbacks run on realtime threads;
/// shared state is lock-protected.
final class LiveAudioEngine: @unchecked Sendable {
    static let sampleRate: Double = 24_000

    /// Agent audio queued beyond this is dropped, so a network hiccup can't leave the
    /// voice permanently lagging behind.
    private static let maxQueuedSeconds: Double = 0.5

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: sampleRate,
        channels: 1,
        interleaved: true
    )!
    private let playbackFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: sampleRate,
        channels: 1,
        interleaved: false
    )!

    private let lock = NSLock()
    private var isMuted = false
    private var queuedFrames: AVAudioFrameCount = 0
    private var configurationObserver: NSObjectProtocol?

    /// `onMicAudio` receives wire-format PCM plus a 0…1 level for each mic buffer.
    func start(onMicAudio: @escaping @Sendable (Data, Float) -> Void) throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try audioSession.setActive(true)

        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0,
              let converter = AVAudioConverter(from: inputFormat, to: wireFormat) else {
            throw RecorderError.audioSetupFailed
        }

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)

        input.installTap(onBus: 0, bufferSize: 2_048, format: inputFormat) { [weak self] buffer, _ in
            guard let self, !self.muted, let data = self.convert(buffer, with: converter) else { return }
            onMicAudio(data, AudioRecorder.level(of: buffer))
        }

        // Turning on voice processing reconfigures the audio route right after the engine
        // starts, which stops it: the mic tap then never fires. Start it again.
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            guard let self, !self.engine.isRunning else { return }
            try? self.engine.start()
            self.player.play()
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            try? audioSession.setActive(false)
            throw error
        }
        player.play()
    }

    func setMuted(_ muted: Bool) {
        lock.lock()
        isMuted = muted
        lock.unlock()
    }

    /// Queues one chunk of the agent's voice and returns its 0…1 level.
    func play(_ data: Data) -> Float {
        let frames = AVAudioFrameCount(data.count / 2)
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: frames),
              let channel = buffer.floatChannelData?[0] else {
            return 0
        }

        lock.lock()
        let isBacklogged = Double(queuedFrames) > Self.maxQueuedSeconds * Self.sampleRate
        if !isBacklogged { queuedFrames += frames }
        lock.unlock()
        if isBacklogged { return 0 }

        buffer.frameLength = frames
        data.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<Int(frames) {
                channel[index] = Float(Int16(littleEndian: samples[index])) / 32_768
            }
        }
        player.scheduleBuffer(buffer) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.queuedFrames -= frames
            self.lock.unlock()
        }
        return AudioRecorder.level(of: buffer)
    }

    func stop() {
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private var muted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return isMuted
    }

    private func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter) -> Data? {
        let ratio = wireFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else {
            return nil
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
              let samples = output.int16ChannelData?[0] else {
            return nil
        }
        return Data(bytes: samples, count: Int(output.frameLength) * 2)
    }
}

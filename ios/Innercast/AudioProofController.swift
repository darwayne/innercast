import AVFoundation
import Foundation

@MainActor
final class AudioProofController: ObservableObject {
    enum ProofState: Equatable {
        case idle
        case previewing
        case recording
        case recorded
        case playingRecording
        case failed(String)

        var label: String {
            switch self {
            case .idle: return "Ready"
            case .previewing: return "Playing source preview"
            case .recording: return "Playing source + recording microphone"
            case .recorded: return "Recording ready to replay"
            case .playingRecording: return "Playing microphone recording"
            case .failed(let message): return "Error: \(message)"
            }
        }
    }

    @Published private(set) var selectedFilename: String?
    @Published private(set) var sourceDuration: TimeInterval = 0
    @Published private(set) var sourceChannelCount: AVAudioChannelCount = 0
    @Published private(set) var state: ProofState = .idle
    @Published private(set) var diagnostics = "Audio session has not been activated."
    @Published private(set) var recordingURL: URL?
    @Published var selectedMode: AudioSessionMode = .standard

    private let session = AVAudioSession.sharedInstance()
    private let engine = AVAudioEngine()
    private let sourceNode = AVAudioPlayerNode()
    private var sourceURL: URL?
    private var sourceFile: AVAudioFile?
    private var recordingFile: AVAudioFile?
    private var previewPlayer: AVAudioPlayer?
    private var recordingPlayer: AVAudioPlayer?
    private var inputTapInstalled = false
    private var notificationTokens: [NSObjectProtocol] = []

    init() {
        engine.attach(sourceNode)
        observeAudioSession()
        refreshDiagnostics()
    }

    deinit {
        notificationTokens.forEach(NotificationCenter.default.removeObserver)
    }

    var canStartProof: Bool {
        sourceURL != nil && state != .recording
    }

    var canReplayRecording: Bool {
        recordingURL != nil && state != .recording
    }

    func importAudio(from pickedURL: URL) {
        stopAllPlayback()

        let gainedAccess = pickedURL.startAccessingSecurityScopedResource()
        defer {
            if gainedAccess {
                pickedURL.stopAccessingSecurityScopedResource()
            }
        }

        do {
            let importedURL = try copyIntoApplicationStorage(pickedURL)
            let file = try AVAudioFile(forReading: importedURL)
            sourceURL = importedURL
            sourceFile = file
            selectedFilename = pickedURL.lastPathComponent
            sourceChannelCount = file.processingFormat.channelCount
            sourceDuration = file.fileFormat.sampleRate > 0
                ? Double(file.length) / file.fileFormat.sampleRate
                : 0
            state = .idle
            refreshDiagnostics(note: "Imported \(pickedURL.lastPathComponent).")
        } catch {
            fail("Could not open that audio file: \(error.localizedDescription)")
        }
    }

    func previewSource() {
        guard let sourceURL else { return }
        stopProofIfNeeded()
        stopAllPlayback()

        do {
            try configurePlaybackSession()
            let player = try AVAudioPlayer(contentsOf: sourceURL)
            player.prepareToPlay()
            guard player.play() else {
                throw AudioProofError.playbackDidNotStart
            }
            previewPlayer = player
            state = .previewing
            refreshDiagnostics(note: "Source preview uses the playback-only session.")
        } catch {
            fail("Could not preview the source: \(error.localizedDescription)")
        }
    }

    func startProof() async {
        guard let sourceURL else { return }

        let granted = await AVAudioApplication.requestRecordPermission()
        guard granted else {
            fail("Microphone permission was denied. Enable it in Settings and try again.")
            return
        }

        do {
            stopProofIfNeeded()
            stopAllPlayback()
            try configurePlayAndRecordSession()

            let file = try AVAudioFile(forReading: sourceURL)
            sourceFile = file
            sourceNode.stop()
            engine.stop()
            engine.reset()
            engine.disconnectNodeOutput(sourceNode)
            engine.connect(sourceNode, to: engine.mainMixerNode, format: file.processingFormat)

            let inputNode = engine.inputNode
            let inputFormat = inputNode.outputFormat(forBus: 0)
            guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
                throw AudioProofError.invalidInputFormat
            }

            removeInputTapIfNeeded()
            let destination = try freshRecordingURL()
            let recordingFile = try AVAudioFile(forWriting: destination, settings: inputFormat.settings)
            self.recordingFile = recordingFile
            self.recordingURL = destination

            inputNode.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { [weak self] buffer, _ in
                do {
                    try recordingFile.write(from: buffer)
                } catch {
                    Task { @MainActor [weak self] in
                        self?.fail("Microphone write failed: \(error.localizedDescription)")
                    }
                }
            }
            inputTapInstalled = true

            sourceNode.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard self?.state == .recording else { return }
                    self?.stopProof(reason: "Source playback reached the end.")
                }
            }

            engine.prepare()
            try engine.start()
            sourceNode.play()
            state = .recording
            refreshDiagnostics(note: "Built-in microphone requested; source and microphone share one AVAudioEngine.")
        } catch {
            stopProofIfNeeded()
            fail("Could not start the audio proof: \(error.localizedDescription)")
        }
    }

    func stopProof(reason: String = "Stopped manually.") {
        guard state == .recording else { return }
        sourceNode.stop()
        removeInputTapIfNeeded()
        engine.stop()
        recordingFile = nil
        state = .recorded
        refreshDiagnostics(note: reason)
    }

    func replayRecording() {
        guard let recordingURL else { return }
        stopProofIfNeeded()
        stopAllPlayback()

        do {
            try configurePlaybackSession()
            let player = try AVAudioPlayer(contentsOf: recordingURL)
            player.prepareToPlay()
            guard player.play() else {
                throw AudioProofError.playbackDidNotStart
            }
            recordingPlayer = player
            state = .playingRecording
            refreshDiagnostics(note: "Replaying the microphone capture.")
        } catch {
            fail("Could not replay the recording: \(error.localizedDescription)")
        }
    }

    func stopPlayback() {
        stopAllPlayback()
        if recordingURL != nil {
            state = .recorded
        } else {
            state = .idle
        }
        refreshDiagnostics(note: "Playback stopped.")
    }

    func refreshDiagnostics(note: String? = nil) {
        let route = session.currentRoute
        let inputs = route.inputs.map { "\($0.portName) [\($0.portType.rawValue)] \($0.channels?.count ?? 0)ch" }
        let outputs = route.outputs.map { "\($0.portName) [\($0.portType.rawValue)] \($0.channels?.count ?? 0)ch" }
        let availableInputs = session.availableInputs?.map { "\($0.portName) [\($0.portType.rawValue)]" } ?? []
        let engineInput = engine.inputNode.outputFormat(forBus: 0)
        let engineMixer = engine.mainMixerNode.outputFormat(forBus: 0)
        let engineOutput = engine.outputNode.inputFormat(forBus: 0)

        diagnostics = [
            note,
            "Category: \(session.category.rawValue)",
            "Mode: \(session.mode.rawValue)",
            "Bluetooth policy: A2DP allowed, HFP prohibited",
            "Input route: \(inputs.isEmpty ? "None" : inputs.joined(separator: ", "))",
            "Output route: \(outputs.isEmpty ? "None" : outputs.joined(separator: ", "))",
            "Available inputs: \(availableInputs.isEmpty ? "None reported" : availableInputs.joined(separator: ", "))",
            String(format: "Session sample rate: %.0f Hz", session.sampleRate),
            String(format: "I/O buffer: %.2f ms", session.ioBufferDuration * 1_000),
            "Source format: \(sourceChannelCount)ch",
            formatDescription("Engine input", engineInput),
            formatDescription("Engine mixer", engineMixer),
            formatDescription("Engine output", engineOutput)
        ]
        .compactMap { $0 }
        .joined(separator: "\n")
    }

    private func configurePlayAndRecordSession() throws {
        try session.setActive(false, options: .notifyOthersOnDeactivation)
        try session.setCategory(
            .playAndRecord,
            mode: selectedMode.avMode,
            options: [.allowBluetoothA2DP]
        )
        try session.setActive(true)

        if let builtInMicrophone = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
            try session.setPreferredInput(builtInMicrophone)
        } else {
            throw AudioProofError.builtInMicrophoneUnavailable
        }
    }

    private func formatDescription(_ label: String, _ format: AVAudioFormat) -> String {
        String(
            format: "%@: %uch @ %.0f Hz",
            label,
            format.channelCount,
            format.sampleRate
        )
    }

    private func configurePlaybackSession() throws {
        try session.setActive(false, options: .notifyOthersOnDeactivation)
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
    }

    private func copyIntoApplicationStorage(_ source: URL) throws -> URL {
        let fileManager = FileManager.default
        let folder = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appendingPathComponent("ImportedAudio", isDirectory: true)
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)

        let destination = folder.appendingPathComponent("source").appendingPathExtension(source.pathExtension)
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.copyItem(at: source, to: destination)
        return destination
    }

    private func freshRecordingURL() throws -> URL {
        let fileManager = FileManager.default
        let folder = try fileManager.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appendingPathComponent("AudioProofs", isDirectory: true)
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent("microphone-\(UUID().uuidString).caf")
    }

    private func stopProofIfNeeded() {
        if state == .recording {
            stopProof(reason: "Stopped before another audio action.")
        }
    }

    private func stopAllPlayback() {
        previewPlayer?.stop()
        recordingPlayer?.stop()
        previewPlayer = nil
        recordingPlayer = nil
    }

    private func removeInputTapIfNeeded() {
        guard inputTapInstalled else { return }
        engine.inputNode.removeTap(onBus: 0)
        inputTapInstalled = false
    }

    private func fail(_ message: String) {
        if state == .recording {
            sourceNode.stop()
            removeInputTapIfNeeded()
            engine.stop()
            recordingFile = nil
        }
        state = .failed(message)
        refreshDiagnostics(note: message)
    }

    private func observeAudioSession() {
        let center = NotificationCenter.default
        notificationTokens.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: session,
            queue: .main
        ) { [weak self] notification in
            let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            let reason = rawReason.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            Task { @MainActor [weak self] in
                self?.refreshDiagnostics(note: "Audio route changed (\(reason.map(String.init(describing:)) ?? "unknown")).")
            }
        })

        notificationTokens.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] notification in
            let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let type = rawType.flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            Task { @MainActor [weak self] in
                if type == .began, self?.state == .recording {
                    self?.stopProof(reason: "The audio session was interrupted.")
                } else {
                    self?.refreshDiagnostics(note: "Audio interruption changed: \(type.map(String.init(describing:)) ?? "unknown").")
                }
            }
        })
    }
}

private enum AudioProofError: LocalizedError {
    case playbackDidNotStart
    case invalidInputFormat
    case builtInMicrophoneUnavailable

    var errorDescription: String? {
        switch self {
        case .playbackDidNotStart:
            return "The audio player did not start."
        case .invalidInputFormat:
            return "The microphone reported an invalid audio format."
        case .builtInMicrophoneUnavailable:
            return "The built-in iPhone microphone is not available on the current route."
        }
    }
}

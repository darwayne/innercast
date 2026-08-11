import AVFoundation
import Foundation
import UIKit
import UniformTypeIdentifiers

@MainActor
final class NativeAudioPipeline {
    var eventHandler: (([String: Any]) -> Void)?
    nonisolated(unsafe) private(set) var selectedSourceURL: URL?

    private let repository: NativeSessionRepository
    private let session = AVAudioSession.sharedInstance()
    private let engine = AVAudioEngine()
    private let sourceNode = AVAudioPlayerNode()
    private let stateLock = NSLock()
    private var sourceFile: AVAudioFile?
    private var sourceMetadata: NativeSourceMetadata?
    private var recordingFile: AVAudioFile?
    private var recordingID: String?
    private var synchronization: NativeSynchronizationMetadata?
    private var recordingStarted = false
    private var sessionPaused = false
    private var micFramesWritten: AVAudioFramePosition = 0
    private var micSampleRate: Double = 48_000
    private var sourceStartFrame: AVAudioFramePosition = 0
    private var targetSourceSeconds: Double = 0
    private var actualOffsetSeconds: Double = 0
    private var progressTimer: Timer?
    private var inputTapInstalled = false
    private var notificationTokens: [NSObjectProtocol] = []

    init(repository: NativeSessionRepository) {
        self.repository = repository
        engine.attach(sourceNode)
        restoreSource()
        observeInterruptions()
    }

    deinit { notificationTokens.forEach(NotificationCenter.default.removeObserver) }

    func importSource(_ pickedURL: URL) throws -> [String: Any] {
        let gainedAccess = pickedURL.startAccessingSecurityScopedResource()
        defer { if gainedAccess { pickedURL.stopAccessingSecurityScopedResource() } }

        let folder = try sourceFolder()
        let destination = folder.appendingPathComponent("source").appendingPathExtension(pickedURL.pathExtension)
        for existing in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] {
            try? FileManager.default.removeItem(at: existing)
        }
        try FileManager.default.copyItem(at: pickedURL, to: destination)
        var excluded = destination
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)

        let file = try AVAudioFile(forReading: destination)
        let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
        let duration = file.fileFormat.sampleRate > 0 ? Double(file.length) / file.fileFormat.sampleRate : 0
        let metadata = NativeSourceMetadata(
            filename: pickedURL.lastPathComponent,
            mimeType: UTType(filenameExtension: pickedURL.pathExtension)?.preferredMIMEType ?? "application/octet-stream",
            sizeBytes: (attributes[.size] as? NSNumber)?.int64Value ?? 0,
            durationSeconds: duration
        )
        selectedSourceURL = destination
        sourceFile = file
        sourceMetadata = metadata
        try JSONEncoder().encode(metadata).write(to: folder.appendingPathComponent("source.json"), options: .atomic)
        return sourceDictionary(metadata)
    }

    func restoredSourceDictionary() -> [String: Any]? {
        guard let sourceMetadata, selectedSourceURL != nil else { return nil }
        return sourceDictionary(sourceMetadata)
    }

    func start(configuration: [String: Any]) async throws {
        guard let sourceURL = selectedSourceURL, let source = sourceMetadata else {
            throw NativeAudioError.noSource
        }
        let permission = await AVAudioApplication.requestRecordPermission()
        guard permission else { throw NativeAudioError.permissionDenied }

        let mode = configuration["mode"] as? String ?? "immediate"
        let configured = configuration["configuredValueSeconds"] as? Double ?? 0
        let startPosition = configuration["sourceStartPositionSeconds"] as? Double ?? 0
        let target = mode == "immediate" ? startPosition : mode == "delay" ? startPosition + configured : configured
        guard startPosition >= 0, startPosition < source.durationSeconds, target >= startPosition, target < source.durationSeconds else {
            throw NativeAudioError.invalidOffset
        }

        cleanupEngine()
        try configureAudioSession()
        let file = try AVAudioFile(forReading: sourceURL)
        sourceFile = file
        sourceStartFrame = AVAudioFramePosition(startPosition * file.fileFormat.sampleRate)
        targetSourceSeconds = target
        actualOffsetSeconds = target
        recordingStarted = false
        sessionPaused = false
        micFramesWritten = 0
        synchronization = NativeSynchronizationMetadata(
            recordingSourceOffsetSeconds: target,
            mode: mode,
            configuredValueSeconds: configured
        )

        engine.disconnectNodeOutput(sourceNode)
        engine.connect(sourceNode, to: engine.mainMixerNode, format: file.processingFormat)
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { throw NativeAudioError.invalidInput }
        micSampleRate = inputFormat.sampleRate

        let id = UUID().uuidString
        recordingID = id
        let audioURL = repository.recordingURL(for: id)
        try FileManager.default.createDirectory(at: audioURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: inputFormat.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 128_000
        ]
        let outputFile = try AVAudioFile(forWriting: audioURL, settings: settings)
        recordingFile = outputFile

        input.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { [weak self] buffer, time in
            guard let self else { return }
            self.capture(buffer: buffer, at: time, into: outputFile)
        }
        inputTapInstalled = true

        let remaining = max(0, file.length - sourceStartFrame)
        sourceNode.scheduleSegment(
            file,
            startingFrame: sourceStartFrame,
            frameCount: AVAudioFrameCount(min(Int64(UInt32.max), remaining)),
            at: nil,
            completionCallbackType: .dataPlayedBack
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard self?.recordingID != nil else { return }
                _ = try? self?.stop(reason: "ended")
            }
        }
        engine.prepare()
        try engine.start()
        sourceNode.play()
        UIApplication.shared.isIdleTimerDisabled = true
        startProgressUpdates()
        emitState("playing", note: "Native stereo playback with built-in microphone")
    }

    func pause() throws {
        guard recordingID != nil, !sessionPaused else { return }
        stateLock.lock(); sessionPaused = true; stateLock.unlock()
        sourceNode.pause()
        emitState("paused")
    }

    func resume() throws {
        guard recordingID != nil, sessionPaused else { return }
        stateLock.lock(); sessionPaused = false; stateLock.unlock()
        sourceNode.play()
        emitState("playing")
    }

    @discardableResult
    func stop(reason: String) throws -> NativeSession? {
        guard let id = recordingID else { return nil }
        progressTimer?.invalidate(); progressTimer = nil
        sourceNode.stop()
        removeInputTap()
        engine.stop()
        recordingFile = nil
        UIApplication.shared.isIdleTimerDisabled = false

        let started = recordingStarted
        let duration = micSampleRate > 0 ? Double(micFramesWritten) / micSampleRate : 0
        recordingID = nil
        sessionPaused = false
        guard started, duration > 0, let sourceMetadata, var synchronization else {
            try? FileManager.default.removeItem(at: repository.recordingURL(for: id).deletingLastPathComponent())
            eventHandler?(["type": "sessionStopped", "payload": ["reason": reason, "saved": false]])
            return nil
        }
        synchronization = NativeSynchronizationMetadata(
            recordingSourceOffsetSeconds: actualOffsetSeconds,
            mode: synchronization.mode,
            configuredValueSeconds: synchronization.configuredValueSeconds
        )
        let saved = try repository.save(id: id, source: sourceMetadata, synchronization: synchronization, durationSeconds: duration)
        eventHandler?(["type": "sessionCompleted", "payload": ["reason": reason, "session": saved.dictionary()]])
        return saved
    }

    func diagnostics() -> [String: Any] {
        let route = session.currentRoute
        return [
            "category": session.category.rawValue,
            "mode": session.mode.rawValue,
            "input": route.inputs.map(\.portName).joined(separator: ", "),
            "output": route.outputs.map(\.portName).joined(separator: ", "),
            "sampleRate": session.sampleRate,
            "outputChannels": engine.outputNode.inputFormat(forBus: 0).channelCount,
            "bluetoothPolicy": "A2DP only; HFP prohibited"
        ]
    }

    private func capture(buffer: AVAudioPCMBuffer, at time: AVAudioTime, into file: AVAudioFile) {
        stateLock.lock()
        let paused = sessionPaused
        stateLock.unlock()
        guard !paused else { return }

        let sourceTime = currentSourceTime(atHostTime: time.hostTime)
        guard sourceTime >= targetSourceSeconds else { return }
        if !recordingStarted {
            recordingStarted = true
            actualOffsetSeconds = sourceTime
            Task { @MainActor [weak self] in self?.emitState("recording") }
        }
        do {
            try file.write(from: buffer)
            micFramesWritten += AVAudioFramePosition(buffer.frameLength)
        } catch {
            Task { @MainActor [weak self] in
                self?.eventHandler?(["type": "error", "payload": ["message": "Microphone write failed: \(error.localizedDescription)"]])
                _ = try? self?.stop(reason: "error")
            }
        }
    }

    private func currentSourceTime(atHostTime hostTime: UInt64? = nil) -> Double {
        let nodeTime: AVAudioTime?
        if let hostTime, hostTime > 0 { nodeTime = AVAudioTime(hostTime: hostTime) }
        else { nodeTime = sourceNode.lastRenderTime }
        guard let nodeTime, let playerTime = sourceNode.playerTime(forNodeTime: nodeTime), let file = sourceFile else {
            return Double(sourceStartFrame) / (sourceFile?.fileFormat.sampleRate ?? 1)
        }
        return Double(sourceStartFrame) / file.fileFormat.sampleRate + Double(playerTime.sampleTime) / playerTime.sampleRate
    }

    private func configureAudioSession() throws {
        try session.setActive(false, options: .notifyOthersOnDeactivation)
        try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothA2DP])
        try session.setActive(true)
        guard let microphone = session.availableInputs?.first(where: { $0.portType == .builtInMic }) else {
            throw NativeAudioError.builtInMicrophoneUnavailable
        }
        try session.setPreferredInput(microphone)
        guard session.currentRoute.inputs.contains(where: { $0.portType == .builtInMic }) else {
            throw NativeAudioError.builtInMicrophoneUnavailable
        }
    }

    private func startProgressUpdates() {
        progressTimer?.invalidate()
        progressTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.recordingID != nil else { return }
                self.eventHandler?([
                    "type": "progress",
                    "payload": [
                        "sourceTime": self.currentSourceTime(),
                        "recordingElapsed": self.micSampleRate > 0 ? Double(self.micFramesWritten) / self.micSampleRate : 0,
                        "recordingStarted": self.recordingStarted,
                        "recordingSourceOffsetSeconds": self.actualOffsetSeconds,
                        "paused": self.sessionPaused
                    ]
                ])
            }
        }
    }

    private func emitState(_ state: String, note: String? = nil) {
        var payload: [String: Any] = ["state": state, "diagnostics": diagnostics()]
        if let note { payload["note"] = note }
        eventHandler?(["type": "state", "payload": payload])
    }

    private func cleanupEngine() {
        progressTimer?.invalidate(); progressTimer = nil
        sourceNode.stop()
        removeInputTap()
        engine.stop()
        recordingFile = nil
        recordingID = nil
    }

    private func removeInputTap() {
        guard inputTapInstalled else { return }
        engine.inputNode.removeTap(onBus: 0)
        inputTapInstalled = false
    }

    private func sourceFolder() throws -> URL {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let folder = support.appendingPathComponent("Innercast/Source", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    private func restoreSource() {
        guard let folder = try? sourceFolder(),
              let metadataData = try? Data(contentsOf: folder.appendingPathComponent("source.json")),
              let metadata = try? JSONDecoder().decode(NativeSourceMetadata.self, from: metadataData),
              let fileURL = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []).first(where: { $0.lastPathComponent.hasPrefix("source.") }),
              let file = try? AVAudioFile(forReading: fileURL) else { return }
        selectedSourceURL = fileURL
        sourceMetadata = metadata
        sourceFile = file
    }

    private func sourceDictionary(_ source: NativeSourceMetadata) -> [String: Any] {
        [
            "filename": source.filename,
            "mimeType": source.mimeType,
            "sizeBytes": source.sizeBytes,
            "durationSeconds": source.durationSeconds,
            "playbackUrl": "/native/source"
        ]
    }

    private func observeInterruptions() {
        notificationTokens.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] notification in
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            if raw == AVAudioSession.InterruptionType.began.rawValue {
                Task { @MainActor [weak self] in _ = try? self?.stop(reason: "interrupted") }
            }
        })
        notificationTokens.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in _ = try? self?.stop(reason: "backgrounded") }
        })
    }
}

private enum NativeAudioError: LocalizedError {
    case noSource, permissionDenied, invalidOffset, invalidInput, builtInMicrophoneUnavailable

    var errorDescription: String? {
        switch self {
        case .noSource: return "Choose an audio source first."
        case .permissionDenied: return "Microphone permission was denied. Enable it in Settings and try again."
        case .invalidOffset: return "The recording offset must fall within the selected source."
        case .invalidInput: return "The built-in microphone reported an invalid audio format."
        case .builtInMicrophoneUnavailable: return "The built-in iPhone microphone is unavailable on the current route."
        }
    }
}

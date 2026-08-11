import AVFoundation
import CoreMedia
import Foundation
import Speech

@MainActor
final class NativeTranscriptionService {
    var eventHandler: (([String: Any]) -> Void)?

    private let repository: NativeSessionRepository
    private var activeTask: Task<Void, Never>?
    private var activeSessionID: String?

    init(repository: NativeSessionRepository) {
        self.repository = repository
    }

    var isAvailable: Bool {
        if #available(iOS 26.0, *) { return SpeechTranscriber.isAvailable }
        return false
    }

    func start(sessionID: String) throws {
        guard activeTask == nil else { throw NativeTranscriptionError.alreadyRunning }
        guard let session = repository.session(id: sessionID), repository.audioURL(for: sessionID) != nil else {
            throw NativeTranscriptionError.recordingNotFound
        }
        guard isAvailable else { throw NativeTranscriptionError.unavailable }

        activeSessionID = sessionID
        activeTask = Task { [weak self] in
            guard let self else { return }
            do {
                let transcription: NativeTranscriptionMetadata
                if #available(iOS 26.0, *) {
                    transcription = try await self.transcribe(session: session)
                } else {
                    throw NativeTranscriptionError.unavailable
                }
                try Task.checkCancellation()
                try self.repository.updateTranscription(id: sessionID, transcription: transcription)
                self.eventHandler?([
                    "type": "transcriptionCompleted",
                    "payload": ["sessionId": sessionID, "transcription": transcription.dictionary()]
                ])
            } catch {
                let cancelled = Task.isCancelled || error is CancellationError
                self.eventHandler?([
                    "type": cancelled ? "transcriptionCancelled" : "transcriptionFailed",
                    "payload": [
                        "sessionId": sessionID,
                        "message": cancelled ? "Transcription cancelled." : error.localizedDescription
                    ]
                ])
            }
            self.activeTask = nil
            self.activeSessionID = nil
        }
    }

    func cancel(sessionID: String?) {
        guard sessionID == nil || sessionID == activeSessionID else { return }
        activeTask?.cancel()
    }

    @available(iOS 26.0, *)
    private func transcribe(session: NativeSession) async throws -> NativeTranscriptionMetadata {
        guard let audioURL = repository.audioURL(for: session.id) else {
            throw NativeTranscriptionError.recordingNotFound
        }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) else {
            throw NativeTranscriptionError.englishUnavailable
        }

        let transcriber = SpeechTranscriber(locale: locale, preset: .timeIndexedProgressiveTranscription)
        let modules: [any SpeechModule] = [transcriber]
        let assetStatus = await AssetInventory.status(forModules: modules)
        guard assetStatus != .unsupported else { throw NativeTranscriptionError.unavailable }
        if assetStatus != .installed {
            emitProgress(sessionID: session.id, message: "Downloading Apple’s English speech model…")
            _ = try await AssetInventory.reserve(locale: locale)
            if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                try await request.downloadAndInstall()
            }
        }
        try Task.checkCancellation()

        emitProgress(sessionID: session.id, message: "Preparing saved recording…", progress: 0)
        let audioFile = try AVAudioFile(forReading: audioURL)
        let analyzer = SpeechAnalyzer(modules: modules)
        let duration = max(session.recording.durationSeconds, 0.001)
        let sourceOffset = session.synchronization.recordingSourceOffsetSeconds

        let resultsTask = Task { [weak self] () throws -> [NativeTranscriptSegment] in
            var segments: [NativeTranscriptSegment] = []
            for try await result in transcriber.results {
                try Task.checkCancellation()
                guard result.isFinal else { continue }
                let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                let start = max(0, result.range.start.seconds.isFinite ? result.range.start.seconds : 0)
                let endValue = result.range.end.seconds
                let end = endValue.isFinite ? max(start, endValue) : start
                segments.append(NativeTranscriptSegment(
                    text: text,
                    micTimestampSeconds: start,
                    sourceTimestampSeconds: sourceOffset + start,
                    endMicTimestampSeconds: end
                ))
                self?.emitProgress(
                    sessionID: session.id,
                    message: "Transcribing on this device…",
                    progress: min(1, end / duration)
                )
            }
            return segments
        }

        return try await withTaskCancellationHandler {
            do {
                try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true)
                let segments = try await resultsTask.value
                try Task.checkCancellation()
                let text = segments.map(\.text).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
                emitProgress(sessionID: session.id, message: "Transcription complete", progress: 1)
                return NativeTranscriptionMetadata(
                    text: text,
                    language: locale.identifier,
                    provider: "apple-speech-analyzer",
                    model: "appleSpeech",
                    modelId: "SpeechTranscriber",
                    device: "apple-on-device",
                    createdAt: ISO8601DateFormatter().string(from: Date()),
                    segments: segments,
                    errorMessage: nil
                )
            } catch {
                resultsTask.cancel()
                await analyzer.cancelAndFinishNow()
                throw error
            }
        } onCancel: {
            resultsTask.cancel()
            Task { await analyzer.cancelAndFinishNow() }
        }
    }

    private func emitProgress(sessionID: String, message: String, progress: Double? = nil) {
        var payload: [String: Any] = ["sessionId": sessionID, "message": message]
        if let progress { payload["progress"] = progress }
        eventHandler?(["type": "transcriptionProgress", "payload": payload])
    }
}

private enum NativeTranscriptionError: LocalizedError {
    case alreadyRunning, recordingNotFound, unavailable, englishUnavailable

    var errorDescription: String? {
        switch self {
        case .alreadyRunning: return "Finish or cancel the current transcription first."
        case .recordingNotFound: return "The saved recording could not be found."
        case .unavailable: return "Apple on-device transcription is unavailable on this device. iOS 26 or newer is required."
        case .englishUnavailable: return "Apple’s English transcription model is unavailable for this device."
        }
    }
}

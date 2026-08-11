import Foundation

struct NativeSourceMetadata: Codable, Sendable {
    let filename: String
    let mimeType: String
    let sizeBytes: Int64
    let durationSeconds: Double
}

struct NativeRecordingMetadata: Codable, Sendable {
    let mimeType: String
    let sizeBytes: Int64
    let durationSeconds: Double
    // Optional so recordings saved by earlier builds remain decodable.
    let channelCount: Int?
}

struct NativeSynchronizationMetadata: Codable, Sendable {
    let recordingSourceOffsetSeconds: Double
    let mode: String
    let configuredValueSeconds: Double
}

struct NativeTranscriptSegment: Codable, Sendable {
    let text: String
    let micTimestampSeconds: Double
    let sourceTimestampSeconds: Double
    let endMicTimestampSeconds: Double?
}

struct NativeTranscriptionMetadata: Codable, Sendable {
    let text: String
    let language: String
    let provider: String
    let model: String
    let modelId: String
    let device: String
    let createdAt: String
    let segments: [NativeTranscriptSegment]
    let errorMessage: String?

    func dictionary() -> [String: Any] {
        [
            "text": text,
            "language": language,
            "provider": provider,
            "model": model,
            "modelId": modelId,
            "device": device,
            "createdAt": createdAt,
            "segments": segments.map { segment in
                var result: [String: Any] = [
                    "text": segment.text,
                    "micTimestampSeconds": segment.micTimestampSeconds,
                    "sourceTimestampSeconds": segment.sourceTimestampSeconds
                ]
                if let end = segment.endMicTimestampSeconds { result["endMicTimestampSeconds"] = end }
                return result
            },
            "errorMessage": errorMessage ?? ""
        ]
    }
}

struct NativeSession: Codable, Sendable {
    let id: String
    let createdAt: String
    let source: NativeSourceMetadata
    let recording: NativeRecordingMetadata
    let synchronization: NativeSynchronizationMetadata
    let transcription: NativeTranscriptionMetadata?

    func dictionary() -> [String: Any] {
        var result: [String: Any] = [
            "id": id,
            "createdAt": createdAt,
            "source": [
                "filename": source.filename,
                "mimeType": source.mimeType,
                "sizeBytes": source.sizeBytes,
                "durationSeconds": source.durationSeconds
            ],
            "recording": [
                "mimeType": recording.mimeType,
                "sizeBytes": recording.sizeBytes,
                "durationSeconds": recording.durationSeconds,
                "channelCount": recording.channelCount ?? 1,
                "playbackUrl": "/native/sessions/\(id)/audio"
            ],
            "synchronization": [
                "recordingSourceOffsetSeconds": synchronization.recordingSourceOffsetSeconds,
                "mode": synchronization.mode,
                "configuredValueSeconds": synchronization.configuredValueSeconds
            ]
        ]
        if let transcription { result["transcription"] = transcription.dictionary() }
        return result
    }
}

final class NativeSessionRepository: @unchecked Sendable {
    private let fileManager = FileManager.default
    private let lock = NSLock()
    private let root: URL

    init() {
        let support = try! fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        root = support.appendingPathComponent("Innercast/Sessions", isDirectory: true)
        try? fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        var excludedRoot = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excludedRoot.setResourceValues(values)
    }

    func recordingURL(for id: String) -> URL {
        root.appendingPathComponent(id, isDirectory: true).appendingPathComponent("recording.m4a")
    }

    func audioURL(for id: String) -> URL? {
        let url = recordingURL(for: id)
        return fileManager.fileExists(atPath: url.path) ? url : nil
    }

    func save(
        id: String,
        source: NativeSourceMetadata,
        synchronization: NativeSynchronizationMetadata,
        durationSeconds: Double,
        channelCount: Int
    ) throws -> NativeSession {
        lock.lock()
        defer { lock.unlock() }
        let directory = root.appendingPathComponent(id, isDirectory: true)
        let audioURL = directory.appendingPathComponent("recording.m4a")
        let attributes = try fileManager.attributesOfItem(atPath: audioURL.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        let session = NativeSession(
            id: id,
            createdAt: ISO8601DateFormatter().string(from: Date()),
            source: source,
            recording: NativeRecordingMetadata(
                mimeType: "audio/mp4",
                sizeBytes: size,
                durationSeconds: durationSeconds,
                channelCount: channelCount
            ),
            synchronization: synchronization,
            transcription: nil
        )
        let data = try JSONEncoder().encode(session)
        try data.write(to: directory.appendingPathComponent("metadata.json"), options: .atomic)
        return session
    }

    func list() -> [NativeSession] {
        lock.lock()
        defer { lock.unlock() }
        let directories = (try? fileManager.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        return directories.compactMap { directory in
            guard let data = try? Data(contentsOf: directory.appendingPathComponent("metadata.json")) else { return nil }
            return try? JSONDecoder().decode(NativeSession.self, from: data)
        }.sorted { $0.createdAt > $1.createdAt }
    }

    func session(id: String) -> NativeSession? {
        lock.lock()
        defer { lock.unlock() }
        let url = root.appendingPathComponent(id, isDirectory: true).appendingPathComponent("metadata.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(NativeSession.self, from: data)
    }

    func delete(id: String) throws {
        lock.lock()
        defer { lock.unlock() }
        let directory = root.appendingPathComponent(id, isDirectory: true)
        if fileManager.fileExists(atPath: directory.path) { try fileManager.removeItem(at: directory) }
    }

    @discardableResult
    func updateTranscription(id: String, transcription: NativeTranscriptionMetadata) throws -> NativeSession {
        lock.lock()
        defer { lock.unlock() }
        let metadataURL = root.appendingPathComponent(id, isDirectory: true).appendingPathComponent("metadata.json")
        let data = try Data(contentsOf: metadataURL)
        let existing = try JSONDecoder().decode(NativeSession.self, from: data)
        let updated = NativeSession(
            id: existing.id,
            createdAt: existing.createdAt,
            source: existing.source,
            recording: existing.recording,
            synchronization: existing.synchronization,
            transcription: transcription
        )
        try JSONEncoder().encode(updated).write(to: metadataURL, options: .atomic)
        return updated
    }

    func storageInfo() -> [String: Any] {
        let used = list().reduce(Int64(0)) { $0 + $1.recording.sizeBytes }
        let values = try? root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        let available = values?.volumeAvailableCapacityForImportantUsage ?? 0
        return ["usage": used, "available": available]
    }
}

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
}

struct NativeSynchronizationMetadata: Codable, Sendable {
    let recordingSourceOffsetSeconds: Double
    let mode: String
    let configuredValueSeconds: Double
}

struct NativeSession: Codable, Sendable {
    let id: String
    let createdAt: String
    let source: NativeSourceMetadata
    let recording: NativeRecordingMetadata
    let synchronization: NativeSynchronizationMetadata

    func dictionary() -> [String: Any] {
        [
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
                "playbackUrl": "/native/sessions/\(id)/audio"
            ],
            "synchronization": [
                "recordingSourceOffsetSeconds": synchronization.recordingSourceOffsetSeconds,
                "mode": synchronization.mode,
                "configuredValueSeconds": synchronization.configuredValueSeconds
            ]
        ]
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
        durationSeconds: Double
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
                durationSeconds: durationSeconds
            ),
            synchronization: synchronization
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

    func storageInfo() -> [String: Any] {
        let used = list().reduce(Int64(0)) { $0 + $1.recording.sizeBytes }
        let values = try? root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        let available = values?.volumeAvailableCapacityForImportantUsage ?? 0
        return ["usage": used, "available": available]
    }
}

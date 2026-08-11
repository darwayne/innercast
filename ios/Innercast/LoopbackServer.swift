import Foundation
import Network
import UniformTypeIdentifiers

final class LoopbackServer {
    static let port: NWEndpoint.Port = 49_321

    private let repository: NativeSessionRepository
    private weak var audio: NativeAudioPipeline?
    private let queue = DispatchQueue(label: "com.darwayne.innercast.loopback")
    private var listener: NWListener?

    init(repository: NativeSessionRepository, audio: NativeAudioPipeline) {
        self.repository = repository
        self.audio = audio
    }

    func start(completion: @escaping (Result<URL, Error>) -> Void) {
        do {
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: Self.port)
            let listener = try NWListener(using: parameters)
            self.listener = listener
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    completion(.success(URL(string: "http://127.0.0.1:\(Self.port)/")!))
                case .failed(let error):
                    completion(.failure(error))
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                connection.start(queue: self?.queue ?? .global())
                self?.receiveRequest(on: connection, accumulated: Data())
            }
            listener.start(queue: queue)
        } catch {
            completion(.failure(error))
        }
    }

    private func receiveRequest(on connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, complete, error in
            guard let self else { return }
            var request = accumulated
            if let data { request.append(data) }
            if request.range(of: Data("\r\n\r\n".utf8)) != nil {
                self.respond(to: request, on: connection)
            } else if complete || error != nil || request.count >= 65_536 {
                self.sendError(400, "Bad Request", on: connection)
            } else {
                self.receiveRequest(on: connection, accumulated: request)
            }
        }
    }

    private func respond(to data: Data, on connection: NWConnection) {
        guard let request = String(data: data, encoding: .utf8) else {
            sendError(400, "Bad Request", on: connection)
            return
        }
        let lines = request.components(separatedBy: "\r\n")
        let requestParts = (lines.first ?? "").split(separator: " ")
        guard requestParts.count >= 2 else {
            sendError(400, "Bad Request", on: connection)
            return
        }
        let method = String(requestParts[0])
        guard method == "GET" || method == "HEAD" else {
            sendError(405, "Method Not Allowed", on: connection)
            return
        }
        guard let components = URLComponents(string: String(requestParts[1])) else {
            sendError(400, "Bad Request", on: connection)
            return
        }
        let path = components.path.removingPercentEncoding ?? components.path
        guard !path.contains("..") else {
            sendError(403, "Forbidden", on: connection)
            return
        }

        let fileURL: URL?
        if path == "/native/source" {
            fileURL = audio?.selectedSourceURL
        } else if path.hasPrefix("/native/sessions/"), path.hasSuffix("/audio") {
            let parts = path.split(separator: "/")
            fileURL = parts.count == 4 ? repository.audioURL(for: String(parts[2])) : nil
        } else {
            let relative = path == "/" ? "index.html" : String(path.dropFirst())
            fileURL = Bundle.main.resourceURL?.appendingPathComponent(relative)
        }

        guard let fileURL, FileManager.default.fileExists(atPath: fileURL.path) else {
            sendError(404, "Not Found", on: connection)
            return
        }

        let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
        let rangeHeader = lines.first { $0.lowercased().hasPrefix("range:") }
        let range = parseRange(rangeHeader, fileSize: size)
        let lower = range?.lowerBound ?? 0
        let upper = range?.upperBound ?? max(0, size - 1)
        let length = size == 0 ? 0 : max(0, upper - lower + 1)
        var headers = [
            range == nil ? "HTTP/1.1 200 OK" : "HTTP/1.1 206 Partial Content",
            "Content-Type: \(mimeType(for: fileURL))",
            "Content-Length: \(length)",
            "Accept-Ranges: bytes",
            "Cache-Control: no-cache",
            "Connection: close"
        ]
        if range != nil { headers.append("Content-Range: bytes \(lower)-\(upper)/\(size)") }
        let header = Data((headers.joined(separator: "\r\n") + "\r\n\r\n").utf8)

        connection.send(content: header, completion: .contentProcessed { [weak self] error in
            guard error == nil, method != "HEAD", length > 0 else {
                connection.cancel()
                return
            }
            self?.stream(fileURL, from: UInt64(lower), remaining: length, on: connection)
        })
    }

    private func stream(_ url: URL, from offset: UInt64, remaining: Int64, on connection: NWConnection) {
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            connection.cancel()
            return
        }
        do { try handle.seek(toOffset: offset) }
        catch { try? handle.close(); connection.cancel(); return }

        func sendNext(_ left: Int64) {
            guard left > 0 else {
                try? handle.close()
                connection.cancel()
                return
            }
            let count = Int(min(left, 64 * 1_024))
            guard let chunk = try? handle.read(upToCount: count), !chunk.isEmpty else {
                try? handle.close()
                connection.cancel()
                return
            }
            connection.send(content: chunk, completion: .contentProcessed { error in
                if error == nil { sendNext(left - Int64(chunk.count)) }
                else { try? handle.close(); connection.cancel() }
            })
        }
        sendNext(remaining)
    }

    private func parseRange(_ header: String?, fileSize: Int64) -> ClosedRange<Int64>? {
        guard fileSize > 0, let value = header?.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces), value.hasPrefix("bytes=") else { return nil }
        let bounds = value.dropFirst(6).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard bounds.count == 2, let start = Int64(bounds[0]), start >= 0, start < fileSize else { return nil }
        let requestedEnd = Int64(bounds[1]) ?? (fileSize - 1)
        return start...min(max(start, requestedEnd), fileSize - 1)
    }

    private func mimeType(for url: URL) -> String {
        if let type = UTType(filenameExtension: url.pathExtension), let mime = type.preferredMIMEType { return mime }
        switch url.pathExtension.lowercased() {
        case "js": return "text/javascript"
        case "css": return "text/css"
        case "webmanifest": return "application/manifest+json"
        default: return "application/octet-stream"
        }
    }

    private func sendError(_ status: Int, _ phrase: String, on connection: NWConnection) {
        let body = Data("\(status) \(phrase)".utf8)
        let header = Data("HTTP/1.1 \(status) \(phrase)\r\nContent-Type: text/plain\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
        connection.send(content: header + body, completion: .contentProcessed { _ in connection.cancel() })
    }
}

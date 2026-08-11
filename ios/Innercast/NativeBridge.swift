import Foundation
import UIKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate, UIDocumentPickerDelegate {
    static let handlerName = "innercast"
    weak var webView: WKWebView?
    var pageReadyHandler: (() -> Void)?
    var pageLoadErrorHandler: ((Error) -> Void)?

    private let audio: NativeAudioPipeline
    private let repository: NativeSessionRepository
    private var pickerReply: ((Any?, String?) -> Void)?

    init(audio: NativeAudioPipeline, repository: NativeSessionRepository) {
        self.audio = audio
        self.repository = repository
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "http",
              message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == Int(LoopbackServer.port.rawValue),
              let body = message.body as? [String: Any],
              let command = body["command"] as? String else {
            replyHandler(nil, "Native commands are accepted only from Innercast's bundled main frame.")
            return
        }
        let payload = body["payload"] as? [String: Any] ?? [:]

        switch command {
        case "capabilities":
            replyHandler([
                "bridgeVersion": 1,
                "nativeAudio": true,
                "nativeSessions": true,
                "transcription": false
            ], nil)
        case "selectSource":
            presentSourcePicker(replyHandler: replyHandler)
        case "restoreSource":
            replyHandler(audio.restoredSourceDictionary() as Any, nil)
        case "startSession":
            Task { @MainActor [weak self] in
                do {
                    try await self?.audio.start(configuration: payload)
                    replyHandler(["started": true], nil)
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }
        case "pauseSession":
            reply({ try audio.pause(); return ["paused": true] }, using: replyHandler)
        case "resumeSession":
            reply({ try audio.resume(); return ["resumed": true] }, using: replyHandler)
        case "stopSession":
            reply({
                let session = try audio.stop(reason: payload["reason"] as? String ?? "manual")
                return session?.dictionary() as Any
            }, using: replyHandler)
        case "listSessions":
            replyHandler(repository.list().map { $0.dictionary() }, nil)
        case "getSession":
            let id = payload["id"] as? String ?? ""
            replyHandler(repository.session(id: id)?.dictionary() as Any, nil)
        case "deleteSession":
            reply({
                try repository.delete(id: payload["id"] as? String ?? "")
                return ["deleted": true]
            }, using: replyHandler)
        case "exportSession":
            guard let id = payload["id"] as? String,
                  let url = repository.audioURL(for: id) else {
                replyHandler(nil, "The recording could not be found.")
                return
            }
            presentShareSheet(for: url)
            replyHandler(["presented": true], nil)
        case "storageInfo":
            replyHandler(repository.storageInfo(), nil)
        case "diagnostics":
            replyHandler(audio.diagnostics(), nil)
        default:
            replyHandler(nil, "Unknown native command: \(command)")
        }
    }

    func send(event: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(event),
              let data = try? JSONSerialization.data(withJSONObject: event),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('innercast-native-event',{detail:\(json)}));"
        )
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.host == "127.0.0.1", url.port == Int(LoopbackServer.port.rawValue) {
            decisionHandler(.allow)
        } else if navigationAction.navigationType == .linkActivated {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReadyHandler?()
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        pageLoadErrorHandler?(error)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let reply = pickerReply else { return }
        pickerReply = nil
        guard let url = urls.first else {
            reply(nil, "No audio file was selected.")
            return
        }
        do { reply(try audio.importSource(url), nil) }
        catch { reply(nil, error.localizedDescription) }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickerReply?(nil, "cancelled")
        pickerReply = nil
    }

    private func presentSourcePicker(replyHandler: @escaping (Any?, String?) -> Void) {
        guard pickerReply == nil, let presenter = webView?.nearestViewController else {
            replyHandler(nil, "The audio picker is already open.")
            return
        }
        pickerReply = replyHandler
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: false)
        picker.allowsMultipleSelection = false
        picker.delegate = self
        presenter.present(picker, animated: true)
    }

    private func presentShareSheet(for url: URL) {
        guard let presenter = webView?.nearestViewController else { return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = webView
            popover.sourceRect = webView?.bounds ?? .zero
        }
        presenter.present(sheet, animated: true)
    }

    private func reply(_ operation: () throws -> Any, using handler: (Any?, String?) -> Void) {
        do { handler(try operation(), nil) }
        catch { handler(nil, error.localizedDescription) }
    }
}

private extension UIView {
    var nearestViewController: UIViewController? {
        var responder: UIResponder? = self
        while let current = responder {
            if let controller = current as? UIViewController { return controller }
            responder = current.next
        }
        return nil
    }
}

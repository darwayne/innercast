import SwiftUI
import WebKit

struct ContentView: View {
    @StateObject private var app = InnercastAppModel()

    var body: some View {
        ZStack {
            if let url = app.webURL {
                InnercastWebView(url: url, bridge: app.bridge)
                    .ignoresSafeArea(.container, edges: .bottom)
                    .opacity(app.isWebContentReady ? 1 : 0)
            }

            if let error = app.startupError {
                ContentUnavailableView(
                    "Innercast could not start",
                    systemImage: "exclamationmark.triangle",
                    description: Text(error)
                )
            } else if !app.isWebContentReady {
                InnercastLoadingView()
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.25), value: app.isWebContentReady)
    }
}

private struct InnercastLoadingView: View {
    private let background = Color(red: 33 / 255, green: 77 / 255, blue: 66 / 255)
    private let foreground = Color(red: 245 / 255, green: 240 / 255, blue: 231 / 255)
    private let accent = Color(red: 217 / 255, green: 95 / 255, blue: 65 / 255)

    var body: some View {
        ZStack {
            background.ignoresSafeArea()

            VStack(spacing: 24) {
                InnercastMark(foreground: foreground, accent: accent)
                    .frame(width: 188, height: 188)

                VStack(spacing: 7) {
                    Text("Innercast")
                        .font(.system(size: 34, weight: .semibold, design: .rounded))
                    Text("Play the journey. Record the experience.")
                        .font(.system(size: 15, weight: .medium, design: .rounded))
                        .opacity(0.78)
                }
                .foregroundStyle(foreground)

                ProgressView()
                    .tint(accent)
                    .padding(.top, 4)
            }
            .padding(32)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Starting Innercast")
    }
}

private struct InnercastMark: View {
    let foreground: Color
    let accent: Color

    var body: some View {
        ZStack {
            Circle().fill(foreground)
            HStack(spacing: 10) {
                bar(height: 48)
                bar(height: 108)
                bar(height: 73)
                bar(height: 29)
            }
        }
    }

    private func bar(height: CGFloat) -> some View {
        Capsule()
            .fill(accent)
            .frame(width: 14, height: height)
    }
}

@MainActor
final class InnercastAppModel: ObservableObject {
    @Published private(set) var webURL: URL?
    @Published private(set) var isWebContentReady = false
    @Published private(set) var startupError: String?

    let repository: NativeSessionRepository
    let audio: NativeAudioPipeline
    let transcription: NativeTranscriptionService
    let bridge: NativeBridge
    private let server: LoopbackServer

    init() {
        let repository = NativeSessionRepository()
        self.repository = repository
        let audio = NativeAudioPipeline(repository: repository)
        self.audio = audio
        let transcription = NativeTranscriptionService(repository: repository)
        self.transcription = transcription
        self.bridge = NativeBridge(audio: audio, repository: repository, transcription: transcription)
        self.server = LoopbackServer(repository: repository, audio: audio)
        audio.eventHandler = { [weak bridge] event in bridge?.send(event: event) }
        bridge.pageReadyHandler = { [weak self] in
            self?.isWebContentReady = true
        }
        bridge.pageLoadErrorHandler = { [weak self] error in
            self?.startupError = error.localizedDescription
        }

        server.start { [weak self] result in
            Task { @MainActor in
                switch result {
                case .success(let url): self?.webURL = url
                case .failure(let error): self?.startupError = error.localizedDescription
                }
            }
        }
    }
}

private struct InnercastWebView: UIViewRepresentable {
    let url: URL
    let bridge: NativeBridge

    func makeCoordinator() -> NativeBridge { bridge }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.addScriptMessageHandler(
            context.coordinator,
            contentWorld: .page,
            name: NativeBridge.handlerName
        )
        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.__INNERCAST_NATIVE__ = Object.freeze({ version: 1 });",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        context.coordinator.webView = webView
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard webView.url == nil else { return }
        webView.load(URLRequest(url: url))
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: NativeBridge) {
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: NativeBridge.handlerName,
            contentWorld: .page
        )
        coordinator.webView = nil
    }
}

# Innercast

**Play the journey. Record the experience.**

Innercast is a browser-only, device-local audio companion. It plays a local source file while recording the microphone, preserves a simple source-to-microphone timeline mapping, and saves completed recordings as Blobs in IndexedDB. It has no backend, analytics, or cloud storage. Optional post-recording transcription runs Whisper or Moonshine inside the browser; microphone audio is never sent to a transcription service.

The source picker explicitly supports AAC, M4A, MP4 audio, MP3, FLAC, WAV, AIFF, and CAF. Because iOS Files sometimes reports local audio with an empty or generic MIME type, Innercast also recognizes these filename extensions and lets the browser's audio decoder make the final compatibility decision. The most recently selected playable source file is saved as a Blob in IndexedDB and restored automatically after a refresh. Selecting another source replaces it, so only one reusable source copy is retained.

## Native iOS app

The dependency-free SwiftUI project in `ios/` packages the same web interface inside a native app. A loopback-only server bound to `127.0.0.1:49321` serves the checked-in web assets from the application bundle, so there is one shared web source tree and no network server is required at runtime. The native bridge replaces only the audio and session-storage pipelines; the standalone browser application continues using its existing browser implementations.

1. Copy `ios/Config/Signing.local.example.xcconfig` to `ios/Config/Signing.local.xcconfig`, then set your Apple Developer team ID and a unique reverse-DNS bundle identifier. The local file is ignored by Git, so personal developer configuration stays out of commits. Keep the bundle identifier unchanged after installing the app if you want future builds to retain its on-device data.
2. Open `ios/Innercast.xcodeproj` in Xcode.
3. Connect and unlock the iPhone, trust the Mac if prompted, and select the iPhone as the run destination.
4. Press **Run**. Accept the microphone prompt on first use.
5. Choose an audio file. Preview and seek work through the shared interface.
6. Choose any recording-start mode and start the session. The app requests the built-in iPhone microphone, permits Bluetooth A2DP output, and explicitly prohibits the mono Bluetooth HFP profile.
7. Pause/resume or stop normally. Completed microphone audio is encoded as AAC/M4A and saved with synchronization metadata in the app's Application Support directory.
8. Open **Sessions** to replay, export through the native share sheet, or delete recordings.

The native app requires iOS 18 or newer and uses only SwiftUI, WebKit, Network, AVFoundation, and system file APIs. It retains the timestamp and session model used by the browser application. Native recordings and the last selected source are excluded from device backup and never leave the device. Native transcription is intentionally deferred; the standalone browser application retains the existing Whisper and Moonshine features.

## Run on macOS

The only runtime dependency is the `python3` included with macOS developer tools.

```sh
make start
```

The server binds to `0.0.0.0`, so it is available to other devices on the same network. On the Mac, open <http://127.0.0.1:8080>. From another device, use the Mac's LAN address, such as `http://192.168.1.20:8080`.

Choose another port when needed:

```sh
make start PORT=4321
```

To restrict the server to the Mac itself:

```sh
make start BIND=127.0.0.1
```

## Private HTTPS through Tailscale

Mobile Safari only exposes microphone APIs to secure HTTPS pages. A Tailscale IP reached over plain `http://` is private, but it is not a browser secure context.

If Tailscale is installed on the Mac and the iPhone is connected to the same tailnet, run:

```sh
make tailscale
```

This starts the Python server on localhost and runs Tailscale Serve in front of it. On first use, Tailscale may display a consent URL so HTTPS certificates can be enabled for the tailnet. It then prints a private address similar to:

```text
https://your-mac.your-tailnet.ts.net
```

Open that exact HTTPS address in Safari on the iPhone. Tapping **Start session** will then trigger Safari's microphone permission prompt. Press `Control-C` on the Mac to stop both Tailscale Serve and the local Python server.

Choose a different internal port if necessary:

```sh
make tailscale PORT=4321
```

This does not make Innercast public and does not upload audio. Tailscale Serve only proxies application traffic within the tailnet.

There is no install or build step. The browser-ready JavaScript is committed in `app/`; the typed domain source is in `src/`.

## Offline use and Home Screen installation

Innercast installs a service worker on its first successful HTTPS visit. It caches the application shell, routes, and pinned Transformers.js/ONNX runtime so Record, Sessions, and Settings can be opened later without reaching the Mac or Tailscale endpoint. The selected source file, recordings, metadata, and transcripts already live in IndexedDB.

For reliable offline preparation:

1. Open Innercast once while the Mac/Tailscale endpoint and internet are available.
2. Wait for the **Innercast is ready for offline use** message.
3. If transcription is needed offline, successfully run each desired model once while online. Only models actually used are downloaded and cached.
4. Optionally choose Safari's **Share → Add to Home Screen** for a standalone launcher.
5. Test by disconnecting from the network and refreshing Innercast.

The service worker deliberately does not duplicate transcription-model files. Innercast streams uncached model responses into a dedicated IndexedDB model cache in 32 MB Blob chunks. Interrupted downloads resume with an HTTP Range request when the model host supports it, while models cached by older Innercast versions remain usable from Transformers.js's browser cache. The v11 cache migration removes model assets stored with the previous 4 MB layout as each asset is requested, then downloads it once in the new layout; it does not touch recordings or sessions. Safari can evict both Cache Storage and IndexedDB under storage pressure, and clearing website data removes the app's offline assets, models, and recordings. Export important recordings separately.

## How synchronization works

Each saved session stores one authoritative value:

```text
sourceTimestamp = recordingSourceOffsetSeconds + microphoneRecordingTimestamp
```

For an absolute start at 5:30, microphone time `0` maps to source time `330`. A 30-second delayed start is normalized to the source position at which recording actually starts. If playback begins from a non-zero seek position, immediate mode maps microphone time `0` to that position, and delay mode adds its delay to that position.

Innercast plays the source through the native `HTMLAudioElement` output path and uses its media clock (`currentTime`) alongside an `AudioContext` clock. The source is intentionally not routed through a `MediaElementAudioSourceNode`: direct media-element output is more reliable when Mobile Safari switches into its microphone-capture audio session. A display animation observes when the source reaches the configured threshold; the actual source position at `MediaRecorder.start()` becomes the saved offset. This avoids treating `setTimeout`, `setInterval`, or wall-clock time as synchronization truth. MediaRecorder start latency is browser-controlled, so this is deterministic timeline alignment rather than sample-accurate synchronization.

Seeking and configuration are locked for the entire active session. Pausing pauses both playback and MediaRecorder; resuming resumes both. This maintains the one-offset invariant without continuously timestamping samples.

## Start modes

- **Start together:** recording starts with playback.
- **At a timestamp:** recording begins when the source reaches an absolute `HH:MM:SS`, `MM:SS`, or seconds value.
- **After a delay:** recording begins after the chosen amount of source playback has elapsed.

The user may preview and seek before starting. An absolute recording timestamp cannot be earlier than the selected playback position.

## Saved sessions and privacy

Completed microphone Blobs and metadata are stored directly in the versioned `synchronized-audio-recorder` IndexedDB database. Saved sessions contain source metadata rather than separate source copies; one shared copy of the most recently selected source is retained for convenient playback after refreshing. Saved sessions can be replayed, exported through the browser, or deleted. Browser storage estimates are shown when `navigator.storage.estimate()` is available, and quota failures produce an explicit message.

The Record, Sessions, and Settings screens use static-host-safe hash routes: `#/recorder`, `#/sessions`, and `#/settings`. Refreshing, bookmarking, and browser back/forward navigation preserve the selected screen without requiring server-side route rewriting.

The Settings screen also offers a microphone preference. Innercast uses `enumerateDevices()` to list the audio inputs the browser exposes and requests a selected device with an exact `deviceId` constraint. Device labels may remain hidden until the user taps **Find microphones** and grants access. The preference stays on the device in local storage. If the chosen input disappears, Innercast stops before starting a session and asks the user to reconnect it or choose another input rather than silently recording from the wrong microphone.

Each saved session offers one **Transcribe** action. The default is **Whisper Small English** (roughly 250 MB); choose a different default on `#/settings`. Other Whisper choices are **Tiny English** (roughly 45 MB), **Base English** (roughly 80 MB), and experimental **Distil-Medium English** (roughly 405 MB). Moonshine choices are **Tiny English** (roughly 55 MB), **Base English** (roughly 127 MB), experimental **Small Streaming English** (roughly 216 MB), and bleeding-edge **Medium Streaming English** (roughly 363 MB). Moonshine Tiny and Base use Transformers.js with the official FP32-encoder/q8-decoder WASM configuration. The v2 Small and Medium choices use pinned, merged-decoder INT8 ONNX exports through ONNX Runtime Web; the merged graph avoids keeping two mostly duplicated decoder models in memory. Innercast first saves the recording and only then decodes and transcribes it in a Web Worker, so transcription cannot compete with or interrupt active microphone capture. Sections are processed sequentially and the completed text plus approximate microphone/source timestamps are written back to the same IndexedDB session. Whisper uses zero-padded 30-second windows, original Moonshine receives variable windows up to 30 seconds, and Moonshine v2 uses shorter 15-second windows to limit peak mobile memory.

The first use of a model requires internet access to download the pinned inference runtime and selected model from their public asset hosts. Downloaded chunks are persisted as they arrive, so retrying after a network interruption or WebKit worker termination can continue instead of retaining or redownloading one enormous response. Browser storage normally avoids repeating the model download, but Safari may evict cached assets. Once the runtime and model have loaded successfully, that choice can be reused offline. Inference is local: only application/runtime/model files are downloaded, and the recording is never uploaded. All current choices are English-only. The larger models are experimental. Moonshine Medium in particular can still exceed Safari's runtime memory limit even though its download is resumable and its files are cached in chunks; download chunking prevents the avoidable download-time spike but cannot remove the memory needed by ONNX Runtime during inference. Cache schema version 2 removes files belonging to the retired full Whisper Medium and Distil-Large choices without deleting working models, recordings, or sessions.

Moonshine v2 Small Streaming and Medium Streaming use community INT8 ONNX exports derived from the official Useful Sensors checkpoints. They run as post-recording chunk transcription rather than live incremental transcription, matching Innercast's saved-session workflow. Tiny Streaming is not separately listed because it is smaller than Base and currently lacks the same memory-saving merged browser export; the existing Tiny and Base choices cover the lightweight comparison points without loading two duplicate decoder graphs.

Clearing Safari website data or using private browsing can remove recordings. Export anything important. The first version assembles each recording in memory before saving, which is appropriate for the expected recordings of roughly 50 MB or less; the recorder already isolates chunk collection so incremental persistence can be added later.

## Test on a physical iPhone

Microphone access requires a **secure context**. `localhost` is accepted on the Mac itself, but an iPhone opening the Mac's plain `http://` LAN address will generally not receive microphone access.

For realistic testing:

1. Run `make tailscale` for private tailnet HTTPS, publish the static files to an HTTPS host, or serve them from another trusted local HTTPS endpoint.
2. Open that HTTPS URL in Safari on the iPhone.
3. Connect headphones, select an audio file from Files, and tap **Start session**.
4. Allow microphone access when prompted.
5. Exercise pause/resume, manual stop, automatic stop at source end, playback from the Sessions screen, export, and delete.
6. Keep Safari visible throughout the session. Innercast requests a screen wake lock while recording to prevent automatic locking when supported, but it cannot prevent a manual lock or iOS suspension.

The static host only delivers application assets. Selected audio and microphone data never leave the browser. To test transcription, stop and save a session, open **Sessions**, select a model, and tap **Transcribe**. The first run needs internet access for the model download.

## iPhone Safari limitations

- Innercast requests a Screen Wake Lock for active sessions and reacquires it after the page becomes visible. Safari or iOS may still suspend playback/recording if the app is backgrounded or the phone is manually locked; a browser app cannot bypass those OS restrictions.
- MediaRecorder MIME support varies by Safari/iOS version, so Innercast probes MP4/AAC and WebM options at runtime and stores the selected MIME type.
- Microphone capture disables echo cancellation while keeping noise suppression and automatic gain control enabled. This tests the WebKit-recommended workaround for playback ducking while retaining the other voice-processing features.
- MediaRecorder is not sample-locked to the Web Audio clock. Start/pause/resume calls have small browser-controlled latency.
- On-device transcription can be slow, memory intensive, and heat the phone. Keep Safari visible and the phone unlocked. iOS may terminate a memory-heavy tab, but the recording is already safely saved before transcription begins.
- Transcription runs in sequential bounded sections (15 seconds for Moonshine v2 and up to 30 seconds for other models). Segment timestamps are approximate, and a word crossing a section boundary may be less accurate.
- On supported iOS releases, Innercast applies an experimental WebKit routing sequence: it selects `play-and-record` immediately before acquiring the microphone, then switches to `playback` while retaining the active microphone stream. This aims to restore high-quality stereo Bluetooth output without ending recording. Before ordinary source or saved-recording playback, Innercast also applies a `playback` → `auto` reset sequence to restore normal media routing.
- Bluetooth headsets commonly enter a lower-quality mono voice profile when their own microphone is active. Selecting the iPhone microphone in Settings may allow AirPods to remain on their stereo playback route, but Safari/iOS ultimately controls routing and may expose only one input or disregard connected-device routing in some states.
- IndexedDB quota is device- and browser-dependent. There is no guaranteed capacity, and private browsing is unsuitable for durable archives.
- Incoming calls, route changes, device disconnection, or revoked microphone permission may interrupt a session.

## Tests

Run:

```sh
make test PORT=8081
```

Then open <http://127.0.0.1:8081/tests/>. The dependency-free browser suite covers timestamp parsing, invalid values, offset validation, source/microphone alignment calculations, audio file recognition, and the available transcription-model configuration.

## Project structure

```text
index.html                    Mobile-first application shell
styles.css                   Responsive visual design
app/app.js                   UI and session orchestration
app/controllers.js           Recorder and synchronization controllers
app/repository.js            Versioned IndexedDB sessions and last-source storage
app/timestamp.js             Timestamp and alignment helpers
app/file-types.js            Robust audio file recognition
app/whisper-transcriber.js   Post-recording decode and worker lifecycle
app/whisper-worker.js        On-device Whisper/Moonshine inference and chunk mapping
service-worker.js            Offline application/runtime caching
manifest.webmanifest         Home Screen installation metadata
assets/innercast-icon.svg    Install and browser icon
src/                         Typed domain source
tests/                       Dependency-free browser tests
Makefile                     Local static server commands
```

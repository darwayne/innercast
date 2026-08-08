# Innercast

**Play the journey. Record the experience.**

Innercast is a browser-only, device-local audio companion. It plays a local source file while recording the microphone, preserves a simple source-to-microphone timeline mapping, and saves completed recordings as Blobs in IndexedDB. It has no backend, analytics, or cloud storage. Optional post-recording transcription runs Whisper inside the browser; microphone audio is never sent to a transcription service.

The source picker explicitly supports AAC, M4A, MP4 audio, MP3, FLAC, WAV, AIFF, and CAF. Because iOS Files sometimes reports local audio with an empty or generic MIME type, Innercast also recognizes these filename extensions and lets the browser's audio decoder make the final compatibility decision. The most recently selected playable source file is saved as a Blob in IndexedDB and restored automatically after a refresh. Selecting another source replaces it, so only one reusable source copy is retained.

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

The Record and Sessions screens use static-host-safe hash routes: `#/recorder` and `#/sessions`. Refreshing, bookmarking, and browser back/forward navigation preserve the selected screen without requiring server-side route rewriting.

Each saved session offers optional on-device Whisper transcription. Choose **Tiny English** (fastest, roughly 75 MB) or **Base English** (better accuracy, roughly 142 MB), then leave the Sessions screen open while it runs. Innercast first saves the recording and only then decodes and transcribes it in a Web Worker, so transcription cannot compete with or interrupt active microphone capture. Thirty-second chunks are processed sequentially and the completed text plus approximate microphone/source timestamps are written back to the same IndexedDB session.

The first use of a model requires internet access to download the pinned Transformers.js runtime and quantized Whisper model from their public asset hosts. Browser caching normally avoids repeating the model download, but Safari may evict cached assets. Inference is local: only application/runtime/model files are downloaded, and the recording is never uploaded. Tiny and Base are English-only in this version.

Clearing Safari website data or using private browsing can remove recordings. Export anything important. The first version assembles each recording in memory before saving, which is appropriate for the expected recordings of roughly 50 MB or less; the recorder already isolates chunk collection so incremental persistence can be added later.

## Test on a physical iPhone

Microphone access requires a **secure context**. `localhost` is accepted on the Mac itself, but an iPhone opening the Mac's plain `http://` LAN address will generally not receive microphone access.

For realistic testing:

1. Run `make tailscale` for private tailnet HTTPS, publish the static files to an HTTPS host, or serve them from another trusted local HTTPS endpoint.
2. Open that HTTPS URL in Safari on the iPhone.
3. Connect headphones, select an audio file from Files, and tap **Start session**.
4. Allow microphone access when prompted.
5. Exercise pause/resume, manual stop, automatic stop at source end, playback from the Sessions screen, export, and delete.
6. Keep Safari visible and the phone unlocked throughout the session.

The static host only delivers application assets. Selected audio and microphone data never leave the browser. To test transcription, stop and save a session, open **Sessions**, select Tiny or Base, and tap **Transcribe**. The first run needs internet access for the model download.

## iPhone Safari limitations

- Safari or iOS may suspend playback/recording if the page is backgrounded or the phone locks. Innercast warns on visibility changes but cannot bypass OS restrictions.
- MediaRecorder MIME support varies by Safari/iOS version, so Innercast probes MP4/AAC and WebM options at runtime and stores the selected MIME type.
- MediaRecorder is not sample-locked to the Web Audio clock. Start/pause/resume calls have small browser-controlled latency.
- On-device Whisper can be slow, memory intensive, and heat the phone. Keep Safari visible and the phone unlocked. iOS may terminate a memory-heavy tab, but the recording is already safely saved before transcription begins.
- Whisper is run in sequential 30-second sections. Segment timestamps are approximate, and a word crossing a section boundary may be less accurate.
- IndexedDB quota is device- and browser-dependent. There is no guaranteed capacity, and private browsing is unsuitable for durable archives.
- Incoming calls, route changes, device disconnection, or revoked microphone permission may interrupt a session.

## Tests

Run:

```sh
make test PORT=8081
```

Then open <http://127.0.0.1:8081/tests/>. The dependency-free browser suite covers timestamp parsing, invalid values, offset validation, source/microphone alignment calculations, audio file recognition, and the available Whisper model configuration.

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
app/whisper-worker.js        On-device Whisper inference and chunk mapping
src/                         Typed domain source
tests/                       Dependency-free browser tests
Makefile                     Local static server commands
```

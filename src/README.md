# TypeScript source

This directory contains the typed domain model and the timing/persistence modules. The dependency-free browser build in `app/` mirrors these modules and includes the DOM application controller. Keeping the emitted JavaScript in the repository means running Innercast requires no package installation or build step.

The browser modules use standards-based APIs and intentionally avoid a framework. Optional post-recording transcription is the one external runtime component: workers load pinned Transformers.js or ONNX Runtime Web releases and the user-selected Whisper or Moonshine model, then perform inference locally. The browser build's model-cache module incrementally persists remote model files as IndexedDB Blob chunks for either runtime. `moonshine-v2-worker.ts` points to the served direct-ONNX implementation used by the larger Moonshine streaming architecture.

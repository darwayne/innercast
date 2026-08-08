# TypeScript source

This directory contains the typed domain model and the timing/persistence modules. The dependency-free browser build in `app/` mirrors these modules and includes the DOM application controller. Keeping the emitted JavaScript in the repository means running Innercast requires no package installation or build step.

The browser modules use standards-based APIs and intentionally avoid a framework. Optional post-recording transcription is the one external runtime component: the worker loads a pinned Transformers.js release and a user-selected Whisper or browser-ready Moonshine model, then performs inference locally. The browser build's model-cache module implements the Cache-like Transformers.js hook and incrementally persists remote model files as IndexedDB Blob chunks.

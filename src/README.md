# TypeScript source

This directory contains the typed domain model and the timing/persistence modules. The dependency-free browser build in `app/` mirrors these modules and includes the DOM application controller. Keeping the emitted JavaScript in the repository means running Innercast requires no package installation or build step.

The browser modules use standards-based APIs and intentionally avoid a framework. Optional post-recording transcription is the one external runtime component: the worker loads a pinned Transformers.js release and a user-selected quantized Whisper Tiny, Base, Small, or Medium model, then performs inference locally.

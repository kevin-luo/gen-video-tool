# Development plan

## Phase 1 — deterministic production loop

Status: implemented and covered by the repository acceptance commands.

- Schema v2 for manifest, shots, actors, rigs, transitions, titles, audio, and external SRT.
- Schema migration helpers and strict reference/ID validation.
- Secure ZIP/directory staging import with structured diagnostics.
- Eight fixed motion recipes, frame-addressed events, true per-layer parallax, Rigid Actor, and compliant Pose Cut.
- Shared Remotion preview/export evaluator.
- Local MP4 render, narration mux, external SRT copy, and QA frame extraction.
- Football and quiet-story examples.

## Phase 2 — desktop editor

Status: functional product loop implemented; packaging/distribution signing remains release work.

- Local project home, create, open, import, recent projects, and guarded deletion.
- Import review with blocking errors, warnings, repair hints, and reselect.
- Shot rail, true project preview, inspector, story-beat timeline, undo/redo, and debounced atomic save.
- Real export phases, progress events, cancel signal, readable failure state, and open-output action.
- Narrow Electron preload; no Node access in the renderer.

Release follow-ups:

- Add signed Windows/macOS installers and auto-update channel.
- Persist user UI preferences and window state.
- Add cancellable FFmpeg subprocess termination after Remotion has completed but mux/QA is still running.
- Add end-to-end packaged-app tests on CI runners with GPU and software-render fallbacks.

## Phase 3 — optional motion worker

Status: protocol, executable detection, request/result validation, action templates, and Godot sample worker implemented.

Reliable automatic mesh generation, production weights, self-intersection prevention, and real-asset certification remain planned. The current worker fails closed and never labels a placeholder rig as production-ready.

## Acceptance

```text
npm install
npm run typecheck
npm run test
npm run validate:examples
npm run render:football
npm run render:story
npm run qa:frames
npm run build:desktop
```

Required outputs:

```text
output/football/final.mp4
output/football/subtitles.srt
output/story/final.mp4
output/story/subtitles.srt
```

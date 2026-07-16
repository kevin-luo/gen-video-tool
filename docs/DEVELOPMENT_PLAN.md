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

## Phase 3 — Mesh Puppet

Status: implemented and exercised through the desktop app.

- Godot Worker reads a complete character PNG and validated `rig.json`.
- Runtime construction of `Skeleton2D`, hierarchical `Bone2D`, and weighted continuous `Polygon2D` mesh.
- Ten deterministic action templates with start frame, active duration, amplitude, and fps.
- Transparent PNG sequence, VP9 Alpha WebM, and ProRes 4444 MOV output.
- Electron IPC load/render/save path, restricted preview protocol, draggable dual-end bone correction, keyboard nudge, read-only handling, and unsaved-change warning.
- Render service pre-renders Mesh actors and fails explicitly if Godot or transparent output is unavailable.

## Phase 4 — auxiliary capabilities

Status: first reusable local version implemented.

- Automatic first-pass rig from the complete PNG Alpha silhouette, with regular continuous mesh and normalized bone weights; correction remains required for unusual poses.
- RIFE PNG-sequence interpolation client and CLI with destructive-path and frame-count gates; the external model executable is optional and not redistributed.
- Multi-project batch export and JSON result report.
- Validated local template catalog, safe installation, and desktop template browser.

Commercial hardening still required: multi-person automatic keypoint inference, self-intersection scoring, GPU/CPU benchmark matrix, signed runtime bundles, remote template registry, licensing review, and broader real-asset certification.

## Acceptance

```text
npm install
npm run typecheck
npm run test
npm run validate:examples
npm run render:football
npm run render:story
npm run render:mesh-preview
npm run render:mesh-webm
npm run render:batch -- quiet-story football-history
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

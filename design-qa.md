# Design QA

## Scope

- Target: selected option 3 creator-first desktop design.
- Implementation: `apps/codex-studio/web/` at 1536 × 1024, plus narrow-layout and live-state checks.
- Same-input visual comparison: `docs/design-audit/2026-07-18/05-reference-vs-implementation.png` (target left, implementation right).

## Comparison pass

- Typography: large black Chinese display heading, compact supporting copy, and quiet utility text preserve the target hierarchy. CJK system fallbacks render consistently without remote font dependencies.
- Layout and spacing: centered navigation, wide script canvas, platform segment, settings summary, dominant red CTA, and recent-work rail match the selected composition. The empty library intentionally uses a real empty state instead of the target's fictional thumbnails.
- Colors and surfaces: warm porcelain background, neutral hairlines, single cinnabar action color, restrained shadow, and modest radii match the target direction.
- Assets and icons: no fake platform marks, emoji, CSS drawings, inline SVG substitutes, or fabricated work imagery remain. Finished work cards use real local thumbnails/video only.
- Copy: the default path says what the tool actually does. It explicitly keeps local generation, F5-TTS, external SRT, and no-BGM behavior aligned with the product.

## States and interactions

- Verified default, validation, 300-character count, file import, platform radio group, Ctrl+Enter, loading/progress, failure/retry, completed video/SRT contracts, empty library, works navigation, and advanced settings.
- Live backend evidence: `docs/design-audit/2026-07-18/04-real-generation-progress.png` shows the script canvas transformed in place while a real FastWan job was running.
- Completed-state evidence: `docs/design-audit/2026-07-18/11-real-completed-work.png` uses the generated local thumbnail and 20-second result rather than sample content.
- The advanced dialog exposes duration, voice, existing projects, active jobs, and runtime detection without putting engineering controls on the default page.
- Browser console check returned no warnings or errors.

## Responsive and accessibility

- Narrow-layout evidence: `docs/design-audit/2026-07-18/06-mobile.png`; controls stack without overlap and the primary action remains visible.
- Semantic heading, form, fieldset, radio, checkbox, slider, dialog, status, alert, and video controls are present. Inputs have accessible labels and error relationships.
- Keyboard focus styles, skip link, reduced-motion handling, practical targets, and contrast were checked in CSS and browser state.

## Fixes made during QA

- P2 behavior: quick-progress JSON contained a per-shot percentage that could override the overall percentage. JSON progress is now parsed before human-readable percentages.
- P2 behavior: visual and voice steps were shown in the wrong order. The UI now reflects the actual script → voice → visual → render sequence.
- P2 content: the first real animal-led sample gave action ownership to an offscreen human hand. That sample is content-rejected, not presented as a world-logic pass. The shot contract now keeps the named animal as the visible agent and requires its own two forelimbs to operate tools; a fresh model run remains the acceptance proof for that content rule.
- P2 performance: retry now reuses validated narration and generated shot files; progress logging emits only meaningful changes.

The real delivery probe passed: H.264 720 × 1280 at 24 fps, AAC narration at 48 kHz, exact 20.000-second duration, six generated shots, external SRT, no burned subtitles, and no BGM stream.

The design and technical-delivery checks pass independently of content acceptance. The current cat sample proves the local motion/render path but is explicitly rejected for action ownership; the revised prompt must be validated on the next fresh generation before it can be used as a physical-consistency sample.

## Open findings

- P0: 0
- P1: 0
- P2: 0

final result: passed

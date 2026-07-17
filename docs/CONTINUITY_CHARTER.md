# Continuity Charter

Gen Video Tool exists to make generated video durable, controllable, and locally owned. It does not depend on the continued existence of one hosted model or API.

## Product principles

1. **A shot is a continuous world, not a slideshow.** Human motion comes from a real local video model. Collage, pose cuts, and layer micro-motion are editorial tools and are never presented as continuous character performance.
2. **Direction precedes generation.** Every generated shot declares its action axis, milestones, camera owner, subject facing, support surface, and causal contacts before any model job starts.
3. **Physics is a gate, not prompt decoration.** Structured facing, support, contact, occlusion, and deterministic-prop rules survive outside prose prompts and block invalid selection or export where they can be verified.
4. **The model produces a plate; the editor owns the film.** Local I2V creates continuous people and environments. Remotion owns delivery framing, focal crop, titles, graphics, narration, transitions, and deterministic foreground/prop layers.
5. **No silent fallback.** A missing model, failed candidate, absent matte, unselected shot, or incomplete narration stops export with an actionable reason. A static image must never impersonate a successful video generation.
6. **Every result is reproducible and reviewable.** Preset, seed, request, provider state, hashes, technical QA, contact-adjacent frames, and the human decision are stored with the local project.
7. **The user owns the pipeline.** Source assets, models, candidates, narration, subtitles, and final renders stay on the user's machine by default. Providers are replaceable adapters, not the product's center of gravity.
8. **Human taste remains final.** Automatic checks can reject broken media and surface risks; they do not pretend to judge anatomy, identity, timing, or emotional truth completely. Two candidates and explicit human selection are the minimum production loop.

## Architectural consequence

The canonical project is a single immutable `production.json` plus source assets. Mutable work is written only under `generated/`. The desktop app performs local generation and review; the render service consumes only selected, verified state; the web ChatGPT Skill creates portable source packs but never fabricates completed local outputs.

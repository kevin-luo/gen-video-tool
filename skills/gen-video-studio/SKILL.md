---
name: gen-video-studio
description: Operate Gen Video Tool from a Codex conversation. Use when the user asks to turn a script into a paper-collage video, generate or import Imagegen assets, open the localhost studio, track or retry a local creation, synthesize F5-TTS narration, render MP4 with sidecar SRT, or explicitly use optional Wan realistic-video mode.
---

# Gen Video Studio

Use paper collage as the default visual mode. Treat localhost as the observable local production surface and `gen_video_*` MCP tools as the execution boundary. Never imply that an asset, model run, or render succeeded until a real artifact exists and the corresponding job reaches `complete`.

## Start or resume

1. Call `gen_video_get_status` and return `studioUrl` when the user asks to open the tool.
2. Keep long work asynchronous. Return the creation/job ID, poll its status, and do not enqueue an equivalent duplicate.
3. Use Wan only when the user explicitly requests realistic continuous video or a suitable people-free background plate.

## Default paper-collage workflow

1. Confirm or infer the finished spoken script, platform, 20–60 second duration, narration choice, no-BGM requirement, and sidecar-SRT delivery.
2. Call `gen_video_create_from_script` first. Keep its returned `creation_id`; the new request remains `awaiting-assets` and does not start Wan.
3. Split the script into narration-aligned beats. Give each beat one clear visual metaphor and only 3–6 large paper groups.
4. Plan a flat paper field, whole character/animal cutouts, environment groups, props, foreground occluders, and accents. Keep every performing character as one complete uninterrupted PNG; never split limbs or animate exposed body parts.
5. In a Codex conversation, generate the approved imagery with built-in Imagegen. Prefer the editorial profile: flat bold color field, black-and-white halftone subject cutouts, cream keylines, restrained paper shadows, and selective cardstock accents. Inspect alpha, complete silhouettes, limb count, facing, support, prop ownership, and crop boundaries. In standalone mode, use the configured image provider instead; `scripts/stylize-paper-cutout.ts` is the deterministic fallback for an already-approved complete PNG.
6. Invoke `$create-gen-video-asset-pack` to build a v3 pack containing only `layered-collage` shots whose exact duration matches the creation request.
7. Call `gen_video_inspect_collage_assets` with `creation_id` and the local ZIP/directory path. Fix every blocker; this step is read-only.
8. Call `gen_video_attach_collage_assets` with the same `creation_id` and source path. Attachment is atomic and queues F5-TTS plus deterministic Remotion/FFmpeg production.
9. Poll `gen_video_get_creation` until a terminal state. Use `gen_video_get_job` only for bounded diagnostics. Do not enqueue another creation while the attached one is running.
10. On `complete`, return only the real MP4/SRT paths and `studioUrl`. Confirm that subtitles are sidecar-only and BGM is absent. On failure, retry only the failed asset or job.

The renderer starts each beat from the empty paper field, places 3–6 groups with staggered `slide`, `snap`, and `stamp`, preserves explicit z-order/foreground occlusion, optionally gives a complete actor card one finite quantized `bob`, `sway`, `gesture`, or `exit`, then returns to an exact final hold. Never use a perpetual idle loop.

## Image generation boundary

The localhost page cannot call Codex built-in Imagegen and cannot borrow ChatGPT cookies, subscription tokens, browser sessions, or authorization JSON.

- In a Codex conversation, generate images with built-in Imagegen, save them locally, then inspect and attach the resulting collage pack to the existing creation.
- In standalone localhost/Electron use, require a configured image provider or a user-supplied asset pack. If neither exists, stop at asset generation with an actionable error.
- Never silently replace missing paper assets with Wan footage or placeholder images.

## Optional realistic mode

Use WanGP only after the user explicitly selects realistic continuous motion. Run capability detection, generate immutable candidates, and require review for identity, anatomy, direction, support, contact, occlusion, continuity, and camera stability. Wan may also generate a people-free background plate when appropriate, but it does not own default paper-character motion.

After all realistic candidates are accepted, run F5-TTS and the same Remotion/FFmpeg delivery gates. Final delivery remains MP4 + external SRT, without burned subtitles or BGM.

## Failure discipline

- Treat missing image assets/provider, invalid packs, missing local models, failed QA, missing voice reference, and render errors as blockers.
- Report the last meaningful stage and exact next action. Do not claim that a static placeholder or failed generated clip is a finished video.
- Use `gen_video_cancel_job` only when the user asks to stop or a queued job is an obvious duplicate.
- Preserve human visual review for anatomy and world logic; technical QA cannot certify narrative or physical correctness.

Read [references/conversation-recipes.md](references/conversation-recipes.md) for unfamiliar asset-pack recovery or optional realistic-mode tool calls.

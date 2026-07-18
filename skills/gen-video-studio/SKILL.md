---
name: gen-video-studio
description: Operate Gen Video Tool from a Codex conversation. Use when the user asks to start/open the local video studio, turn an idea into a validated Imagegen asset pack, import a pack, inspect a v3 project, run local WanGP generation, review/select candidates, synthesize F5-TTS narration, render an MP4 with sidecar SRT, or continue a stopped local video workflow.
---

# Gen Video Studio

Treat Codex as the director and the localhost studio as the observable production surface. Use Codex built-in Imagegen for source imagery; use the `gen_video_*` MCP tools for local project state and execution. Never imply that the browser page itself runs a model.

## Start or resume

1. Call `gen_video_get_status` and return its `studioUrl` when the user asks to open or start the tool.
2. Call `gen_video_list_projects` before assuming a project ID.
3. Call `gen_video_get_project` before deciding the next production step.
4. Keep long work asynchronous: start one job, report its ID, then poll `gen_video_get_job`. Do not issue duplicate generation while an equivalent queued or running job exists.

## Create from conversation

1. Agree on topic, duration, spoken copy, shots, visual continuity, camera ownership, and world/physics constraints.
2. Invoke `$create-gen-video-asset-pack` to build the v3 source pack. That Skill owns its voice-reference gate, Imagegen asset requirements, schema, validation, and ZIP assembly.
3. Generate each distinct source image with one Codex built-in Imagegen call. Inspect each result before packaging. Do not call an external image API or ask the desktop app to borrow ChatGPT cookies, subscription tokens, or browser credentials.
4. Call `gen_video_inspect_asset_pack`. Fix every blocking diagnostic.
5. Call `gen_video_import_asset_pack` only after inspection is ready.
6. Return the imported project ID and studio URL, then continue with local production when the user asked for end-to-end execution.

The source pack is immutable input. Never place generated candidates, narration state, or final renders inside it.

## Run local production

For every `generated-performance` shot:

1. Start `gen_video_detect_runtime` once per project/session and wait for a completed job whose result says the requested preset is available.
2. Start `gen_video_generate_shot`. One invocation generates the next planned immutable seed only; call again only after the first candidate finishes.
3. Read the refreshed project. Do not select automatically.
4. Ask the user to inspect the actual candidate video in the studio. Check identity, anatomy, direction, support, contact, occlusion, continuity, and camera stability.
5. Use `gen_video_select_candidate` only after explicit user acceptance. Use `gen_video_reject_candidate` with a concrete reason when it fails.

After every generated shot is selected, start `gen_video_synthesize_narration`. After narration completes, start `gen_video_render_project`. Poll each job to a terminal state and return the real output paths. The final delivery remains MP4 + external SRT, with no burned subtitles and no BGM.

## Failure discipline

- Treat missing models, invalid packs, failed technical QA, unselected candidates, missing voice reference, and render errors as blockers.
- Report the last meaningful job log and the exact next action. Never replace failed motion with a static keyframe.
- Use `gen_video_cancel_job` only for a job the user asked to stop or an obviously duplicated queued job.
- Preserve human review. Technical QA cannot certify physical or narrative correctness.

Read [references/conversation-recipes.md](references/conversation-recipes.md) when translating a brief into tool calls or resuming an unfamiliar project.

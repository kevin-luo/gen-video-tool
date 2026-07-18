# Conversation recipes

## Create a default paper-collage video

1. `gen_video_get_status`
2. `gen_video_create_from_script` and retain the returned `creation_id`; expect `awaiting-assets`.
3. Split narration into beats, then use Codex Imagegen to create one flat background and 3–6 complete transparent paper groups per beat.
4. Use `$create-gen-video-asset-pack` with its default `assets/paper-template/` to write only `layered-collage` shots with staggered `assembly` cues.
5. `gen_video_inspect_collage_assets` with the `creation_id` and absolute local pack path. Fix every blocker; inspection is read-only.
6. `gen_video_attach_collage_assets` with the same IDs/path. Attachment is atomic and starts F5-TTS plus deterministic Remotion/FFmpeg production.
7. Poll `gen_video_get_creation` until `complete`, `failed`, `cancelled`, or `interrupted`. Use `gen_video_get_job` only for bounded diagnostics.
8. Return the real MP4, external SRT, and studio URL. Confirm no BGM and no burned subtitles.

Do not call generic inspect/import tools, runtime detection, or Wan candidate tools in this default route. A missing image provider or invalid collage pack remains an actionable `awaiting-assets` blocker; it never triggers a realistic-video fallback.

## Create an explicitly requested realistic video

Only enter this route when the user asks for realistic continuous motion.

1. Build the optional generated-performance pack with `$create-gen-video-asset-pack` using the retained `assets/template/`.
2. `gen_video_inspect_asset_pack` → `gen_video_import_asset_pack`.
3. `gen_video_detect_runtime` → `gen_video_get_job`.
4. For each generated shot: `gen_video_generate_shot` → poll → run the second seed → human review → select or reject.
5. `gen_video_synthesize_narration` → poll.
6. `gen_video_render_project` → poll.

## Continue an existing project

1. `gen_video_list_projects`
2. `gen_video_get_project`
3. Inspect the returned shot and narration states.
4. Continue only the first unmet gate. Do not restart completed work.

## Candidate review vocabulary

For paper collage, name the failed gate: non-empty first frame, simultaneous rather than staggered entrance, missing final hold, opaque cutout, green fringe, cropped silhouette, non-uniform scale, wrong z-order, facing/support/contact mismatch, or a layer that resumes looping after settle.

For explicitly requested realistic candidates, use specific notes: wrong facing direction, foot sliding, hand/object non-contact, duplicate limb, identity drift, background breathing, broken occlusion, camera motion owned by the model, or timing mismatch.

Avoid “效果不好” when a visible cause can be named.

## Tool safety

- Treat project IDs as opaque values returned by the MCP.
- Pass absolute source-pack paths only when the user supplied or Codex created them.
- Keep one local GPU job active at a time; queued jobs are visible in the studio.
- A completed tool call that only created a job is not a completed video operation. Poll the job.

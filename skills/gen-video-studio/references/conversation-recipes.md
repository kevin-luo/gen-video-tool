# Conversation recipes

## Create a new video

1. `gen_video_get_status`
2. `$create-gen-video-asset-pack` with Codex Imagegen
3. `gen_video_inspect_asset_pack`
4. `gen_video_import_asset_pack`
5. `gen_video_detect_runtime` → `gen_video_get_job`
6. For each generated shot: `gen_video_generate_shot` → poll → repeat for the second seed → human review → select or reject
7. `gen_video_synthesize_narration` → poll
8. `gen_video_render_project` → poll

## Continue an existing project

1. `gen_video_list_projects`
2. `gen_video_get_project`
3. Inspect the returned shot and narration states.
4. Continue only the first unmet gate. Do not restart completed work.

## Candidate review vocabulary

Use specific notes: wrong facing direction, foot sliding, hand/object non-contact, duplicate limb, identity drift, background breathing, broken occlusion, camera motion owned by the model, or timing mismatch. Avoid “效果不好” when a visible cause can be named.

## Tool safety

- Treat project IDs as opaque values returned by the MCP.
- Pass absolute source-pack paths only when the user supplied or Codex created them.
- Keep one local GPU job active at a time; queued jobs are visible in the studio.
- A completed tool call that only created a job is not a completed video operation. Poll the job.

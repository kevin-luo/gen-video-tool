---
name: compose-paper-video
description: Create, validate, preview, and render deterministic animated paper-collage video asset packs for Gen Video Tool. Use for vertical explainer, sports, story, emotion, finance, or news videos that need shot logic, complete-person animation, local Remotion rendering, narration, external SRT, no burned subtitles, and no BGM.
---

# Compose Paper Video

Produce a complete asset pack before opening the editor. Treat visual logic as a gate, not a prompt detail.

## Workflow

1. Approve narration and split it into 4–8 shots. Give every shot one visible verb and one visual change.
2. Write a reality plan for each shot: camera viewpoint, subject facing, action axis, target, support/contact, depth order, occlusion, and before/after state. Read [acceptance-gates.md](references/acceptance-gates.md).
3. Generate one no-person style frame. Stop if the user has not approved the visual language.
4. Generate every recurring identity as one complete continuous full-body figure. Reject extra, repeated, fused, detached, hidden, or cropped limbs.
5. Select the actor mode:
   - Use Rigid Actor for whole-person translation, scale, small rotation, and deterministic entrance.
   - Use Pose Cut for a large action change. Supply at least two complete people and fully hide the switch with a hard cut, paper/prop cover, flash, tear, or cut-shot.
   - Use Mesh Puppet only when a manually verified continuous texture and `rig.json` exist. Never claim automatic rig quality.
6. Generate separate no-person backgrounds, complete actor poses, props, and foreground occluders. Keep titles as structured text.
7. Author schema-v2 `manifest.json` and every `shot.json`. Add `narration.txt`, optional `audio/narration.wav`, and external `subtitles.srt`.
8. Run `npm run validate:examples` or the equivalent asset-pack inspection. Repair every error; inspect every warning.
9. Preview with the shared Remotion evaluator. Confirm per-layer parallax, z-order, actor ground contact, facing, and Pose Cut coverage.
10. Render locally. Run frame QA at shot start/middle/end and immediately before/at/after each pose switch.

## Hard rules

- Never disassemble people into visible limb sprites.
- Never crossfade two complete people.
- Never use flip, fold, constant bobbing, or meaningless rotation on a person.
- Never move the whole poster as one camera plane; titles stay locked or nearly locked.
- Never burn SRT into the image and never add BGM by default.
- Never accept a filename or prompt as proof of physical correctness; inspect pixels and sampled frames.
- For football, place the kicker behind the ball, facing the goal, with the keeper inside the goal-facing action axis.

## Repository commands

```text
npm run typecheck
npm run test
npm run validate:examples
npm run render:football
npm run render:story
npm run qa:frames
```

Deliver `final.mp4`, optional narration in the MP4, a separate `subtitles.srt`, and QA frames. Report any unsupported Mesh Puppet capability truthfully.

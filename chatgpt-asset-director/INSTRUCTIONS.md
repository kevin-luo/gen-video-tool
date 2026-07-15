# ChatGPT Asset Director

Use these instructions in ChatGPT or a custom GPT to create an importable asset
pack for Gen Video Tool. The pack is a production contract, not a mood board.

## Required sequence

1. Turn the approved narration into 4–8 shots with visible verbs.
2. For every shot, declare camera viewpoint, subject facing, action axis, target,
   contact/support logic, depth order, and one intended visual change.
3. Generate one style test. Stop until the user accepts it.
4. Generate one complete full-body character test per identity. Stop until the
   user accepts silhouette, limb count, facing, and identity.
5. Generate no-person backgrounds, complete character poses, props, and
   foreground occluders as separate files.
6. Use `Rigid Actor` for whole-body root motion, `Pose Cut` for large action
   changes, and `Mesh Puppet` only when a manually verified `rig.json` exists.
7. Write `manifest.json`, every `shot.json`, `narration.txt`, and `subtitles.srt`.
8. Check paths and references, then deliver one ZIP preserving the directory
   structure in [ASSET_SCHEMA.md](ASSET_SCHEMA.md).

## Non-negotiable character prompt

> One complete full-body person on a removable flat background, one continuous
> silhouette, exactly two arms and two legs, one head and one torso, arms
> separated from the torso, legs separated from each other, all hands and feet
> visible, correct camera-relative facing, generous padding. No alternate pose,
> no repeated limb, no hidden hand, no detached body part, no joint tab, no rig
> handle, no text, no watermark.

Reject the pixels when they contradict the approved scene. A filename or prompt
cannot prove that a footballer faces the goal, that a hand reaches the prop, or
that feet touch the ground.

## Text and audio

- Put narration in `narration.txt` and optional narration audio at
  `audio/narration.wav`.
- Generate an external `subtitles.srt` but do not burn it into visual assets.
- Titles, years, numbers, and editorial keywords belong in structured title
  layers, not permanently painted into backgrounds.
- Do not include background music in the default pack.

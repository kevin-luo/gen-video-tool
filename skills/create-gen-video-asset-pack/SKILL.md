---
name: create-gen-video-asset-pack
description: Create a validated, downloadable Gen Video Tool v3 production ZIP for offline desktop generation. Use when Codex must turn a short script into the default assemble-from-empty paper-collage workflow with complete transparent character PNGs and deterministic Remotion assembly, or explicitly prepare the optional local WanGP realistic-video workflow. Packages F5-TTS narration, external SRT, source images, motion intent, and offline delivery contracts without external runtime calls.
---

# Create Gen Video Asset Pack

Create production intent and source media for the greenfield v3 desktop tool.
Default to deterministic paper collage. Use generated-performance/Wan only when
the user explicitly requests realistic continuous motion. Stop at a validated
ZIP. Never claim that the web session ran the user's local WanGP, F5-TTS,
matting, Remotion, RIFE, or FFmpeg runtimes.

## Read before authoring

- Read `references/production-contract.md` for the exact v3-only contract.
- Read `references/direction-and-physics.md` for direction, support, contact,
  framing, and occlusion rules.
- Read `references/copywriting.md` before writing Chinese narration.

## Workflow

### 1. Pass the voice intake gate

Require both of these user-provided inputs before building the pack:

1. a clean F5 reference WAV containing one speaker and no music;
2. the exact verbatim transcript of that WAV.

Copy the WAV into `assets/voices/narrator.wav` and copy the transcript exactly
into `narration.referenceText`. Do not transcribe by guessing, silently replace
the voice, synthesize a reference voice, or use an unrelated transcript. If
either input is absent, stop and request it; visual planning may be discussed,
but do not present an importable ZIP.

### 2. Select the visual mode and lock delivery

Use one immutable `production.json`; do not create `manifest.json`, per-shot
v2 JSON, or a compatibility fallback. Default and validate:

- required human-readable `metadata.title` and portable BCP-47 locale;
- exact delivery: 1080×1920, square pixels, 30 fps;
- H.264/yuv420p video, local WAV narration muxed as AAC/48 kHz, external UTF-8 SRT;
- no burned subtitles and no BGM;
- local-only execution after import;
- default paper mode uses only `layered-collage` shots, with no local-I2V
  capability;
- optional realistic mode uses two distinct candidate seeds per
  `generated-performance` shot, WanGP native 480×832 at 24 fps/81 frames, and
  `cover` conformance with an intentional normalized `focalPoint`.

For explicitly selected realistic mode, use `start-only` conditioning by
default. The known local `fun_inp_1.3B` runtime does not advertise end-keyframe
conditioning. Use `start-end` only when the selected local preset explicitly
supports it, and then add `local-i2v-start-end` to `requiredCapabilities`.

### 3. Write speech before pictures

Write for the mouth, not an article. Open on a visible friction, turn once, and
land on a consequence the viewer can picture. Cut throat-clearing, parallel
slogans, vague praise, fake quotations, and generic engagement requests.

Split narration into semantic segments. Record absolute estimated timing in
`narration.segments.json`; the desktop later replaces it with measured F5-TTS
timing. Generate `subtitles.srt` only as an external draft.

### 4. Direct paper assembly or realistic action

For default paper mode, make every shot `layered-collage` and follow this exact
grammar:

- one static flat paper-field background;
- 3–6 non-background groups, each a transparent PNG with crisp cut edges;
- one complete uninterrupted PNG per person or animal; never split limbs;
- every non-background group declares one shot-local `assembly` cue;
- stagger at least three distinct starts, assemble structure before subject,
  action/result, foreground, and accent, then hold the completed composition;
- use only rigid affine motion: `slide-left`, `slide-right`, `slide-up`, `drop`,
  `rise`, `snap`, `slap`, `stamp`, or `pop`;
- keep `scaleX` and `scaleY` equal, preserve explicit z-order and foreground
  occlusion, and do not add looping drift after settle.

When one placed actor or prop needs a short emphasis, add at most one optional
`assembly.followThrough`. Animate the complete PNG as one rigid card at exactly
2, 3, or 4 placements per second. Use `bob`, `sway`, `gesture-left`,
`gesture-right`, `exit-left`, or `exit-right`; non-exit actions must return to
the authored pose, while exits hold invisibly offstage. Leave at least six
delivery frames of exact stillness after the finite action. Never express
breathing, a character idle, or perpetual drift with `followThrough` or a
looping `motionPreset`.

Read the layered-collage contract in `references/production-contract.md` before
writing the plan. Make facing, support, prop ownership, and handoff direction
visually correct in the complete cutouts before animation.

For explicitly selected realistic mode, define structured world logic for every
`generated-performance` shot:

- the actor, target, support surface, and non-zero screen-space action axis;
- an explicit `generatedObjectIds` inventory for generated scene objects that
  participate in contact but are not the primary target;
- ordered shot-local delivery-frame milestones;
- at least one structured facing constraint and one support constraint;
- one structured, trigger-matched contact constraint for every deterministic
  causal prop, plus generated-world contact constraints for grasped or touched
  scene objects;
- a readable full-body action, generated camera locked, and one editorial move.

Make the causal order physically testable. For a kick: face the target, plant a
support foot, contact the ball with the kicking foot, then release the ball and
follow through. Never rely on prose alone when a facing, support, or contact
relationship can be encoded as a constraint.

### 5. Generate source assets

In default paper mode, use Imagegen to create a flat background and 3–6 large,
separable paper groups per shot. Prefer a strong color field, halftone or
printed-paper texture, warm cream keylines, restrained alpha-following shadows,
and clear negative space. Export every non-background group as a trimmed RGBA
PNG with four transparent corners. Inspect complete silhouettes, facing,
support, contact, crop boundaries, and foreground/background ownership.

When the approved source is already a complete PNG but still carries a glossy
or overly colorful treatment, run `scripts/stylize-paper-cutout.ts` once before
packaging. It changes RGB into a deterministic two-ink halftone while copying
the source alpha, dimensions, and silhouette byte-for-byte; it must never be
used to repair a cropped or anatomically incomplete character.

Do not ask a video model to interpolate the assembled poster. Remotion owns the
paper movement, so pixels cannot morph, duplicate limbs, or change identity.

For explicitly selected realistic mode, use Imagegen for whole conditioning
images and complete figures, then apply the following generated-performance
rules.

Use Imagegen for whole images and complete figures. Keep the entire body, hands,
feet, support surface, clothing, identity, lighting, and visual treatment stable.
For `start-only`, make the start keyframe clearly show the pose and available
motion envelope. For supported `start-end`, make both frames distinct but
identity- and camera-consistent.

Exclude every deterministic causal prop from the generated plate. Supply each
prop as a separate transparent PNG, give it an explicit delivery-pixel
`renderSize`, and animate it from the contact/release milestone.

Choose occlusion deliberately:

- use `{mode: "none", requirement: "none"}` only when no depth crossing needs
  a subject matte;
- use `local-matte` when a subject must be composited through foreground depth;
- mark it `required` when the shot would be visually wrong without the matte.

When `local-matte` has a foreground plate, include its transparent PNG. The ZIP
must not contain generated matte output; it only declares the future generated
output directory. A required matte is a desktop selection gate.

### 6. Build and validate from any working directory

Copy `assets/paper-template/` to a clean pack directory by default. Only when the
user explicitly chooses realistic Wan video, copy the retained
`assets/template/` instead. Fill every placeholder, add the referenced media,
and delete unused placeholder files. Keep JSON paths POSIX relative even on
Windows. Never place mutable output under `generated/` in the source pack.

Resolve the absolute directory containing this loaded `SKILL.md` as
`SKILL_ROOT`. Do not assume the shell's current directory is the skill folder.
Use absolute paths for `PACK_ROOT` and `OUTPUT_ZIP`.

POSIX shell:

```bash
SKILL_ROOT="/absolute/path/to/create-gen-video-asset-pack"
PACK_ROOT="/absolute/path/to/asset-pack"
OUTPUT_ZIP="/absolute/path/to/asset-pack.zip"
python "$SKILL_ROOT/scripts/generate_srt.py" "$PACK_ROOT/narration.segments.json" "$PACK_ROOT/subtitles.srt"
python "$SKILL_ROOT/scripts/validate_asset_pack.py" "$PACK_ROOT"
python "$SKILL_ROOT/scripts/assemble_asset_pack.py" "$PACK_ROOT" "$OUTPUT_ZIP"
python "$SKILL_ROOT/scripts/validate_asset_pack.py" "$OUTPUT_ZIP"
```

PowerShell:

```powershell
$SkillRoot = (Resolve-Path 'C:\absolute\path\to\create-gen-video-asset-pack').Path
$PackRoot = (Resolve-Path 'C:\absolute\path\to\asset-pack').Path
$OutputZip = 'C:\absolute\path\to\asset-pack.zip'
python (Join-Path $SkillRoot 'scripts\generate_srt.py') (Join-Path $PackRoot 'narration.segments.json') (Join-Path $PackRoot 'subtitles.srt')
python (Join-Path $SkillRoot 'scripts\validate_asset_pack.py') $PackRoot
python (Join-Path $SkillRoot 'scripts\assemble_asset_pack.py') $PackRoot $OutputZip
python (Join-Path $SkillRoot 'scripts\validate_asset_pack.py') $OutputZip
```

Fix every error before returning the ZIP.

### 7. Hand off accurately

Return the ZIP, a short creative summary, and any disclosed warnings. Give the
actual default paper sequence:

1. inspect the ZIP against the existing `awaiting-assets` creation;
2. attach it atomically and open the project;
3. verify the bundled reference voice, then run local F5-TTS;
4. render the deterministic paper assembly with Remotion;
5. inspect empty start, staggered group placements, final settle, alpha edges,
   facing, support, contact and occlusion;
6. export the MP4 and sidecar SRT.

For explicitly selected realistic mode, retain the candidate workflow: detect
WanGP, generate both immutable candidates, inspect motion/world constraints and
optional matte output, accept one candidate, then render/export.

In optional realistic mode, generic project import does not automatically start
candidate generation. A `required` matte must finish before the desktop may
accept that shot as final.

## Hard gates

- `production.json` is the only project entry contract and is schema v3.
- No sentinel placeholder remains in JSON, narration, SRT, or referenced paths.
- The exact user-provided F5 WAV and transcript are present.
- Source PNGs have valid chunks, CRCs, compressed image data, and terminal IEND.
- In optional realistic mode, delivery and generation geometry/timebases remain
  separate and conform by duration, `cover`, and focal point; milestones,
  constraints, candidate seeds, deterministic prop ownership and camera
  ownership remain valid.
- In optional realistic mode, every generated-world contact names `targetId` or
  an entry in `generatedObjectIds`; required foreground assets exist and future
  matte outputs are not bundled.
- SRT cues are sequential, non-overlapping, timed, and text-identical to the
  narration segment sidecar.
- No absolute path, URL, token, generated candidate, mutable state, or final
  render is bundled as source material.
- Default paper shots have one static background plus 3–6 transparent rigid
  groups; every group has a valid staggered `assembly` cue, any optional
  `followThrough` is one finite 2-4 fps whole-card action, and the final pose is
  held for at least six delivery frames.
- Paper characters remain complete cutouts, use uniform authored scale, and
  never combine assembly with a looping `motionPreset` or permanent idle.

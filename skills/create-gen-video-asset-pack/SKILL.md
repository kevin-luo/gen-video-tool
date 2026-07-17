---
name: create-gen-video-asset-pack
description: Create a validated, downloadable Gen Video Tool v3 production ZIP for offline desktop generation. Use when ChatGPT must plan a short vertical video, write natural spoken Chinese, generate style-flexible full-scene keyframes and deterministic overlay assets, encode camera/world/physics/occlusion intent, and package assets for later local WanGP, F5-TTS, Remotion, FFmpeg, and optional matting execution without external APIs.
---

# Create Gen Video Asset Pack

Create production intent and source media for the greenfield v3 desktop tool.
Stop at a validated ZIP. Never claim that the web session ran the user's local
WanGP, F5-TTS, matting, Remotion, RIFE, or FFmpeg runtimes.

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

### 2. Lock the delivery contract

Use one immutable `production.json`; do not create `manifest.json`, per-shot
v2 JSON, or a compatibility fallback. Default and validate:

- required human-readable `metadata.title` and portable BCP-47 locale;
- exact delivery: 1080×1920, square pixels, 30 fps;
- H.264/yuv420p video, local WAV narration muxed as AAC/48 kHz, external UTF-8 SRT;
- no burned subtitles and no BGM;
- local-only execution after import;
- two distinct candidate seeds per generated-performance shot;
- WanGP native generation: 480×832, 24 fps, 81 frames;
- `cover` conformance with an intentional normalized `focalPoint`.

Use `start-only` conditioning by default. The known local `fun_inp_1.3B`
runtime does not advertise end-keyframe conditioning. Use `start-end` only when
the selected local preset explicitly supports it, and then add
`local-i2v-start-end` to `requiredCapabilities`.

### 3. Write speech before pictures

Write for the mouth, not an article. Open on a visible friction, turn once, and
land on a consequence the viewer can picture. Cut throat-clearing, parallel
slogans, vague praise, fake quotations, and generic engagement requests.

Split narration into semantic segments. Record absolute estimated timing in
`narration.segments.json`; the desktop later replaces it with measured F5-TTS
timing. Generate `subtitles.srt` only as an external draft.

### 4. Direct actions with structured world logic

For every generated-performance shot, define:

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

Copy `assets/template/` to a clean pack directory. Fill every placeholder, add
the referenced media, and delete unused placeholder files. Keep JSON paths POSIX
relative even on Windows. Never place mutable output under `generated/` in the
source pack.

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
actual desktop sequence:

1. import the ZIP and open the project;
2. open **Local Production**;
3. verify the bundled reference voice, then run local F5-TTS;
4. detect the local WanGP provider and generate both candidates;
5. inspect motion, world constraints, contact frames, and optional matte output;
6. accept one candidate only after technical and human review;
7. render/export the MP4 and sidecar SRT.

Import does not automatically start generation. A `required` matte must finish
before the desktop may accept that shot as final.

## Hard gates

- `production.json` is the only project entry contract and is schema v3.
- No sentinel placeholder remains in JSON, narration, SRT, or referenced paths.
- The exact user-provided F5 WAV and transcript are present.
- Source PNGs have valid chunks, CRCs, compressed image data, and terminal IEND.
- Delivery and generation geometry/timebases remain separate and conform by
  duration, `cover`, and focal point.
- IDs, output paths, milestones, constraints, and candidate seeds are valid.
- Every causal prop has one deterministic owner and structured contact.
- Every generated-world contact names `targetId` or an entry in
  `generatedObjectIds`; target ownership is never inferred from prose.
- Generated camera is locked; editorial camera has one owner.
- Required foreground assets exist; future matte outputs are not bundled.
- SRT cues are sequential, non-overlapping, timed, and text-identical to the
  narration segment sidecar.
- No absolute path, URL, token, generated candidate, mutable state, or final
  render is bundled as source material.

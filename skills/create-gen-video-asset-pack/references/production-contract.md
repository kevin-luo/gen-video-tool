# Gen Video Tool v3 production asset contract

## Contents

1. [Source tree](#source-tree)
2. [Default paper-collage contract](#default-paper-collage-contract)
3. [Optional realistic example](#optional-realistic-example)
4. [Delivery and generation clocks](#delivery-and-generation-clocks)
5. [Conditioning modes](#conditioning-modes)
6. [World constraints](#world-constraints)
7. [Occlusion](#occlusion)
8. [Cross-file rules](#cross-file-rules)

`production.json` is the only immutable project entry contract. The v3 source
pack has no v2 manifest and no per-shot compatibility JSON. The desktop owns
mutable state and creates it only after import.

## Source tree

```text
production.json
narration.txt
narration.segments.json
subtitles.srt
assets/
  voices/narrator.wav
  shots/<shot-id>/background.png            # default paper mode
  shots/<shot-id>/<paper-group>.png          # default paper mode, transparent
  shots/<shot-id>/performance-start.png      # optional realistic mode
  shots/<shot-id>/performance-end.png        # optional supported start-end mode
  shots/<shot-id>/<deterministic-prop>.png   # optional realistic mode
  shots/<shot-id>/foreground-occluder.png    # optional realistic mode
```

Never include `generated/` in a source ZIP. The desktop may later create:

```text
generated/production-state.json
generated/video/<shot-id>/<candidate-id>.mp4
generated/mattes/<shot-id>/...
generated/audio/<segment-id>.wav
generated/audio/narration.wav
generated/final/video.mp4
generated/final/video.srt
```

All JSON paths use POSIX separators and are relative to the project root. Reject
drive letters, a root slash, backslashes, URLs, colon separators, dot segments,
empty segments, Windows device names, and segments ending in a dot or space.

## Default paper-collage contract

Use only `layered-collage` shots unless the user explicitly requests realistic
continuous motion. A paper shot starts with exactly one static background and
assembles 3–6 transparent non-background groups. Every non-background group has
one `assembly` object and remains rigid: Remotion may translate, rotate, scale
uniformly, or change visibility, but it never regenerates or warps the pixels.

```json
{
  "shotId": "shot-01",
  "kind": "layered-collage",
  "deliveryTimeline": {"startFrame": 0, "durationFrames": 150},
  "layers": [
    {
      "id": "paper-field",
      "assetPath": "assets/shots/shot-01/background.png",
      "role": "background",
      "zIndex": 0,
      "transform": {
        "x": 0,
        "y": 0,
        "scaleX": 1,
        "scaleY": 1,
        "rotationDegrees": 0,
        "opacity": 1
      },
      "motionPreset": "locked"
    },
    {
      "id": "whole-actor",
      "assetPath": "assets/shots/shot-01/actor-complete.png",
      "role": "actor",
      "zIndex": 310,
      "transform": {
        "x": 470,
        "y": 1240,
        "scaleX": 1,
        "scaleY": 1,
        "rotationDegrees": 0,
        "opacity": 1
      },
      "assembly": {
        "kind": "rise",
        "startFrame": 36,
        "durationFrames": 30,
        "distance": 680,
        "rotationDegrees": -4,
        "steps": 10,
        "followThrough": {
          "kind": "gesture-right",
          "delayFrames": 12,
          "durationFrames": 30,
          "distance": 32,
          "rotationDegrees": 3,
          "cadenceFps": 3
        }
      }
    }
  ],
  "editorialCamera": {
    "owner": "editorial-camera",
    "operation": "locked",
    "strength": 0
  }
}
```

The example above abbreviates the remaining groups. A complete shot must have
3–6 non-background groups and at least three distinct `startFrame` values. Use
one of these assembly kinds:

- `slide-left`, `slide-right`, `slide-up`, `drop`, `rise`;
- `snap`, `slap`, `stamp`, `pop`.

Assembly fields are strict: `startFrame` is a non-negative shot-local delivery
frame; `durationFrames` is 1..3600; `distance` is 0..4000 delivery pixels;
`rotationDegrees` is -45..45; and `steps` is 2..24. Assembly must finish inside
the shot and leave at least six frames for the completed hold. Backgrounds may
not assemble. A layer with assembly may omit `motionPreset` or set it to
`locked`, but may not use a looping preset.

`followThrough` is optional and strict. It describes one finite whole-PNG
action after assembly settles, never a loop or body-part puppet. Its fields are:

- `kind`: `bob`, `sway`, `gesture-left`, `gesture-right`, `exit-left`, or
  `exit-right`;
- `delayFrames`: integer 0..3600 after assembly settle;
- `durationFrames`: integer 8..3600;
- `distance`: 0..4000 delivery pixels, capped at 120 for non-exit actions;
- `rotationDegrees`: -15..15, capped to an absolute 8 degrees for non-exits;
- `cadenceFps`: exactly 2, 3, or 4 discrete placements per second.

Bob, sway, and gesture return exactly to the authored transform. Exit holds the
complete card invisibly at its final offstage transform. In both cases the
action must finish with at least six exact still frames left in the shot. Do
not encode breathing, ambient sway, repeated bobbing, slow drift, or any other
permanent idle. Use the cue only for a short narrative emphasis or deliberate
exit; omit it when assembly already carries the beat.

Keep `scaleX` equal to `scaleY` for every paper group. Actor and animal assets
must be complete uninterrupted RGBA cutouts. Environment, actor, prop,
foreground and overlay groups all require transparent PNGs so the empty field,
z-order and occlusion remain observable.

The default paper template is `assets/paper-template/`. It requires only
`local-f5-tts`, `remotion-render`, `ffmpeg`, and `sidecar-srt` capabilities.

## Optional realistic example

This one-shot example uses the locally available start-only WanGP path. Every
milestone and deterministic coordinate is expressed in the 1080×1920, 30 fps
delivery timeline; the conditioning image remains native 480×832.

```json
{
  "schemaVersion": 3,
  "projectId": "football-direction-demo",
  "metadata": {
    "title": "一脚球为什么不能先飞",
    "locale": "zh-CN"
  },
  "networkPolicy": "offline-only",
  "requiredCapabilities": [
    "local-f5-tts",
    "local-i2v",
    "deterministic-ballistics",
    "remotion-render",
    "ffmpeg",
    "sidecar-srt"
  ],
  "delivery": {
    "raster": {
      "width": 1080,
      "height": 1920,
      "pixelAspectRatio": 1
    },
    "timeline": {
      "fps": 30,
      "durationFrames": 101
    },
    "video": {
      "path": "generated/final/video.mp4",
      "codec": "h264",
      "pixelFormat": "yuv420p"
    },
    "audio": {
      "path": "generated/audio/narration.wav",
      "sourceFormat": "wav",
      "muxCodec": "aac",
      "muxSampleRate": 48000
    },
    "subtitles": {
      "path": "generated/final/video.srt",
      "format": "srt",
      "burnIn": false
    },
    "bgm": null
  },
  "narration": {
    "engine": "f5-tts-local",
    "language": "zh-CN",
    "referenceAudioPath": "assets/voices/narrator.wav",
    "referenceText": "球不是先飞，人要先把支撑脚钉在地上。",
    "speed": 1,
    "segments": [
      {
        "segmentId": "voice-shot-01",
        "shotId": "shot-01",
        "text": "支撑脚落稳，右脚才顺着球门方向抽出去。球碰脚之前，一毫米都不该先跑。",
        "outputPath": "generated/audio/voice-shot-01.wav"
      }
    ],
    "mergedAudioPath": "generated/audio/narration.wav"
  },
  "shots": [
    {
      "shotId": "shot-01",
      "kind": "generated-performance",
      "deliveryTimeline": {
        "startFrame": 0,
        "durationFrames": 101
      },
      "generation": {
        "engine": "wangp-local-i2v",
        "conditioning": {
          "mode": "start-only",
          "startKeyframePath": "assets/shots/shot-01/performance-start.png"
        },
        "preset": {
          "id": "portrait-i2v-quality",
          "quality": "quality",
          "conditioning": "start-only",
          "motionStrength": 0.78
        },
        "raster": {
          "width": 480,
          "height": 832
        },
        "timeline": {
          "fps": 24,
          "frameCount": 81
        },
        "conformToDelivery": {
          "spatialFit": "cover",
          "focalPoint": {"x": 0.5, "y": 0.52},
          "temporalFit": "preserve-duration"
        },
        "candidateSeeds": [42, 314159]
      },
      "hybridMotion": {
        "actor": {
          "id": "kicker",
          "supportingActorIds": ["goalkeeper"],
          "action": "one right-foot strike with a planted left foot and balanced follow-through",
          "prompt": "Locked camera. The kicker faces the goal, plants the left foot beside the contact point, swings the right leg once, and finishes balanced toward the goalkeeper.",
          "negativePrompt": "ball, camera motion, reversed direction, sliding support foot, duplicate limbs, missing hands, morphing, teleporting",
          "generatedCamera": "locked",
          "excludedCausalPropIds": ["ball"]
        },
        "world": {
          "subjectId": "kicker",
          "targetId": "goal",
          "generatedObjectIds": [],
          "supportSurfaceId": "pitch",
          "actionAxis": {
            "from": {"x": 0.48, "y": 0.82},
            "to": {"x": 0.51, "y": 0.2}
          },
          "milestones": [
            {"id": "setup", "kind": "setup", "frame": 0},
            {"id": "plant", "kind": "plant", "frame": 30},
            {"id": "contact", "kind": "contact", "frame": 48},
            {"id": "follow", "kind": "follow-through", "frame": 68},
            {"id": "end", "kind": "end", "frame": 100}
          ],
          "constraints": {
            "facing": [
              {
                "id": "face-goal",
                "actorId": "kicker",
                "towardTargetId": "goal",
                "bodyAxis": "torso",
                "fromMilestoneId": "setup",
                "throughMilestoneId": "contact",
                "maxDeviationDegrees": 25
              }
            ],
            "support": [
              {
                "id": "left-foot-plant",
                "actorId": "kicker",
                "bodyPart": "left-foot",
                "surfaceId": "pitch",
                "mode": "planted",
                "fromMilestoneId": "plant",
                "throughMilestoneId": "contact",
                "maxSlipPixels": 12
              }
            ],
            "contact": [
              {
                "id": "right-foot-ball-contact",
                "actorId": "kicker",
                "bodyPart": "right-foot",
                "target": {
                  "owner": "deterministic-interaction",
                  "propId": "ball"
                },
                "milestoneId": "contact",
                "kind": "strike",
                "toleranceFrames": 1
              }
            ]
          }
        },
        "deterministicProps": [
          {
            "propId": "ball",
            "assetPath": "assets/shots/shot-01/ball.png",
            "renderSize": {"width": 96, "height": 96},
            "trigger": {"milestoneId": "contact", "kind": "contact"},
            "transform": {
              "x": 522,
              "y": 1538,
              "scaleX": 1,
              "scaleY": 1,
              "rotationDegrees": 0
            },
            "motion": {
              "kind": "ballistic",
              "contactFrame": 48,
              "flightFrames": 52,
              "targetX": 540,
              "targetY": 360,
              "targetScale": 0.18,
              "curveX": 42,
              "spinDegrees": 540
            }
          }
        ],
        "editorialCamera": {
          "owner": "editorial-camera",
          "operation": "push",
          "strength": 0.14
        }
      },
      "occlusion": {
        "mode": "none",
        "requirement": "none"
      }
    }
  ]
}
```

## Delivery and generation clocks

- Delivery raster is always 1080×1920 with pixel aspect ratio 1.
- Delivery time is always 30 fps. Shot `deliveryTimeline` ranges are contiguous,
  start at zero, and exactly fill `delivery.timeline.durationFrames`.
- The current local WanGP pack profile is 480×832, 24 fps, 81 frames.
- Keep native generation raster and timebase under `generation`; never pretend
  that 480×832 is exact 9:16 delivery.
- Use `spatialFit: "cover"` and set a focal point that protects the face, hands,
  feet, and contact region from the delivery crop.
- Use `temporalFit: "preserve-duration"`. Generation and delivery durations may
  differ by at most one source frame.
- Express world milestones, prop sizes, transforms, and trajectories in the
  delivery coordinate system, not WanGP pixels.

## Conditioning modes

Use one discriminated form:

```json
{"mode": "start-only", "startKeyframePath": "assets/shots/s1/start.png"}
```

or, only for a provider that explicitly advertises start/end conditioning:

```json
{
  "mode": "start-end",
  "startKeyframePath": "assets/shots/s1/start.png",
  "endKeyframePath": "assets/shots/s1/end.png"
}
```

All conditioning PNGs must be real 480×832 images. Start/end assets must be
different files. A start-end project requires both `local-i2v` and
`local-i2v-start-end`; a start-only project requires `local-i2v` only.
`generation.preset.conditioning` must equal `generation.conditioning.mode` so a
pack cannot request an input mode the selected local preset does not advertise.

## World constraints

Use IDs rather than prose to make direction and causality machine-checkable:

- `facing` binds an actor/body axis toward the declared world target over a
  milestone interval;
- `support` binds a body part to the declared support surface over an interval;
- `contact.target` is a strict owner union: use
  `{owner: "deterministic-interaction", propId}` for an extracted causal prop,
  or `{owner: "generated-world", objectId}` for an object that remains inside
  the generated plate;
- a generated-world `objectId` must equal `world.targetId` or appear exactly
  once in `world.generatedObjectIds`.

Constraint actors must appear in the generated performance. Intervals run
forward in time. Every deterministic prop requires exactly one contact
constraint owned by `deterministic-interaction`; its milestone must equal the
prop trigger, and the trigger kind/frame must match the milestone and ballistic
`contactFrame`. Generated-world contact may have multiple constraints, such as
left and right hands grasping two explicitly declared curtain panels.

For example, retain curtain fabric in the generated plate but declare each
physical contact target explicitly:

```json
{
  "targetId": "window",
  "generatedObjectIds": ["left-curtain", "right-curtain"],
  "constraints": {
    "contact": [
      {
        "id": "left-hand-grasp",
        "actorId": "woman",
        "bodyPart": "left-hand",
        "target": {"owner": "generated-world", "objectId": "left-curtain"},
        "milestoneId": "grasp-curtains",
        "kind": "grasp",
        "toleranceFrames": 1
      }
    ]
  }
}
```

## Occlusion

Use the strict no-matte form when no generated subject matte is needed:

```json
{"mode": "none", "requirement": "none"}
```

Use this form when the selected performance needs a local alpha matte:

```json
{
  "mode": "local-matte",
  "requirement": "required",
  "subjectId": "kicker",
  "engine": "local-video-matting",
  "outputDirectory": "generated/mattes/shot-01",
  "outputFormat": "webm-alpha",
  "foregroundAssetPath": "assets/shots/shot-01/foreground-occluder.png",
  "featherPixels": 2
}
```

`foregroundAssetPath` is optional, but when present it must be a valid
transparent source PNG. `outputDirectory` is a future desktop-owned location;
do not bundle it. A local-matte plan requires `local-video-matting`. When
`requirement` is `required`, desktop state must prove matte completion before a
candidate can be accepted or exported.

## Cross-file rules

- Root files are `production.json`, `narration.txt`,
  `narration.segments.json`, and `subtitles.srt`.
- Source files never exist under `generated/`.
- The bundled WAV is valid PCM speech, and `referenceText` is its exact user-
  supplied transcript rather than an inferred caption.
- Narration segment IDs, shot IDs, and text match the sidecar JSON in order.
- `narration.txt` is the whitespace-normalized concatenation of segment text.
- SRT has exactly one ordered, non-overlapping cue per narration segment, with
  identical text and draft timing from the sidecar JSON.
- `narration.mergedAudioPath` equals `delivery.audio.path`.
- Video, audio, and SRT output paths are distinct.
- Referenced source assets exist; future `generated/` output paths do not.
- PNG validation checks signature, complete chunk structure, CRCs, IDAT zlib
  data, decoded scanline size/filter bytes, and terminal IEND.
- IDs are unique in their own namespaces. Reusing one source asset path in
  multiple layers is allowed; mutable output paths remain unique.
- No placeholder sentinel, URL, secret, host-absolute path, generated candidate,
  mutable state, or final render appears in the source ZIP.

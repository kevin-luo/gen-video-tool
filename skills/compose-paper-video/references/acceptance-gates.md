# Acceptance gates

## Shot logic card

Complete this before generating pixels:

```text
Shot ID:
Narration beat:
Visible verb:
Camera position and lens intent:
Subject facing:
Action axis and screen direction:
Target/contact point:
Support and ground plane:
Background → subject → prop → foreground order:
Occluder used for pose change:
Start state → end state:
```

Reject a shot when the action axis misses its target, feet float or penetrate the ground, a held prop misses the hand, a ball is behind the kick direction, or foreground cover does not fully hide a Pose Cut.

## Asset-pack minimum

```text
manifest.json
narration.txt
subtitles.srt
audio/narration.wav        # optional
assets/backgrounds/*
assets/characters/*
assets/props/*
shots/<shot-id>/shot.json
```

Use forward-slash relative paths. Keep IDs unique. Do not include unreferenced production assets.

## Motion acceptance

- Entrance motion settles once; it does not loop by default.
- Impact shake lasts 6–12 frames.
- Quiet motion stays below the perception threshold of a puppeteered limb unless a verified mesh rig drives it.
- Pose Cut shows exactly one complete figure at every frame.
- At least three depth bands move at distinct parallax rates when the camera moves.
- Titles remain readable inside the safe area and are not used as subtitles.

## QA sampling

Extract start, middle, and end frames for every shot. For each pose change, also extract one frame before, the switch frame, and one frame after. Reject black frames, empty compositions, duplicate bodies, phantom limbs, broken alpha, incorrect facing, and implausible contact.

# Asset pack schema

```text
project/
├─ manifest.json
├─ narration.txt
├─ subtitles.srt
├─ style-reference.png
├─ audio/
│  └─ narration.wav
├─ characters/
│  └─ <character-id>/
│     ├─ character.png
│     ├─ pose-02.png
│     └─ rig.json          # Mesh Puppet only
└─ shots/
   └─ shot-01/
      ├─ background.png
      ├─ subject.png
      ├─ prop-ball.png
      ├─ foreground.png
      └─ shot.json
```

The current `schemaVersion` is `2`. All paths are project-relative POSIX paths.
Absolute paths, drive letters, `..`, backslash escapes, links outside the pack,
duplicate normalized paths, and referenced files that do not exist are rejected.

Actor modes:

- `rigid`: exactly one complete person texture; root transform only.
- `mesh-puppet`: one continuous texture plus a verified `rig.json`; no detached
  limbs or visible connectors.
- `pose-cut`: at least two complete-person poses. Only hard cut, full foreground
  cover, flash, or tear reveal may switch the pose. Crossfade, fold, and flip are
  invalid.

The machine-readable source of truth is the Zod schema in
`packages/schema/src/`.

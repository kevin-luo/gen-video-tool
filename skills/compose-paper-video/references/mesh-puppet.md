# Mesh Puppet local workflow

Use this path only for one complete, continuous character PNG. The visible result must remain one silhouette at every frame; do not supply detached limb sprites.

## Asset contract

1. `sourcePath` points to a transparent complete-person PNG.
2. `rigPath` points to validated `rig.json`.
3. `rig.texturePath` must exactly match `sourcePath`.
4. `rig.canvas` equals the PNG pixel dimensions.
5. Mesh weights contain one normalized influence list per vertex.
6. Action start and duration stay within the shot duration.

## First binding

Open the shot's character inspector and choose **打开绑定与透明预览**. If no trustworthy rig exists, choose **自动绑定**. The auto-rig result is a starting hypothesis based on the Alpha silhouette, not proof of anatomy.

Correct at least these joints before saving:

- root at the pelvis/center of support;
- spine along the torso centerline;
- head pivot at the neck;
- shoulder–elbow–hand chains on the visible arms;
- hip–knee–ankle chains on the visible legs.

Drag a bone endpoint, or focus it and use arrow keys. `Shift + Arrow` moves 5 pixels. Preview uses the current unsaved rig; saving is a separate action.

## Transparent preview gate

Render the intended action at the intended amplitude. Inspect:

- frame 0: original silhouette is complete and grounded;
- first active frame: no jump before the declared action start;
- peak frame: no mesh gap, doubled limb, broken joint, texture tear, or inverted triangle;
- recovery/end: no unexpected drift from the support point;
- Alpha edge: no black rectangle or opaque background.

If the action changes the character's location or contact state substantially, use Pose Cut with complete figures or generate a new complete pose. Mesh Puppet is for bounded deformation, not arbitrary full-body re-synthesis.

## Deterministic export

The render service invokes Godot before Remotion and requests a transparent PNG sequence for every Mesh actor. Remotion consumes exactly one numbered PNG for each shot frame. Missing Godot, invalid rig, incomplete frame count, or missing Alpha blocks export.

Developer checks:

```text
npm run render:mesh-preview
npm run render:mesh-webm
npx tsx scripts/render-mesh-preview.ts celebrate alpha-mov
```

Expected formats:

- PNG sequence: RGBA frames;
- WebM: VP9 with `alpha_mode=1`;
- MOV: ProRes 4444 with a `yuva` pixel format.

## Physical and story logic

Mesh deformation does not override real-world logic. Before asset generation, declare the subject's facing, action axis, target, support, contact point, cause frame, effect frame, depth, and occluders. For football, keep the ball stationary until foot contact and delay goalkeeper commitment until after ball release unless the script explicitly shows an early guess.

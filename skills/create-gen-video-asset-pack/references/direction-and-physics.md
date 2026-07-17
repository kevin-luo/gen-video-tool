# Direction, motion, and world logic

## Contents

1. [Ownership](#ownership)
2. [Stage before prompting](#stage-before-prompting)
3. [Structured constraints](#structured-constraints)
4. [Milestones and causal props](#milestones-and-causal-props)
5. [Conditioning and crop](#conditioning-and-crop)
6. [Occlusion](#occlusion)
7. [Review gates](#review-gates)

## Ownership

Give each visible responsibility one owner:

1. **Generated performance** owns continuous body deformation, balance,
   clothing/hair follow-through, facial continuity, and the complete action.
2. **Deterministic interaction** owns causal props, contact timing,
   trajectories, debris, labels, and other exact-frame events.
3. **Editorial camera** owns the final push, pull, or pan. Keep the generated
   camera locked so two camera moves never compete.
4. **Local matte** owns subject alpha only when the depth stack requires it.

Use layered collage for typography, diagrams, maps, products, and frame-exact
paper pieces. Use generated performance only when continuous whole-body or
whole-animal motion adds real value.

## Stage before prompting

Block the action in normalized screen coordinates:

- `actionAxis.from` marks the subject's starting action centre;
- `actionAxis.to` points toward the target or intended travel direction;
- `supportSurfaceId` names the ground, chair, table, wall, or support;
- reserve clearance for hands, feet, prop travel, and follow-through;
- select `focalPoint` so the 480×832 source survives the 1080×1920 cover crop.

Ask whether the action could work in the real world. A player kicking at a
goalkeeper must face the goal, plant beside the ball, swing toward it, contact
before ball travel, and finish with momentum toward the target. A seated person
must remain supported. A hand cannot pass through a table. An object cannot
move before the force or release that caused it.

## Structured constraints

Encode the important relationships rather than hiding them in prompt prose.

### Facing

Use at least one facing constraint for each generated shot. Bind a generated
actor and body axis (`head`, `torso`, `hips`, or `travel`) toward the declared
world target over a milestone interval. Choose a visible maximum deviation.

### Support

Use at least one support constraint. Bind a named body part to the declared
support surface. Use `planted` for force transfer, `supported` for sitting or
leaning, and `sliding-allowed` only when sliding is intentional. Set
`maxSlipPixels` in 1080×1920 delivery pixels.

### Contact

Bind the generated actor and body part to a strict target owner. Use
`deterministic-interaction` for a separately rendered causal prop, and
`generated-world` for scene geometry or an object intentionally retained in
the generated plate. A generated-world object must be the declared
`world.targetId` or an ID listed in `world.generatedObjectIds`; list separate
objects such as `left-curtain` and `right-curtain` when each hand has a distinct
contact target.

Give every deterministic causal prop exactly one contact constraint, using its
prop ID and the same contact/release milestone as its trigger. Set an
interaction kind and tolerance of at most three delivery frames. A
strike/touch/grasp belongs to a `contact` milestone; a release belongs to a
`release` milestone.

Constraint intervals refer to existing milestones and run forward in time.
Actors must be present in the performance, targets and surfaces must match the
world declaration, and deterministic prop IDs must have one trigger-matched
owner.

## Milestones and causal props

Use only the beats the action needs, in strictly increasing shot-local 30 fps
delivery frames:

- `setup`: readable start;
- `anticipation`: load or prepare;
- `approach`: close distance;
- `plant`: establish support before force transfer;
- `contact`: first physical contact;
- `release`: a controlled object becomes independent;
- `follow-through`: momentum continues;
- `settle`: body and secondary motion decay;
- `end`: readable final state.

Trigger a deterministic causal prop only from matching contact/release. Keep it
still before that frame. Give its transparent PNG an intrinsic `renderSize` in
delivery pixels. Treat `transform.x/y` and motion targets as prop-centre
coordinates in the delivery raster. Finish the trajectory inside the shot.

## Conditioning and crop

Default to one complete 480×832 start keyframe for the local start-only model.
Show the same actor, clothes, support, target, lens, lighting, paper edge style,
and entire motion envelope required by the action. Keep full hands and feet in
frame. A clear starting pose is more useful than an ambiguous beauty pose.

Use a second end keyframe only when the chosen local provider explicitly
supports start/end conditioning. Keep identity, camera, background geometry,
materials, and lighting stable; change only the action state. Never add an end
frame merely because a template once required it.

Write observable prompt verbs: “plants the left foot, draws the right leg back,
swings once, then lands balanced” is testable; “moves dynamically” is not.
Exclude deterministic props, camera drift, duplicate limbs, sliding support,
teleporting, morphing, and unmotivated scene changes in the negative prompt.

The native 480×832 plate is not exact 9:16. Conform it into 1080×1920 with
`cover`, not stretch. Put focal attention far enough from the source edges that
the crop preserves face, support, contact, and follow-through.

## Occlusion

Draw the depth stack before generation. Use `none` only if the generated plate
can remain a single opaque layer. Declare `local-matte` when the primary actor
must pass behind or in front of a post, table, doorway, rail, product, or other
foreground geometry, or when deterministic layers must interleave with the
body.

Include a transparent foreground plate when one is needed. Mark the matte
`required` if rendering without it changes the scene logic; mark it `optional`
only for polish that does not alter meaning. The source pack declares a future
`generated/mattes/...` directory but never includes generated matte media.

## Review gates

Review no fewer than 12 whole-shot samples, every milestone, and at least two
frames on each side of contact/release. Reject candidates for:

- identity, clothing, or paper-treatment drift;
- fused, missing, duplicated, or implausibly bent anatomy;
- foot sliding or loss of support without an intentional jump;
- actor/target facing mismatch or reversed action axis;
- deterministic causal prop appearing inside the generated plate;
- prop movement before contact or delayed after release;
- camera drift, reframing, or uncontrolled zoom;
- temporal jumps, background breathing, or solid-geometry penetration;
- crop loss of the face, support foot, contact point, or target;
- required matte missing, corrupt, temporally unstable, or misaligned;
- failure to reach the requested state.

Do not average two bad candidates. Reject both, correct the staging or
conditioning asset, and regenerate.

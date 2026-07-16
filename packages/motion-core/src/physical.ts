export type BallisticPropInput = {
  contactFrame: number;
  flightFrames: number;
  targetX: number;
  targetY: number;
  targetScale: number;
  curveX: number;
  spinDegrees: number;
};

export type PropTransform = {x: number; y: number; scaleX: number; scaleY: number; rotation: number};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * A football stays planted until contact. After contact it has maximum initial
 * screen velocity, then appears to slow and shrink as it travels toward the
 * distant goal. curveX is a single controlled lateral bend, not idle wobble.
 */
export const sampleBallisticProp = (
  motion: BallisticPropInput,
  frame: number,
  base: PropTransform,
): PropTransform => {
  if (frame < motion.contactFrame) return base;
  const raw = clamp01((frame - motion.contactFrame) / Math.max(1, motion.flightFrames));
  const travel = 1 - Math.pow(1 - raw, 2.2);
  const bend = Math.sin(travel * Math.PI) * motion.curveX;
  return {
    x: base.x + (motion.targetX - base.x) * travel + bend,
    y: base.y + (motion.targetY - base.y) * travel,
    scaleX: base.scaleX + (motion.targetScale - base.scaleX) * travel,
    scaleY: base.scaleY + (motion.targetScale - base.scaleY) * travel,
    rotation: base.rotation + motion.spinDegrees * travel,
  };
};

import React from 'react';
import {Img} from 'remotion';
import type {Actor, PoseCutActor, Transform} from '@gen-video-tool/schema';
import type {CompiledMotionPlan, LayerParallaxSample} from '@gen-video-tool/motion-core';
import {eventsForRole} from '@gen-video-tool/motion-core';
import {combineMotionStyles, motionStyleToCss, sampleEvent} from './animation';
import {resolveAssetSource} from './asset-source';

const defaultTransform: Transform = {
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, anchorX: 0.5, anchorY: 0.5,
};

const poseAtFrame = (actor: PoseCutActor, frame: number) => {
  let id = actor.initialPoseId ?? actor.poses[0]?.id;
  for (const change of actor.changes) if (frame >= change.frame) id = change.poseId;
  const pose = actor.poses.find((candidate) => candidate.id === id);
  if (!pose) throw new Error(`POSE_CUT_MISSING_POSE:${actor.id}:${id ?? 'undefined'}`);
  return pose;
};

export const PaperActor: React.FC<{
  actor: Actor;
  actorIndex: number;
  frame: number;
  plan: CompiledMotionPlan;
  parallax: LayerParallaxSample;
  assetBase: string;
  allowUnrenderedMesh?: boolean;
}> = ({actor, actorIndex, frame, plan, parallax, assetBase, allowUnrenderedMesh = false}) => {
  let sourcePath: string;
  if (actor.mode === 'mesh') {
    if (!actor.renderedAsset) {
      if (!allowUnrenderedMesh) throw new Error(`MESH_RENDER_ASSET_REQUIRED:${actor.id}`);
      sourcePath = actor.sourcePath;
    } else {
      const renderedFrame = Math.min(actor.renderedAsset.frameCount - 1, Math.max(0, frame));
      sourcePath = `${actor.renderedAsset.directory}/${actor.renderedAsset.filePrefix}${String(renderedFrame).padStart(6, '0')}.png`;
    }
  } else {
    sourcePath = actor.mode === 'rigid' ? actor.sourcePath : poseAtFrame(actor, frame).sourcePath;
  }
  const base = {...defaultTransform, ...actor.transform};
  const events = eventsForRole(plan, 'subject');
  const sampled = events.map((event) => sampleEvent(event, frame, actorIndex));
  const motion = motionStyleToCss(combineMotionStyles(sampled));
  const transform = [
    'translate(-50%, -50%)',
    `translate3d(${base.x + parallax.x * 1080}px, ${base.y + parallax.y * 1920}px, 0)`,
    `rotate(${base.rotation}deg)`,
    `scale(${base.scaleX * parallax.scale}, ${base.scaleY * parallax.scale})`,
    motion.motionTransform,
  ].join(' ');
  return (
    <Img
      data-actor-id={actor.id}
      data-actor-mode={actor.mode}
      src={resolveAssetSource(assetBase, sourcePath)}
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform,
        transformOrigin: `${base.anchorX * 100}% ${base.anchorY * 100}%`,
        opacity: base.opacity * motion.opacity,
        clipPath: motion.clipPath,
        filter: motion.filter ?? 'drop-shadow(7px 11px 0 rgba(19,15,11,.24)) drop-shadow(0 16px 12px rgba(19,15,11,.24))',
        zIndex: actor.zIndex + 50,
        willChange: 'transform, opacity',
      }}
    />
  );
};

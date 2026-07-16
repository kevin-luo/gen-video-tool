import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import type {ShotDocument} from '@gen-video-tool/schema';
import {compileMotionRecipe, sampleParallaxFrame, type CompiledMotionPlan} from '@gen-video-tool/motion-core';
import {PaperActor} from './actors';
import {PaperLayer} from './PaperLayer';
import {TitleLayer} from './TitleLayer';

export const ShotScene: React.FC<{
  shot: ShotDocument;
  width: number;
  height: number;
  fps: number;
  aspectRatio: '9:16' | '16:9' | '1:1' | '4:5';
  assetBase: string;
  allowUnrenderedMesh?: boolean;
}> = ({shot, width, height, fps, aspectRatio, assetBase, allowUnrenderedMesh = false}) => {
  const frame = useCurrentFrame();
  const recipePlan = compileMotionRecipe({
    recipeId: shot.recipeId,
    durationFrames: shot.durationFrames,
    fps,
    aspectRatio,
    energy: shot.energy,
  });
  const plan: CompiledMotionPlan = {
    ...recipePlan,
    events: [
      ...recipePlan.events,
      ...shot.motionEvents.map((event) => ({
        id: `shot:${shot.id}:${event.id}`,
        kind: 'emphasis' as const,
        targetRole: event.targetRole,
        animation: event.animation,
        startFrame: event.startFrame,
        durationFrames: event.durationFrames,
      })),
    ],
  };
  const layerSamples = sampleParallaxFrame(
    plan,
    frame,
    shot.layers.map((layer) => ({id: layer.id, role: layer.role, depth: layer.depth})),
  );
  const subjectSample = sampleParallaxFrame(plan, frame, [{id: 'actors', role: 'subject', depth: 0.62}])[0];
  if (!subjectSample) throw new Error('PARALLAX_SUBJECT_SAMPLE_MISSING');
  return (
    <AbsoluteFill style={{overflow: 'hidden', background: '#e7d7b6'}}>
      {shot.layers.map((layer, index) => {
        const parallax = layerSamples[index];
        if (!parallax) throw new Error(`PARALLAX_LAYER_SAMPLE_MISSING:${layer.id}`);
        return <PaperLayer key={layer.id} layer={layer} layerIndex={index} frame={frame} plan={plan} parallax={parallax} assetBase={assetBase} />;
      })}
      {shot.actors.map((actor, index) => (
        <PaperActor key={actor.id} actor={actor} actorIndex={index} frame={frame} plan={plan} parallax={subjectSample} assetBase={assetBase} allowUnrenderedMesh={allowUnrenderedMesh} />
      ))}
      <TitleLayer shot={shot} width={width} height={height} />
      <div style={{position: 'absolute', inset: 0, zIndex: 180, pointerEvents: 'none', boxShadow: 'inset 0 0 120px rgba(15,10,5,.18)', mixBlendMode: 'multiply'}} />
    </AbsoluteFill>
  );
};

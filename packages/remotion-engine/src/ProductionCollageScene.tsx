import React from 'react';
import {AbsoluteFill, Easing, Img, interpolate, useCurrentFrame} from 'remotion';
import {sampleCamera} from '@gen-video-tool/motion-core';
import type {EditorialCameraPlan} from '@gen-video-tool/video-generation';
import {resolveAssetSource} from './asset-source';
import {compileEditorialCamera} from './hybrid-camera';

export type ProductionCollageLayer = {
  id: string;
  assetPath: string;
  role: 'background' | 'midground' | 'actor' | 'prop' | 'foreground' | 'overlay';
  zIndex: number;
  transform: {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
    rotationDegrees: number;
    opacity: number;
  };
  motionPreset?: 'locked' | 'idle-breathe' | 'paper-sway' | 'drift' | 'pop-in' | undefined;
};

export type ProductionCollageSceneProps = {
  durationFrames: number;
  width: number;
  height: number;
  assetBase: string;
  layers: readonly ProductionCollageLayer[];
  camera: EditorialCameraPlan;
};

const stablePhase = (id: string): number => {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return Math.abs(hash % 360) * (Math.PI / 180);
};

const sampleLayerMotion = (
  layer: ProductionCollageLayer,
  frame: number,
  durationFrames: number,
): {x: number; y: number; scale: number; rotation: number; opacity: number} => {
  const phase = stablePhase(layer.id);
  const progress = durationFrames <= 1 ? 1 : frame / (durationFrames - 1);
  const wave = Math.sin(progress * Math.PI * 2 + phase);
  switch (layer.motionPreset ?? 'locked') {
    case 'idle-breathe':
      return {x: 0, y: -2.5 + wave * 2.5, scale: 1 + wave * 0.006, rotation: wave * 0.25, opacity: 1};
    case 'paper-sway':
      return {x: wave * 2, y: Math.cos(progress * Math.PI * 2 + phase) * 1.5, scale: 1, rotation: wave * 1.5, opacity: 1};
    case 'drift':
      return {x: interpolate(progress, [0, 1], [-8, 8]) + wave * 2, y: wave * 3, scale: 1, rotation: wave * 0.4, opacity: 1};
    case 'pop-in': {
      const entrance = interpolate(frame, [0, Math.min(14, Math.max(1, durationFrames - 1))], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: Easing.out(Easing.back(1.35)),
      });
      return {x: 0, y: (1 - entrance) * 24, scale: entrance, rotation: (1 - entrance) * -2, opacity: entrance};
    }
    case 'locked':
      return {x: 0, y: 0, scale: 1, rotation: 0, opacity: 1};
  }
};

/** Deterministic renderer for v3 layered-collage shots; no v2 ShotDocument is involved. */
export const ProductionCollageScene: React.FC<ProductionCollageSceneProps> = ({
  durationFrames,
  width,
  height,
  assetBase,
  layers,
  camera,
}) => {
  const frame = useCurrentFrame();
  const cameraSample = sampleCamera(compileEditorialCamera(camera), frame, durationFrames);
  return (
    <AbsoluteFill style={{overflow: 'hidden', background: '#181511'}}>
      <AbsoluteFill
        data-motion-owner="editorial-camera"
        style={{
          transform: `translate3d(${cameraSample.x * width}px, ${cameraSample.y * height}px, 0) scale(${cameraSample.scale})`,
          transformOrigin: '50% 50%',
          willChange: 'transform',
        }}
      >
        {[...layers].sort((left, right) => left.zIndex - right.zIndex).map((layer) => {
          const motion = sampleLayerMotion(layer, frame, durationFrames);
          const transform = [
            layer.role === 'background' ? '' : 'translate(-50%, -50%)',
            `translate3d(${layer.transform.x + motion.x}px, ${layer.transform.y + motion.y}px, 0)`,
            `rotate(${layer.transform.rotationDegrees + motion.rotation}deg)`,
            `scale(${layer.transform.scaleX * motion.scale}, ${layer.transform.scaleY * motion.scale})`,
          ].filter(Boolean).join(' ');
          return (
            <Img
              key={layer.id}
              data-collage-layer-id={layer.id}
              data-motion-owner="deterministic-collage"
              src={resolveAssetSource(assetBase, layer.assetPath)}
              style={layer.role === 'background' ? {
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                maxWidth: 'none',
                objectFit: 'cover',
                opacity: layer.transform.opacity * motion.opacity,
                transform,
                transformOrigin: '50% 50%',
                zIndex: layer.zIndex,
                willChange: 'transform, opacity',
              } : {
                position: 'absolute',
                left: 0,
                top: 0,
                maxWidth: 'none',
                opacity: layer.transform.opacity * motion.opacity,
                transform,
                transformOrigin: '50% 50%',
                zIndex: layer.zIndex,
                willChange: 'transform, opacity',
              }}
            />
          );
        })}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

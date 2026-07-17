import React from 'react';
import {AbsoluteFill, Img, OffthreadVideo, useCurrentFrame} from 'remotion';
import type {BallisticPropInput, PropTransform} from '@gen-video-tool/motion-core';
import {sampleBallisticProp, sampleCamera} from '@gen-video-tool/motion-core';
import type {EditorialCameraPlan} from '@gen-video-tool/video-generation';
import {resolveAssetSource} from './asset-source';
import {compileEditorialCamera} from './hybrid-camera';

export type HybridPerformanceProp = {
  id: string;
  assetPath: string;
  /** Intrinsic delivery-pixel dimensions before motion scale is applied. */
  renderSize: {width: number; height: number};
  /** Pixel-space centre position in the production canvas. */
  transform: PropTransform;
  motion: BallisticPropInput;
  zIndex?: number;
};

export type PerformanceSourceTimebase = {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
};

export type PerformanceConform = {
  spatialFit: 'cover';
  focalPoint: {x: number; y: number};
  temporalFit: 'preserve-duration';
};

export const HYBRID_LAYER_ORDER = {
  generatedPlate: 0,
  deterministicProp: 20,
  subjectMatte: 30,
  staticForeground: 35,
  editorialOverlay: 40,
} as const;

export const focalPointToObjectPosition = (focalPoint: {x: number; y: number}): string => {
  const x = Math.min(1, Math.max(0, focalPoint.x));
  const y = Math.min(1, Math.max(0, focalPoint.y));
  const percentage = (value: number): number => Number((value * 100).toFixed(4));
  return `${percentage(x)}% ${percentage(y)}%`;
};

/** Map native WanGP seconds onto the exact delivery duration without frame-index coupling. */
export const computePreserveDurationPlaybackRate = (
  source: PerformanceSourceTimebase,
  deliveryFps: number,
  deliveryFrameCount: number,
): number => {
  if (
    source.fps <= 0
    || source.frameCount <= 0
    || deliveryFps <= 0
    || deliveryFrameCount <= 0
  ) {
    throw new Error('PERFORMANCE_TIMEBASE_INVALID');
  }
  return (source.frameCount / source.fps) / (deliveryFrameCount / deliveryFps);
};

export type HybridPerformanceSceneProps = {
  durationFrames: number;
  width: number;
  height: number;
  fps: number;
  assetBase: string;
  /** Normalized, silent performance candidate with causal props removed. */
  performanceVideoPath: string;
  source: PerformanceSourceTimebase;
  conform: PerformanceConform;
  deterministicProps: readonly HybridPerformanceProp[];
  /** Transparent subject/foreground extract rendered above interaction props. */
  foregroundOcclusionVideoPath?: string;
  /** Transparent/full-canvas foreground plate rendered above matte and props. */
  foregroundOcclusionAssetPath?: string;
  camera: EditorialCameraPlan;
  children?: React.ReactNode;
};

/**
 * vNext compositing primitive. It deliberately has no fallback to a static
 * actor: the caller must provide an approved performance video.
 */
export const HybridPerformanceScene: React.FC<HybridPerformanceSceneProps> = ({
  durationFrames,
  width,
  height,
  fps,
  assetBase,
  performanceVideoPath,
  source,
  conform,
  deterministicProps,
  foregroundOcclusionVideoPath,
  foregroundOcclusionAssetPath,
  camera,
  children,
}) => {
  const frame = useCurrentFrame();
  const cameraSample = sampleCamera(compileEditorialCamera(camera), frame, durationFrames);
  const objectPosition = focalPointToObjectPosition(conform.focalPoint);
  const playbackRate = computePreserveDurationPlaybackRate(source, fps, durationFrames);
  const cameraTransform = [
    `translate3d(${cameraSample.x * width}px, ${cameraSample.y * height}px, 0)`,
    `scale(${cameraSample.scale})`,
  ].join(' ');

  return (
    <AbsoluteFill style={{overflow: 'hidden', background: '#000'}}>
      <AbsoluteFill
        data-motion-owner="editorial-camera"
        style={{transform: cameraTransform, transformOrigin: '50% 50%', willChange: 'transform'}}
      >
        <OffthreadVideo
          data-motion-owner="generated-performance"
          src={resolveAssetSource(assetBase, performanceVideoPath)}
          muted
          playbackRate={playbackRate}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: conform.spatialFit,
            objectPosition,
            zIndex: HYBRID_LAYER_ORDER.generatedPlate,
          }}
        />
        {deterministicProps.map((prop) => {
          const sampled = sampleBallisticProp(prop.motion, frame, prop.transform);
          return (
            <Img
              key={prop.id}
              data-interaction-prop-id={prop.id}
              data-motion-owner="deterministic-interaction"
              src={resolveAssetSource(assetBase, prop.assetPath)}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: prop.renderSize.width,
                height: prop.renderSize.height,
                maxWidth: 'none',
                transform: [
                  'translate(-50%, -50%)',
                  `translate3d(${sampled.x}px, ${sampled.y}px, 0)`,
                  `rotate(${sampled.rotation}deg)`,
                  `scale(${sampled.scaleX}, ${sampled.scaleY})`,
                ].join(' '),
                transformOrigin: '50% 50%',
                zIndex: prop.zIndex ?? HYBRID_LAYER_ORDER.deterministicProp,
                willChange: 'transform',
              }}
            />
          );
        })}
        {foregroundOcclusionVideoPath === undefined ? null : (
          <OffthreadVideo
            data-motion-owner="interaction-occlusion"
            src={resolveAssetSource(assetBase, foregroundOcclusionVideoPath)}
            muted
            playbackRate={playbackRate}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition,
              zIndex: HYBRID_LAYER_ORDER.subjectMatte,
              pointerEvents: 'none',
            }}
          />
        )}
        {foregroundOcclusionAssetPath === undefined ? null : (
          <Img
            data-motion-owner="static-foreground-occlusion"
            src={resolveAssetSource(assetBase, foregroundOcclusionAssetPath)}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition,
              zIndex: HYBRID_LAYER_ORDER.staticForeground,
              pointerEvents: 'none',
            }}
          />
        )}
        <AbsoluteFill style={{zIndex: HYBRID_LAYER_ORDER.editorialOverlay, pointerEvents: 'none'}}>{children}</AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

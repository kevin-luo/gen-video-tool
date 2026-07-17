import React from 'react';
import {AbsoluteFill, Audio, Sequence} from 'remotion';
import type {EditorialCameraPlan} from '@gen-video-tool/video-generation';
import type {
  HybridPerformanceProp,
  PerformanceConform,
  PerformanceSourceTimebase,
} from './HybridPerformanceScene';
import {HybridPerformanceScene} from './HybridPerformanceScene';
import {ProductionCollageScene, type ProductionCollageLayer} from './ProductionCollageScene';
import {resolveAssetSource} from './asset-source';

export type LayeredCollageRenderShot = {
  shotId: string;
  kind: 'layered-collage';
  startFrame: number;
  durationFrames: number;
  layers: ProductionCollageLayer[];
  camera: EditorialCameraPlan;
};

export type GeneratedPerformanceRenderShot = {
  shotId: string;
  kind: 'generated-performance';
  startFrame: number;
  durationFrames: number;
  /** Project-relative, technically approved and explicitly accepted candidate. */
  performanceVideoPath: string;
  /** Native WanGP raster/timebase. Delivery frames sample it by elapsed time. */
  source: PerformanceSourceTimebase;
  conform: PerformanceConform;
  deterministicProps: HybridPerformanceProp[];
  camera: EditorialCameraPlan;
  /** Reserved for an alpha subject/foreground pass above deterministic props. */
  foregroundOcclusionVideoPath?: string;
  /** Static transparent foreground plate above matte and deterministic props. */
  foregroundOcclusionAssetPath?: string;
};

export type ProductionShotRenderData = LayeredCollageRenderShot | GeneratedPerformanceRenderShot;

/** Serializable boundary between the local production state and Remotion. */
export type ProductionRenderData = {
  schemaVersion: 3;
  projectId: string;
  delivery: {
    width: number;
    height: number;
    fps: number;
    durationFrames: number;
  };
  shots: ProductionShotRenderData[];
  /** Resolved by the local runtime. It is previewed here and muxed by render-service. */
  narrationPath?: string;
};

export type ProjectVideoProps = {
  assetBase: string;
  productionRenderData: ProductionRenderData;
};

const assertProductionTimeline = (production: ProductionRenderData): void => {
  const ids = new Set<string>();
  let cursor = 0;
  for (const shot of production.shots) {
    if (ids.has(shot.shotId)) throw new Error('PRODUCTION_RENDER_DUPLICATE_SHOT');
    ids.add(shot.shotId);
    if (shot.startFrame !== cursor || shot.durationFrames <= 0) {
      throw new Error(`PRODUCTION_RENDER_TIMELINE_INVALID:${shot.shotId}`);
    }
    cursor += shot.durationFrames;
  }
  if (cursor !== production.delivery.durationFrames) throw new Error('PRODUCTION_RENDER_DELIVERY_MISMATCH');
};

export const ProjectVideo: React.FC<ProjectVideoProps> = ({
  assetBase,
  productionRenderData,
}) => {
  assertProductionTimeline(productionRenderData);
  const {delivery} = productionRenderData;
  return (
    <AbsoluteFill style={{background: '#181511'}}>
      {productionRenderData.shots.map((shot) => (
          <Sequence key={shot.shotId} from={shot.startFrame} durationInFrames={shot.durationFrames} premountFor={12}>
            {shot.kind === 'generated-performance' ? (
              <HybridPerformanceScene
                durationFrames={shot.durationFrames}
                width={delivery.width}
                height={delivery.height}
                fps={delivery.fps}
                assetBase={assetBase}
                performanceVideoPath={shot.performanceVideoPath}
                source={shot.source}
                conform={shot.conform}
                deterministicProps={shot.deterministicProps}
                {...(shot.foregroundOcclusionVideoPath === undefined
                  ? {}
                  : {foregroundOcclusionVideoPath: shot.foregroundOcclusionVideoPath})}
                {...(shot.foregroundOcclusionAssetPath === undefined
                  ? {}
                  : {foregroundOcclusionAssetPath: shot.foregroundOcclusionAssetPath})}
                camera={shot.camera}
              />
            ) : (
              <ProductionCollageScene
                durationFrames={shot.durationFrames}
                width={delivery.width}
                height={delivery.height}
                assetBase={assetBase}
                layers={shot.layers}
                camera={shot.camera}
              />
            )}
          </Sequence>
      ))}
      {productionRenderData.narrationPath === undefined
        ? null
        : <Audio src={resolveAssetSource(assetBase, productionRenderData.narrationPath)} />}
    </AbsoluteFill>
  );
};

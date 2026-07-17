import React from 'react';
import {Composition} from 'remotion';
import {ProjectVideo, type ProductionRenderData} from './ProjectVideo';

const fallbackProduction: ProductionRenderData = {
  schemaVersion: 3,
  projectId: 'preview',
  delivery: {width: 1080, height: 1920, fps: 30, durationFrames: 90},
  shots: [{
    shotId: 'shot-01',
    kind: 'layered-collage',
    startFrame: 0,
    durationFrames: 90,
    layers: [],
    camera: {owner: 'editorial-camera', operation: 'locked', strength: 0},
  }],
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="GenVideoProject"
    component={ProjectVideo}
    defaultProps={{productionRenderData: fallbackProduction, assetBase: 'runtime/preview'}}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={90}
    calculateMetadata={({props}) => {
      const delivery = props.productionRenderData?.delivery;
      return {
        width: delivery?.width ?? 1080,
        height: delivery?.height ?? 1920,
        fps: delivery?.fps ?? 30,
        durationInFrames: delivery?.durationFrames ?? 90,
      };
    }}
  />
);

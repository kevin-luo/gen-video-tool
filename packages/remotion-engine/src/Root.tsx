import React from 'react';
import {Composition} from 'remotion';
import {ProjectVideo, type ProjectVideoProps} from './ProjectVideo';

const fallbackProject: ProjectVideoProps['project'] = {
  schemaVersion: 2,
  manifest: {
    schemaVersion: 2,
    projectId: 'preview',
    title: 'Preview',
    locale: 'zh-CN',
    canvas: {width: 1080, height: 1920, aspectRatio: '9:16'},
    fps: 30,
    shots: [{id: 'shot-01', path: 'shots/shot-01/shot.json'}],
  },
  shots: [{
    schemaVersion: 2,
    id: 'shot-01',
    durationFrames: 90,
    recipeId: 'hero-assemble',
    energy: 'balanced',
    layers: [{id: 'title', role: 'title', text: 'Gen Video Tool', depth: 0, visible: true}],
    actors: [],
    motionEvents: [],
    transition: {type: 'hard-cut', durationFrames: 0},
  }],
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="GenVideoProject"
    component={ProjectVideo}
    defaultProps={{project: fallbackProject, assetBase: 'runtime/preview'}}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={90}
    calculateMetadata={({props}) => ({
      width: props.project.manifest.canvas.width,
      height: props.project.manifest.canvas.height,
      fps: props.project.manifest.fps,
      durationInFrames: props.project.shots.reduce((sum, shot) => sum + shot.durationFrames, 0),
    })}
  />
);

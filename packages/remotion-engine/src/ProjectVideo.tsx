import React from 'react';
import {AbsoluteFill, Audio, Sequence} from 'remotion';
import type {ProjectDocument} from '@gen-video-tool/schema';
import {ShotScene} from './ShotScene';
import {resolveAssetSource} from './asset-source';

export type ProjectVideoProps = {
  project: ProjectDocument;
  assetBase: string;
  /** Desktop preview only. Deterministic exports must keep this false so missing Worker output fails loudly. */
  allowUnrenderedMesh?: boolean;
};

export const ProjectVideo: React.FC<ProjectVideoProps> = ({project, assetBase, allowUnrenderedMesh = false}) => {
  let cursor = 0;
  return (
    <AbsoluteFill style={{background: '#181511'}}>
      {project.shots.map((shot) => {
        const from = cursor;
        cursor += shot.durationFrames;
        return (
          <Sequence key={shot.id} from={from} durationInFrames={shot.durationFrames} premountFor={12}>
            <ShotScene
              shot={shot}
              width={project.manifest.canvas.width}
              height={project.manifest.canvas.height}
              fps={project.manifest.fps}
              aspectRatio={project.manifest.canvas.aspectRatio}
              assetBase={assetBase}
              allowUnrenderedMesh={allowUnrenderedMesh}
            />
          </Sequence>
        );
      })}
      {project.manifest.audio ? <Audio src={resolveAssetSource(assetBase, project.manifest.audio.narrationPath)} /> : null}
    </AbsoluteFill>
  );
};

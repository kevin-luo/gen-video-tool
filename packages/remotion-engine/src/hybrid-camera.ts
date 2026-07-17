import type {EditorialCameraPlan} from '@gen-video-tool/video-generation';
import type {CameraDirective} from '@gen-video-tool/motion-core';

/** Map the backend-neutral one-camera contract to the existing frame sampler. */
export const compileEditorialCamera = (camera: EditorialCameraPlan): CameraDirective => {
  const strength = camera.strength;
  if (camera.operation === 'locked') {
    return {kind: 'locked', x: 0, y: 0, scaleFrom: 1, scaleTo: 1};
  }
  const edgeProtectionScale = 1 + strength * 0.035;
  if (camera.operation === 'push') {
    return {kind: 'push', x: 0, y: 0, scaleFrom: 1, scaleTo: 1 + strength * 0.08};
  }
  if (camera.operation === 'pull') {
    return {kind: 'pull', x: 0, y: 0, scaleFrom: 1 + strength * 0.08, scaleTo: 1};
  }
  const travel = strength * 0.045;
  return {
    kind: camera.operation,
    x: camera.operation === 'pan-left' ? -travel : camera.operation === 'pan-right' ? travel : 0,
    y: camera.operation === 'pan-up' ? -travel : camera.operation === 'pan-down' ? travel : 0,
    scaleFrom: edgeProtectionScale,
    scaleTo: edgeProtectionScale,
  };
};

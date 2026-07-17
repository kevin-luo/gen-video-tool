import path from 'node:path';

import {loadProductionPlan} from '../packages/video-generation/src/index.js';

const input = process.argv[2];
if (!input) {
  throw new Error('Usage: npm run validate:production -- <project-directory>');
}

const projectRoot = path.resolve(input);
const plan = await loadProductionPlan(projectRoot);
process.stdout.write(`${JSON.stringify({
  valid: true,
  projectRoot,
  projectId: plan.projectId,
  title: plan.metadata.title,
  delivery: {
    width: plan.delivery.raster.width,
    height: plan.delivery.raster.height,
    fps: plan.delivery.timeline.fps,
    durationFrames: plan.delivery.timeline.durationFrames,
  },
  shots: plan.shots.map((shot) => ({
    shotId: shot.shotId,
    kind: shot.kind,
    startFrame: shot.deliveryTimeline.startFrame,
    durationFrames: shot.deliveryTimeline.durationFrames,
    ...(shot.kind === 'generated-performance'
      ? {
          conditioning: shot.generation.conditioning.mode,
          generationRaster: shot.generation.raster,
          generationTimeline: shot.generation.timeline,
          candidateSeeds: shot.generation.candidateSeeds,
        }
      : {}),
  })),
}, null, 2)}\n`);

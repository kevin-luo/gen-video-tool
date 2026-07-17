import type {VideoProbe} from '../validation/video.js';
import type {CandidateTechnicalQa} from './production-state.js';
import type {GeneratedPerformanceShot} from './production-plan.js';

/**
 * One strict candidate contract shared by generation review and final render.
 * A normalized performance plate is accepted only when its frame count is
 * exact; the render path must never be stricter or looser than the editor.
 */
export const generatedCandidateProbeIssues = (
  shot: GeneratedPerformanceShot,
  probe: VideoProbe,
): string[] => {
  const issues: string[] = [];
  const {raster, timeline} = shot.generation;
  if (probe.width !== raster.width || probe.height !== raster.height) {
    issues.push(`resolution expected ${raster.width}x${raster.height}, received ${probe.width}x${probe.height}`);
  }
  if (probe.fps === null || Math.abs(probe.fps - timeline.fps) > 0.01) {
    issues.push(`fps expected ${timeline.fps}, received ${probe.fps ?? 'unknown'}`);
  }
  if (probe.frameCount === null || probe.frameCount !== timeline.frameCount) {
    issues.push(`frameCount expected ${timeline.frameCount}, received ${probe.frameCount ?? 'unknown'}`);
  }
  if (probe.codecName !== 'h264') {
    issues.push(`codec expected h264, received ${probe.codecName ?? 'unknown'}`);
  }
  if (probe.pixelFormat !== 'yuv420p') {
    issues.push(`pixelFormat expected yuv420p, received ${probe.pixelFormat ?? 'unknown'}`);
  }
  if (probe.hasAudio) issues.push('generated performance candidate must be silent');
  return issues;
};

export const buildGeneratedCandidateTechnicalQa = (
  shot: GeneratedPerformanceShot,
  probe: VideoProbe,
  checkedAt = new Date().toISOString(),
): CandidateTechnicalQa => {
  const issues = generatedCandidateProbeIssues(shot, probe);
  return {
    result: issues.length === 0 ? 'pass' : 'fail',
    checkedAt,
    probe: {
      width: probe.width,
      height: probe.height,
      fps: probe.fps ?? shot.generation.timeline.fps,
      frameCount: probe.frameCount ?? shot.generation.timeline.frameCount,
      codec: probe.codecName ?? 'unknown',
      pixelFormat: probe.pixelFormat ?? 'unknown',
      hasAudio: probe.hasAudio,
    },
    issues,
  };
};

export const reprobeMatchesPersistedQa = (
  probe: VideoProbe,
  persisted: CandidateTechnicalQa['probe'],
): boolean => probe.width === persisted.width
  && probe.height === persisted.height
  && probe.fps !== null
  && Math.abs(probe.fps - persisted.fps) <= 0.01
  && probe.frameCount === persisted.frameCount
  && probe.codecName === persisted.codec
  && probe.pixelFormat === persisted.pixelFormat
  && probe.hasAudio === persisted.hasAudio;

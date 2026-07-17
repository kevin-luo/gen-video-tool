import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';

export interface FixtureOptions {
  mode?: 'generated-start-end' | 'generated-start-only' | 'layered-collage';
  keyframeWidth?: number;
  keyframeHeight?: number;
  propHasAlpha?: boolean;
  collageActorHasAlpha?: boolean;
  referenceAudioValid?: boolean;
}

const createWav = (durationSeconds: number, sampleRate = 8_000): Buffer => {
  const sampleCount = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataBytes = sampleCount * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write('WAVEfmt ', 8, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(dataBytes, 40);
  return output;
};

const basePlan = (shots: unknown[], requiredCapabilities: string[]) => ({
  schemaVersion: 3,
  projectId: 'fixture-project',
  metadata: {title: 'Fixture project', locale: 'zh-CN'},
  networkPolicy: 'offline-only',
  requiredCapabilities,
  delivery: {
    raster: {width: 1080, height: 1920, pixelAspectRatio: 1},
    timeline: {fps: 30, durationFrames: 101},
    video: {path: 'generated/final/video.mp4', codec: 'h264', pixelFormat: 'yuv420p'},
    audio: {
      path: 'generated/audio/narration.wav',
      sourceFormat: 'wav',
      muxCodec: 'aac',
      muxSampleRate: 48000,
    },
    subtitles: {path: 'generated/final/video.srt', format: 'srt', burnIn: false},
    bgm: null,
  },
  narration: {
    engine: 'f5-tts-local',
    language: 'zh-CN',
    referenceAudioPath: 'assets/voices/narrator.wav',
    referenceText: '这是本地参考音频。',
    speed: 1,
    segments: [{
      segmentId: 'voice-shot-01',
      shotId: 'shot-01',
      text: '支撑脚先落地，触球之后球才飞出去。',
      outputPath: 'generated/audio/shot-01.wav',
    }],
    mergedAudioPath: 'generated/audio/narration.wav',
  },
  shots,
});

const generatedShot = (mode: 'generated-start-end' | 'generated-start-only') => ({
  kind: 'generated-performance',
  shotId: 'shot-01',
  deliveryTimeline: {startFrame: 0, durationFrames: 101},
  generation: {
    engine: 'wangp-local-i2v',
    conditioning: mode === 'generated-start-end'
      ? {
          mode: 'start-end',
          startKeyframePath: 'assets/shots/shot-01/performance-start.png',
          endKeyframePath: 'assets/shots/shot-01/performance-end.png',
        }
      : {
          mode: 'start-only',
          startKeyframePath: 'assets/shots/shot-01/performance-start.png',
        },
    preset: {
      id: 'portrait-i2v-quality',
      quality: 'quality',
      conditioning: mode === 'generated-start-end' ? 'start-end' : 'start-only',
      motionStrength: 0.72,
    },
    raster: {width: 480, height: 832},
    timeline: {fps: 24, frameCount: 81},
    conformToDelivery: {
      spatialFit: 'cover',
      focalPoint: {x: 0.5, y: 0.48},
      temporalFit: 'preserve-duration',
    },
    candidateSeeds: [42, 314159],
  },
  hybridMotion: {
    actor: {
      id: 'kicker',
      supportingActorIds: [],
      action: 'one right-foot strike and balanced follow-through',
      prompt: 'Locked camera. Face the goal, plant the left foot, strike once, and settle in balance.',
      negativePrompt: 'ball, camera movement, sliding feet, extra limbs, duplicate body parts',
      generatedCamera: 'locked',
      excludedCausalPropIds: ['ball'],
    },
    world: {
      subjectId: 'kicker',
      targetId: 'goal',
      generatedObjectIds: [],
      supportSurfaceId: 'pitch',
      actionAxis: {from: {x: 0.48, y: 0.82}, to: {x: 0.51, y: 0.2}},
      milestones: [
        {id: 'setup', kind: 'setup', frame: 0},
        {id: 'plant', kind: 'plant', frame: 16},
        {id: 'contact', kind: 'contact', frame: 30},
        {id: 'follow', kind: 'follow-through', frame: 60},
        {id: 'end', kind: 'end', frame: 100},
      ],
      constraints: {
        facing: [{
          id: 'face-goal',
          actorId: 'kicker',
          towardTargetId: 'goal',
          bodyAxis: 'torso',
          fromMilestoneId: 'setup',
          throughMilestoneId: 'contact',
          maxDeviationDegrees: 35,
        }],
        support: [{
          id: 'plant-left-foot',
          actorId: 'kicker',
          bodyPart: 'left-foot',
          surfaceId: 'pitch',
          mode: 'planted',
          fromMilestoneId: 'plant',
          throughMilestoneId: 'contact',
          maxSlipPixels: 4,
        }],
        contact: [{
          id: 'strike-ball',
          actorId: 'kicker',
          bodyPart: 'right-foot',
          target: {owner: 'deterministic-interaction', propId: 'ball'},
          milestoneId: 'contact',
          kind: 'strike',
          toleranceFrames: 1,
        }],
      },
    },
    deterministicProps: [{
      propId: 'ball',
      assetPath: 'assets/shots/shot-01/ball.png',
      renderSize: {width: 72, height: 72},
      trigger: {milestoneId: 'contact', kind: 'contact'},
      transform: {x: 500, y: 1500, scaleX: 1, scaleY: 1, rotationDegrees: 0},
      motion: {
        kind: 'ballistic',
        contactFrame: 30,
        flightFrames: 70,
        targetX: 520,
        targetY: 300,
        targetScale: 0.2,
        curveX: 20,
        spinDegrees: 540,
      },
    }],
    editorialCamera: {owner: 'editorial-camera', operation: 'push', strength: 0.12},
  },
  occlusion: {mode: 'none', requirement: 'none'},
});

const collageShot = () => ({
  kind: 'layered-collage',
  shotId: 'shot-01',
  deliveryTimeline: {startFrame: 0, durationFrames: 101},
  layers: [
    {
      id: 'background',
      assetPath: 'assets/shots/shot-01/background.png',
      role: 'background',
      zIndex: 0,
      transform: {x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDegrees: 0, opacity: 1},
      motionPreset: 'locked',
    },
    {
      id: 'hero',
      assetPath: 'assets/shots/shot-01/hero.png',
      role: 'actor',
      zIndex: 10,
      transform: {x: 540, y: 1100, scaleX: 1, scaleY: 1, rotationDegrees: 0, opacity: 1},
      motionPreset: 'paper-sway',
    },
  ],
  editorialCamera: {owner: 'editorial-camera', operation: 'push', strength: 0.08},
});

export const writeValidAssetPack = async (
  root: string,
  options: FixtureOptions = {},
): Promise<void> => {
  const mode = options.mode ?? 'generated-start-end';
  await mkdir(path.join(root, 'assets', 'shots', 'shot-01'), {recursive: true});
  await mkdir(path.join(root, 'assets', 'voices'), {recursive: true});

  if (mode === 'layered-collage') {
    const actorChannels = options.collageActorHasAlpha === false ? 3 : 4;
    await Promise.all([
      sharp({
        create: {width: 1080, height: 1920, channels: 3, background: {r: 80, g: 60, b: 40}},
      }).png().toFile(path.join(root, 'assets', 'shots', 'shot-01', 'background.png')),
      sharp({
        create: {
          width: 320,
          height: 720,
          channels: actorChannels,
          background: actorChannels === 4
            ? {r: 210, g: 90, b: 50, alpha: 0.85}
            : {r: 210, g: 90, b: 50},
        },
      }).png().toFile(path.join(root, 'assets', 'shots', 'shot-01', 'hero.png')),
    ]);
  } else {
    const width = options.keyframeWidth ?? 480;
    const height = options.keyframeHeight ?? 832;
    const propChannels = options.propHasAlpha === false ? 3 : 4;
    const tasks: Array<Promise<unknown>> = [
      sharp({create: {width, height, channels: 3, background: {r: 80, g: 60, b: 40}}})
        .png().toFile(path.join(root, 'assets', 'shots', 'shot-01', 'performance-start.png')),
      sharp({
        create: {
          width: 64,
          height: 64,
          channels: propChannels,
          background: propChannels === 4
            ? {r: 245, g: 245, b: 235, alpha: 0.9}
            : {r: 245, g: 245, b: 235},
        },
      }).png().toFile(path.join(root, 'assets', 'shots', 'shot-01', 'ball.png')),
    ];
    if (mode === 'generated-start-end') {
      tasks.push(
        sharp({create: {width, height, channels: 3, background: {r: 70, g: 55, b: 35}}})
          .png().toFile(path.join(root, 'assets', 'shots', 'shot-01', 'performance-end.png')),
      );
    }
    await Promise.all(tasks);
  }

  await writeFile(
    path.join(root, 'assets', 'voices', 'narrator.wav'),
    options.referenceAudioValid === false ? 'not audio' : createWav(0.3),
  );

  const generated = mode !== 'layered-collage';
  const capabilities = [
    'local-f5-tts',
    ...(generated ? ['local-i2v'] : []),
    ...(mode === 'generated-start-end' ? ['local-i2v-start-end'] : []),
    ...(generated ? ['deterministic-ballistics'] : []),
    'remotion-render',
    'ffmpeg',
    'sidecar-srt',
  ];
  const shot = generated ? generatedShot(mode) : collageShot();
  await writeFile(path.join(root, 'production.json'), JSON.stringify(basePlan([shot], capabilities), null, 2));
};

const addDirectory = async (zip: JSZip, root: string, directory = ''): Promise<void> => {
  const entries = await readdir(path.join(root, directory), {withFileTypes: true});
  for (const entry of entries) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await addDirectory(zip, root, relative);
    else zip.file(relative, await readFile(path.join(root, directory, entry.name)));
  }
};

export const zipAssetPack = async (sourceRoot: string, outputPath: string): Promise<void> => {
  const zip = new JSZip();
  await addDirectory(zip, sourceRoot);
  await writeFile(outputPath, await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}));
};

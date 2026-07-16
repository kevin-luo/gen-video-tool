import type {ShotModel} from '../domain/editor';
import type {ProjectDocument} from '@gen-video-tool/schema';
import type {ProjectPayload} from '../../shared/desktop-api';

const shotBase = (
  id: string,
  index: number,
  title: string,
  year: string,
  duration: number,
  note: string,
  palette: ShotModel['palette'],
): ShotModel => ({
  id,
  index,
  title,
  note,
  year,
  duration,
  recipe: index === 4 ? 'hero-assemble' : index === 5 ? 'number-impact' : 'editorial-pan',
  energy: index === 4 ? 'punchy' : 'balanced',
  camera: index === 4 ? 'push-in' : index === 3 ? 'follow' : 'static',
  transition: index === 4 ? 'torn-paper' : index === 5 ? 'flash-frame' : 'newspaper-slide',
  selectedLayerId: `${id}-subject`,
  layers: [
    {id: `${id}-background`, name: '历史球场', role: 'background', x: 0, y: 0, scale: 100, rotation: 0, depth: 8, visible: true},
    {id: `${id}-subject`, name: index === 4 ? '9号前锋' : '主角人物', role: 'subject', x: 46, y: 58, scale: 100, rotation: 0, depth: 48, visible: true},
    {id: `${id}-prop`, name: '年份与道具', role: 'prop', x: 22, y: 14, scale: 100, rotation: -3, depth: 66, visible: true},
    {id: `${id}-foreground`, name: '前景撕纸', role: 'foreground', x: 0, y: 88, scale: 100, rotation: 0, depth: 92, visible: true},
  ],
  actor: {
    id: `${id}-actor`,
    mode: index === 4 ? 'pose-cut' : 'rigid',
    availableModes: [index === 4 ? 'pose-cut' : 'rigid'],
    action: index === 4 ? 'shot-ready' : 'idle-breathe',
    actionStrength: 0.5,
    poseA: 'player-facing-goal.png',
    poseB: 'player-follow-through.png',
    switchCover: 'foreground',
  },
  palette,
});

const demoShots: ShotModel[] = [
  shotBase('shot-01', 1, '百年开球', '1924', 3.2, '叙事模式', 'sand'),
  shotBase('shot-02', 2, '黄金年代', '1930', 4.1, '叙事模式', 'ink'),
  shotBase('shot-03', 3, '远射破门', '1934', 3.6, '快节奏模式', 'olive'),
  shotBase('shot-04', 4, '点球决胜', '1966', 4.3, '高潮模式', 'rust'),
  shotBase('shot-05', 5, '冠军时刻', '1966', 3.7, '叙事模式', 'sand'),
  shotBase('shot-06', 6, '传奇延续', '1986', 3.9, '叙事模式', 'ink'),
  shotBase('shot-07', 7, '新的篇章', '2026', 3.1, '收束模式', 'olive'),
];

const demoDocument: ProjectDocument = {
  schemaVersion: 2,
  manifest: {
    schemaVersion: 2, projectId: 'football-history', title: '足球百年：一次射门改变比赛', locale: 'zh-CN',
    canvas: {width: 1080, height: 1920, aspectRatio: '9:16'}, fps: 30,
    shots: demoShots.map((shot) => ({id: shot.id, path: `shots/${shot.id}/shot.json`})),
  },
  shots: demoShots.map((shot) => ({
    schemaVersion: 2, id: shot.id, name: shot.note, durationFrames: Math.round(shot.duration * 30),
    recipeId: shot.recipe, energy: shot.energy, camera: {kind: 'locked', strength: 0.35},
    layers: [{id: 'title', role: 'title', text: shot.title, depth: 0, visible: true}],
    actors: shot.id === 'shot-01' ? [{
      id: 'keeper', mode: 'mesh', sourcePath: 'assets/characters/keeper/character.png',
      rigPath: 'assets/characters/keeper/rig.json', actionTemplate: 'idle-breathe', actionStrength: 0.72,
      actionStartFrame: 0, actionDurationFrames: Math.round(shot.duration * 30), zIndex: 8,
    }] : [],
    motionEvents: [],
    title: {text: shot.title, language: 'zh-CN', maxLines: 2, safeArea: 0.08, paperBackground: true, rotation: 0},
    transition: {type: 'hard-cut', durationFrames: 0},
  })),
};

export const demoPayload: ProjectPayload = {project: demoDocument, assetBase: 'runtime/preview', readOnly: true};

export const motionRecipeLabels: Record<ShotModel['recipe'], string> = {
  'hero-assemble': '主角组装',
  'editorial-pan': '编辑推移',
  'number-impact': '数字冲击',
  'paper-stack': '纸片堆叠',
  'timeline-travel': '时间旅行',
  'comparison-split': '对比分屏',
  'quiet-story': '安静叙事',
  'detail-reveal': '细节揭示',
};

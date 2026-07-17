import type {DesktopApi} from '../../shared/desktop-api';

const desktopRequired = async (): Promise<never> => {
  throw new Error('DESKTOP_RUNTIME_REQUIRED:请在 Electron 桌面应用中使用本地模型与文件系统');
};

/**
 * The browser fallback exists only so the renderer can display its empty
 * shell during isolated UI development. It never fabricates projects, media,
 * provider availability, exports, or successful local-model work.
 */
const browserFallback: DesktopApi = {
  platform: 'browser',
  selectAssetPack: async () => null,
  inspectAssetPack: desktopRequired,
  importAssetPack: desktopRequired,
  listRecentProjects: async () => [],
  openProject: desktopRequired,
  deleteProject: desktopRequired,
  exportProject: desktopRequired,
  cancelExport: desktopRequired,
  onExportProgress: () => () => undefined,
  revealOutput: desktopRequired,
  getProductionSnapshot: async (projectId) => ({
    projectId,
    hasPlan: false,
    readOnly: true,
    shots: [],
    error: {code: 'DESKTOP_RUNTIME_REQUIRED', message: '本地生产状态仅在 Electron 桌面运行时可用'},
  }),
  detectProductionProvider: desktopRequired,
  synthesizeProductionNarration: desktopRequired,
  cancelProductionNarration: desktopRequired,
  generateProductionShot: desktopRequired,
  cancelProductionShot: desktopRequired,
  selectProductionCandidate: desktopRequired,
  rejectProductionCandidate: desktopRequired,
  onProductionProgress: () => () => undefined,
  getWanGPBenchmark: async (projectId) => ({projectId, entries: []}),
  startWanGPBenchmark: desktopRequired,
  cancelWanGPBenchmark: desktopRequired,
  onWanGPBenchmarkProgress: () => () => undefined,
};

export const desktopService: DesktopApi = window.genVideoDesktop ?? browserFallback;

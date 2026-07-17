import {createHash, randomUUID} from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {app, BrowserWindow, dialog, ipcMain, protocol, shell} from 'electron';
import {
  importAssetPack,
  inspectAssetPack,
  type AssetPackSource,
} from '@gen-video-tool/asset-pack';
import {makeCancelSignal} from '@remotion/renderer';
import {buildProductionRenderData, renderProjectDirectory} from '@gen-video-tool/render-service';
import {
  concatenatePcmWavFiles,
  createLocalF5TtsRuntime,
  padPcmWavFileToDuration,
  prepareLocalF5TtsEnvironment,
  probeWav,
} from '@gen-video-tool/local-tts';
import {
  WanGPProvider,
  WanGPMcpTransport,
  acquireProductionRunLock,
  assertProductionStateMatchesPlan,
  beginProductionNarration,
  beginProductionCandidate,
  buildGeneratedCandidateTechnicalQa,
  buildLocalOnlyWanGPEnvironment,
  completeProductionNarration,
  completeProductionCandidate,
  createProductionState,
  failProductionNarration,
  interruptProductionNarration,
  loadProductionPlan,
  loadProductionState,
  loadProductionStateForRestart,
  inspectProductionRunLock,
  normalizeVideo,
  parseProductionState,
  reviewProductionCandidate,
  raceWithAbortSignal,
  selectProductionCandidate,
  settleCooperativeCancellation,
  writeProductionState,
  type GeneratedPerformanceShot,
  type ProductionCandidateState,
  type ProductionPlan,
  type ProductionRunLockHandle,
  type ProductionState,
  type VideoGenerationJob,
  type VideoGenerationPreset,
  type WanGPMcpClient,
} from '../../../../packages/video-generation/src/index.js';
import type {
  AssetPackSelection,
  ExportProjectResult,
  GenerateProductionShotRequest,
  ProjectImportResponse,
  ProjectPayload,
  ProductionCandidateSnapshot,
  ProductionProgress,
  ProductionProviderSnapshot,
  ProductionShotSnapshot,
  ProductionSnapshot,
  RecentProject,
} from '../shared/desktop-api.js';
import {IPC_CHANNELS} from '../shared/desktop-api.js';
import {createDesktopDiagnostics, diagnosticError} from './desktop-diagnostics.js';
import {createLocalAssetResponse} from './local-asset-response.js';
import {
  diagnosticUrl,
  isTrustedIpcSender,
  isTrustedRendererLocation,
  selectTrustedRenderer,
} from './desktop-security.js';

// Chromium's GPU process can fail to start on some Windows driver/runtime
// combinations. The editor is timeline- and video-preview-heavy, but it does
// not require Chromium GPU compositing to function correctly. Prefer a stable
// software path and keep development state inside the workspace so concurrent
// Electron profiles never contend for the default cache.
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  // Chromium still launches a software GPU helper when hardware acceleration
  // is disabled. On affected Windows/NVIDIA combinations that helper crashes
  // repeatedly inside the GPU sandbox (0xC0000135) and Electron terminates the
  // whole application. Disable only the GPU-process sandbox here; the separate
  // Windows renderer-token compatibility policy is documented below.
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// Some supported Windows hosts (including machines already running inside a
// restricted security token) cannot create Chromium's second restricted
// renderer token. Chromium exits that renderer with SBOX_ERROR_* / code 49 and
// Windows surfaces it as a native 0x80000003 breakpoint dialog before our UI
// can recover. Keep the Windows renderer unsandboxed, while retaining the
// desktop app's actual trust boundaries: no Node integration, isolated preload
// bridge, web security, a strict CSP, and only local application content.
const rendererSandboxEnabled = process.platform !== 'win32';

if (!app.isPackaged) {
  const developmentDataRoot = path.resolve(
    process.env.GEN_VIDEO_DESKTOP_DATA_ROOT?.trim() || path.join(process.cwd(), '.desktop-data'),
  );
  fsSync.mkdirSync(developmentDataRoot, {recursive: true});
  app.setPath('userData', developmentDataRoot);
  app.commandLine.appendSwitch('disk-cache-dir', path.join(developmentDataRoot, 'chromium-cache'));
}

const diagnostics = createDesktopDiagnostics(app.getPath('userData'));
const rendererSelection = selectTrustedRenderer({
  isPackaged: app.isPackaged,
  environmentUrl: process.env.ELECTRON_RENDERER_URL,
  fileRendererUrl: new URL('../renderer/index.html', import.meta.url).toString(),
});
const trustedRenderer = rendererSelection.renderer;

diagnostics.info('main-start', {
  packaged: app.isPackaged,
  platform: process.platform,
  renderer: trustedRenderer.kind,
});
if (rendererSelection.ignoredEnvironmentUrl) {
  diagnostics.warn('renderer-environment-url-ignored', {
    packaged: app.isPackaged,
    reason: app.isPackaged ? 'packaged-build' : 'not-loopback-http',
  });
}
process.on('uncaughtExceptionMonitor', (error) => {
  diagnostics.error('uncaught-exception', diagnosticError(error));
});

protocol.registerSchemesAsPrivileged([
  {scheme: 'gen-video-asset', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true}},
]);

const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));
const selectedSources = new Map<string, AssetPackSource>();
const projectRegistry = new Map<string, {root: string; readOnly: boolean}>();
const activeExports = new Map<string, {cancel: () => void}>();
const trustedWebContentsIds = new Set<number>();

type ManagedProductionProvider = {
  provider: WanGPProvider;
  transport: WanGPMcpClient;
  snapshot: ProductionProviderSnapshot;
};

type ActiveProductionRun = {
  projectId: string;
  shotId: string;
  lock: ProductionRunLockHandle;
  cancelRequested: boolean;
  cancellation: AbortController;
  currentCandidateId?: string;
  currentJobId?: string;
};

type ActiveNarrationRun = {
  controller: AbortController;
  lock: ProductionRunLockHandle;
};

type RuntimeCandidateProgress = {
  providerJobId?: string;
  status: VideoGenerationJob['status'];
  progress: number;
  error?: {code: string; message: string};
};

const productionProviders = new Map<string, ManagedProductionProvider>();
const activeProductionRuns = new Map<string, ActiveProductionRun>();
const activeNarrationRuns = new Map<string, ActiveNarrationRun>();
const productionRuntimeProgress = new Map<string, RuntimeCandidateProgress>();
const productionRecoveryComplete = new Set<string>();
const productionVolatileState = new Map<string, ProductionState>();

const workspaceRoot = (): string => app.isPackaged ? app.getAppPath() : process.cwd();
const projectsRoot = (): string => path.join(app.getPath('userData'), 'projects');
const outputRoot = (projectId: string): string => path.join(app.getPath('userData'), 'output', projectId);

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const requireId = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value;
};

const resolveProjectAsset = (root: string, relativePath: string): string => {
  const target = path.resolve(root, ...relativePath.split('/'));
  if (!isInside(root, target)) throw new Error('PROJECT_ASSET_OUTSIDE_ROOT');
  return target;
};

const assetUrl = (projectId: string, relativePath: string): string =>
  `gen-video-asset://${projectId}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;

const findRemotionTool = (name: 'ffmpeg' | 'ffprobe'): string | null => {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const environment = process.env[`${name.toUpperCase()}_PATH`];
  if (environment && path.isAbsolute(environment) && fsSync.existsSync(environment)) return environment;
  const remotionRoot = path.join(workspaceRoot(), 'node_modules', '@remotion');
  try {
    for (const directory of fsSync.readdirSync(remotionRoot)) {
      if (!directory.startsWith('compositor-')) continue;
      const candidate = path.join(remotionRoot, directory, `${name}${extension}`);
      if (fsSync.existsSync(candidate)) return candidate;
    }
  } catch {
    // Packaged builds may supply the executable through the environment instead.
  }
  const executable = `${name}${extension}`;
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((directory) => path.join(directory, executable))
    .find((candidate) => fsSync.existsSync(candidate)) ?? null;
};

const productionRunKey = (projectId: string, shotId: string): string => `${projectId}:${shotId}`;
const productionCandidateKey = (projectId: string, shotId: string, candidateId: string): string =>
  `${projectId}:${shotId}:${candidateId}`;

const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const safeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown local generation error.';

const sha256File = async (filePath: string): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const wait = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

const WANGP_CANCEL_CONFIRMATION_TIMEOUT_MS = 15_000;

const replaceFileAtomic = async (stagedPath: string, targetPath: string): Promise<void> => {
  await fs.mkdir(path.dirname(targetPath), {recursive: true});
  const backupPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.bak`);
  let backedUp = false;
  try {
    try {
      await fs.rename(targetPath, backupPath);
      backedUp = true;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    await fs.rename(stagedPath, targetPath);
    if (backedUp) await fs.rm(backupPath, {force: true});
  } catch (error) {
    if (backedUp) {
      await fs.rm(targetPath, {force: true});
      await fs.rename(backupPath, targetPath);
    }
    throw error;
  } finally {
    await fs.rm(stagedPath, {force: true});
    await fs.rm(backupPath, {force: true});
  }
};

const srtTimestamp = (seconds: number): string => {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
};

const requireProjectRegistration = async (projectIdValue: unknown) => {
  const projectId = requireId(projectIdValue, 'PROJECT_ID_INVALID');
  if (!projectRegistry.has(projectId)) await refreshProjectRegistry();
  const registration = projectRegistry.get(projectId);
  if (!registration) throw new Error('PROJECT_NOT_REGISTERED');
  return {projectId, registration};
};

type ProductionContext = {
  projectId: string;
  registration: {root: string; readOnly: boolean};
  plan: ProductionPlan;
  state: ProductionState;
};

const loadProductionContext = async (projectIdValue: unknown): Promise<ProductionContext | null> => {
  const {projectId, registration} = await requireProjectRegistration(projectIdValue);
  try {
    await fs.access(path.join(registration.root, 'production.json'));
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  const plan = await loadProductionPlan(registration.root);
  if (plan.projectId !== projectId) throw new Error('PRODUCTION_PROJECT_ID_MISMATCH');

  let state: ProductionState;
  let deferRecovery = false;
  const volatile = productionVolatileState.get(projectId);
  if (volatile) {
    state = volatile;
  } else {
    try {
      if (!productionRecoveryComplete.has(projectId) && !registration.readOnly) {
        state = await loadProductionStateForRestart(registration.root);
        // Keep retrying startup recovery after a live external CLI owner exits.
        // The restart loader itself is lock-safe; this flag only controls whether
        // the desktop considers recovery permanently settled for this session.
        deferRecovery = (await inspectProductionRunLock(registration.root)
          .catch(() => ({status: 'active'} as const))).status === 'active';
      } else {
        state = await loadProductionState(registration.root);
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      state = createProductionState(plan);
      if (registration.readOnly) productionVolatileState.set(projectId, state);
      else await writeProductionState(registration.root, state);
    }
  }
  if (!deferRecovery) productionRecoveryComplete.add(projectId);
  assertProductionStateMatchesPlan(state, plan);
  return {projectId, registration, plan, state};
};

const saveProductionContextState = async (
  context: ProductionContext,
  stateValue: ProductionState,
): Promise<ProductionState> => {
  if (context.registration.readOnly) throw new Error('PROJECT_READ_ONLY');
  const state = await writeProductionState(context.registration.root, stateValue);
  context.state = state;
  return state;
};

const firstExistingFile = (candidates: readonly string[]): string | null =>
  candidates.find((candidate) => {
    try { return fsSync.statSync(candidate).isFile(); } catch { return false; }
  }) ?? null;

const resolveLocalWanGPRoot = (): string => {
  const repositoryRoot = workspaceRoot();
  const userProfile = process.env.USERPROFILE?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const workspaceDriveRoot = path.parse(repositoryRoot).root;
  const candidates = [
    process.env.WANGP_ROOT,
    path.resolve(repositoryRoot, '..', '.research', 'Wan2GP'),
    path.resolve(repositoryRoot, '..', '.tools', 'WanGP'),
    path.resolve(repositoryRoot, '..', 'WanGP'),
    path.resolve(repositoryRoot, 'WanGP'),
    path.join(workspaceDriveRoot, 'WanGP'),
    userProfile ? path.join(userProfile, 'WanGP') : undefined,
    localAppData ? path.join(localAppData, 'WanGP') : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const root = candidates
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => fsSync.existsSync(path.join(candidate, 'wgp.py')));
  if (!root) throw new Error('WANGP_ROOT_NOT_FOUND:set WANGP_ROOT to the absolute path of a WanGP checkout containing wgp.py');
  return root;
};

const assertLoopbackEndpoint = (endpoint: string): string => {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error('WANGP_MCP_URL_INVALID'); }
  const host = parsed.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('WANGP_REMOTE_ENDPOINT_FORBIDDEN:production.json requires offline-only generation');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('WANGP_MCP_URL_INVALID_PROTOCOL');
  return parsed.toString();
};

const createProductionProvider = async (context: ProductionContext): Promise<ManagedProductionProvider> => {
  const endpointValue = process.env.WANGP_MCP_URL?.trim();
  let transport: WanGPMcpClient;
  let transportMode: ProductionProviderSnapshot['transport'];
  let root: string | undefined;
  let pythonExecutable: string | undefined;

  if (endpointValue) {
    const endpoint = assertLoopbackEndpoint(endpointValue);
    transportMode = 'streamable-http';
    transport = new WanGPMcpTransport({
      kind: 'streamable-http',
      endpoint,
      connectTimeoutMs: 60_000,
      requestTimeoutMs: 10 * 60_000,
    });
  } else {
    root = resolveLocalWanGPRoot();
    pythonExecutable = process.env.WANGP_PYTHON?.trim() || firstExistingFile([
      path.join(root, 'env_conda', 'python.exe'),
      path.join(root, 'env_venv', 'Scripts', 'python.exe'),
      path.join(root, '.venv', 'Scripts', 'python.exe'),
      path.join(root, 'venv', 'Scripts', 'python.exe'),
    ]) || undefined;
    if (!pythonExecutable) throw new Error('WANGP_PYTHON_NOT_FOUND:set WANGP_PYTHON or finish the WanGP environment setup');
    transportMode = 'stdio';
    const cacheRoot = path.resolve(
      process.env.WANGP_CACHE_ROOT?.trim() || path.join(workspaceRoot(), '..', '.cache', 'wangp'),
    );
    const rawOutputDirectory = path.join(context.registration.root, 'generated', 'wangp-raw');
    await fs.mkdir(rawOutputDirectory, {recursive: true});
    transport = new WanGPMcpTransport({
      kind: 'stdio',
      wanGpDirectory: root,
      pythonExecutable,
      connectTimeoutMs: 10 * 60_000,
      requestTimeoutMs: 10 * 60_000,
      extraArguments: [
        '--output-dir', rawOutputDirectory,
        '--i2v-1-3B',
        '--profile', process.env.WANGP_PROFILE?.trim() || '5',
        '--attention', process.env.WANGP_ATTENTION?.trim() || 'sdpa',
      ],
      environment: buildLocalOnlyWanGPEnvironment(cacheRoot),
    });
  }

  const provider = new WanGPProvider({
    transport,
    outputDirectory: path.join(context.registration.root, 'generated', 'provider-jobs'),
    preferredModelTypes: {preview: 'fun_inp_1.3B', quality: 'fun_inp_1.3B'},
    callbacks: {
      log: (level, message, details) => console[level === 'debug' ? 'debug' : level](`[wangp] ${message}`, details ?? ''),
    },
  });
  const detection = await provider.detect();
  let presets: VideoGenerationPreset[] = [];
  if (detection.available) {
    try { presets = await provider.listPresets(); }
    catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }
  const snapshot: ProductionProviderSnapshot = {
    id: 'wangp',
    localOnly: true,
    available: detection.available && presets.length > 0,
    checking: false,
    transport: transportMode,
    ...(detection.endpoint === undefined ? {} : {endpoint: detection.endpoint}),
    ...(detection.version === undefined ? {} : {version: detection.version}),
    ...(!detection.available || presets.length === 0
      ? {reason: detection.reason ?? 'WanGP did not expose a compatible local start/end I2V preset.'}
      : detection.reason === undefined ? {} : {reason: detection.reason}),
    ...(root === undefined ? {} : {root}),
    ...(pythonExecutable === undefined ? {} : {pythonExecutable}),
    presets: presets.map((preset) => ({
      id: preset.id,
      label: preset.label,
      qualityTier: preset.qualityTier,
      width: preset.width,
      height: preset.height,
      fps: preset.fps,
      frameCount: preset.frameCount,
    })),
  };
  return {provider, transport, snapshot};
};

const detectProductionProvider = async (context: ProductionContext): Promise<ManagedProductionProvider> => {
  if (activeProductionRuns.size > 0) throw new Error('LOCAL_GENERATION_ALREADY_RUNNING');
  const existing = productionProviders.get(context.projectId);
  if (existing) await existing.transport.close().catch(() => undefined);
  productionProviders.delete(context.projectId);
  const managed = await createProductionProvider(context);
  productionProviders.set(context.projectId, managed);
  return managed;
};

const candidateStatusForSnapshot = (
  projectId: string,
  shotId: string,
  candidate: ProductionCandidateState,
): ProductionCandidateSnapshot['status'] => {
  if (candidate.status === 'queued') return 'planned';
  if (candidate.status === 'generating') {
    return productionRuntimeProgress.get(productionCandidateKey(projectId, shotId, candidate.candidateId))?.status ?? 'running';
  }
  return candidate.status;
};

const shotStatusForSnapshot = (shot: ProductionState['shots'][number]): ProductionShotSnapshot['status'] => {
  if (shot.shotKind === 'layered-collage') return 'not-required';
  if (shot.status === 'queued') return 'ready-to-generate';
  if (shot.status === 'generating') return 'generating';
  if (shot.status === 'awaiting-review' || shot.status === 'complete') return 'awaiting-selection';
  return shot.status;
};

const createProductionSnapshot = async (
  projectIdValue: unknown,
  knownContext?: ProductionContext | null,
): Promise<ProductionSnapshot> => {
  const {projectId, registration} = await requireProjectRegistration(projectIdValue);
  const context = knownContext === undefined ? await loadProductionContext(projectId) : knownContext;
  if (!context) return {projectId, hasPlan: false, readOnly: registration.readOnly, shots: []};
  const shots: ProductionShotSnapshot[] = await Promise.all(context.state.shots.map(async (shotState) => ({
    shotId: shotState.shotId,
    kind: shotState.shotKind,
    status: shotStatusForSnapshot(shotState),
    ...(shotState.selection === undefined ? {} : {selectedCandidateId: shotState.selection.candidateId}),
    candidates: await Promise.all(shotState.candidates.map(async (candidate): Promise<ProductionCandidateSnapshot> => {
      const runtime = productionRuntimeProgress.get(
        productionCandidateKey(projectId, shotState.shotId, candidate.candidateId),
      );
      let videoUrl: string | undefined;
      if (candidate.relativePath) {
        const absolutePath = resolveProjectAsset(registration.root, candidate.relativePath);
        try {
          if ((await fs.stat(absolutePath)).isFile()) videoUrl = assetUrl(projectId, candidate.relativePath);
        } catch {
          // The state remains visible so the missing output can be diagnosed and regenerated.
        }
      }
      const humanDecision = shotState.selection?.candidateId === candidate.candidateId
        ? 'selected' as const
        : candidate.humanDecision?.decision === 'reject' ? 'rejected' as const : 'pending' as const;
      const status = candidateStatusForSnapshot(projectId, shotState.shotId, candidate);
      return {
        candidateId: candidate.candidateId,
        shotId: shotState.shotId,
        seed: candidate.seed,
        status,
        progress: runtime?.progress ?? (status === 'complete' ? 1 : 0),
        ...(runtime?.providerJobId === undefined ? {} : {providerJobId: runtime.providerJobId}),
        ...(videoUrl === undefined ? {} : {videoUrl}),
        ...(candidate.relativePath === undefined ? {} : {relativePath: candidate.relativePath}),
        ...(candidate.sha256 === undefined ? {} : {sha256: candidate.sha256}),
        ...(candidate.technicalQa === undefined ? {} : {
          technicalQa: {
            status: candidate.technicalQa.result === 'pass' ? 'passed' : 'failed',
            checkedAt: candidate.technicalQa.checkedAt,
            issues: [...candidate.technicalQa.issues],
          },
        }),
        humanDecision,
        ...(runtime?.error !== undefined
          ? {error: runtime.error}
          : candidate.error === undefined ? {} : {error: {code: 'GENERATION_FAILED', message: candidate.error}}),
      };
    })),
  })));
  let narrationAudioUrl: string | undefined;
  if (context.state.narration.mergedAudioPath !== undefined) {
    const narrationPath = resolveProjectAsset(
      registration.root,
      context.state.narration.mergedAudioPath,
    );
    try {
      if ((await fs.stat(narrationPath)).isFile()) {
        narrationAudioUrl = assetUrl(projectId, context.state.narration.mergedAudioPath);
      }
    } catch {
      // Keep the persisted status visible; a missing output is regenerated explicitly.
    }
  }
  return {
    projectId,
    hasPlan: true,
    readOnly: registration.readOnly,
    networkPolicy: 'offline-only',
    narration: {
      status: context.state.narration.status,
      engine: 'f5-tts-local',
      segmentCount: context.plan.narration.segments.length,
      ...(context.state.narration.mergedAudioPath === undefined
        ? {}
        : {mergedAudioPath: context.state.narration.mergedAudioPath}),
      ...(narrationAudioUrl === undefined ? {} : {audioUrl: narrationAudioUrl}),
      ...(context.state.narration.durationSeconds === undefined
        ? {}
        : {durationSeconds: context.state.narration.durationSeconds}),
      ...(context.state.narration.speechDurationSeconds === undefined
        ? {}
        : {speechDurationSeconds: context.state.narration.speechDurationSeconds}),
      ...(context.state.narration.tailPaddingSeconds === undefined
        ? {}
        : {tailPaddingSeconds: context.state.narration.tailPaddingSeconds}),
      ...(context.state.narration.sha256 === undefined ? {} : {sha256: context.state.narration.sha256}),
      segments: context.state.narration.segments.map((segment) => ({
        segmentId: segment.segmentId,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        durationSeconds: segment.durationSeconds,
      })),
      ...(context.state.narration.error === undefined ? {} : {error: context.state.narration.error}),
    },
    ...(productionProviders.get(projectId)?.snapshot === undefined
      ? {}
      : {provider: productionProviders.get(projectId)!.snapshot}),
    shots,
    updatedAt: context.state.updatedAt,
  };
};

const emitProductionProgress = async (
  projectId: string,
  shotId: string,
  candidateId?: string,
): Promise<void> => {
  const snapshot = await createProductionSnapshot(projectId);
  const progress: ProductionProgress = {
    projectId,
    shotId,
    snapshot,
    ...(candidateId === undefined ? {} : {candidateId}),
  };
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.productionProgress, progress);
  }
};

const runProductionNarration = async (
  projectId: string,
  active: ActiveNarrationRun,
): Promise<void> => {
  let context = await loadProductionContext(projectId);
  if (!context) throw new Error('PRODUCTION_PLAN_NOT_FOUND');
  const plan = context.plan;
  const segmentPaths: string[] = [];
  const measuredSegments: Array<{
    segmentId: string;
    outputPath: string;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
  }> = [];
  try {
    const ttsEnvironment = await prepareLocalF5TtsEnvironment({
      cacheRoot: path.join(context.registration.root, 'generated', 'cache', 'f5-tts'),
      ffmpegDirectory: path.join(
        process.cwd(),
        'node_modules',
        '@remotion',
        'compositor-win32-x64-msvc',
      ),
      offline: plan.networkPolicy === 'offline-only',
    });
    const runtime = await createLocalF5TtsRuntime({
      compatibility: {mode: 'compat-wrapper'},
      speed: plan.narration.speed,
      device: process.env.F5_TTS_DEVICE ?? 'cuda',
      environment: ttsEnvironment,
      ...(process.env.F5_TTS_MODEL === undefined ? {} : {model: process.env.F5_TTS_MODEL}),
    });
    const referenceAudioPath = resolveProjectAsset(
      context.registration.root,
      plan.narration.referenceAudioPath,
    );
    let cursor = 0;
    for (const segment of plan.narration.segments) {
      if (active.controller.signal.aborted) throw new Error('LOCAL_TTS_ABORTED');
      const outputPath = resolveProjectAsset(context.registration.root, segment.outputPath);
      const result = await runtime.synthesize({
        referenceAudioPath,
        referenceText: plan.narration.referenceText,
        text: segment.text,
        outputPath,
        overwrite: true,
        signal: active.controller.signal,
      });
      const durationSeconds = Number(result.wav.durationSeconds.toFixed(6));
      const startSeconds = Number(cursor.toFixed(6));
      const endSeconds = Number((startSeconds + durationSeconds).toFixed(6));
      segmentPaths.push(outputPath);
      measuredSegments.push({
        segmentId: segment.segmentId,
        outputPath: segment.outputPath,
        startSeconds,
        endSeconds,
        durationSeconds,
      });
      cursor = endSeconds;
    }

    const mergedAudioPath = resolveProjectAsset(context.registration.root, plan.narration.mergedAudioPath);
    await fs.mkdir(path.dirname(mergedAudioPath), {recursive: true});
    const stagedSpeechPath = path.join(
      path.dirname(mergedAudioPath),
      `.${path.basename(mergedAudioPath, '.wav')}.${randomUUID()}.speech.tmp.wav`,
    );
    const timelineDuration = plan.delivery.timeline.durationFrames / plan.delivery.timeline.fps;
    const joined = await concatenatePcmWavFiles(segmentPaths, stagedSpeechPath);
    if (joined.durationSeconds > timelineDuration + 0.02) {
      await fs.rm(stagedSpeechPath, {force: true});
      throw new Error(
        `LOCAL_TTS_DURATION_EXCEEDS_TIMELINE:${joined.durationSeconds.toFixed(3)}>${timelineDuration.toFixed(3)}`,
      );
    }
    const stagedMergedPath = path.join(
      path.dirname(mergedAudioPath),
      `.${path.basename(mergedAudioPath, '.wav')}.${randomUUID()}.padded.tmp.wav`,
    );
    const padded = await padPcmWavFileToDuration(stagedSpeechPath, stagedMergedPath, timelineDuration);
    await fs.rm(stagedSpeechPath, {force: true});
    await replaceFileAtomic(stagedMergedPath, mergedAudioPath);
    const mergedProbe = await probeWav(mergedAudioPath);

    const subtitlePath = resolveProjectAsset(context.registration.root, plan.delivery.subtitles.path);
    const subtitleText = measuredSegments.map((segment, index) => {
      const source = plan.narration.segments.find((item) => item.segmentId === segment.segmentId);
      if (!source) throw new Error(`LOCAL_TTS_SEGMENT_PLAN_MISMATCH:${segment.segmentId}`);
      return `${index + 1}\n${srtTimestamp(segment.startSeconds)} --> ${srtTimestamp(segment.endSeconds)}\n${source.text}`;
    }).join('\n\n') + '\n';
    await fs.mkdir(path.dirname(subtitlePath), {recursive: true});
    const stagedSubtitlePath = path.join(
      path.dirname(subtitlePath),
      `.${path.basename(subtitlePath)}.${randomUUID()}.tmp`,
    );
    await fs.writeFile(stagedSubtitlePath, subtitleText, {encoding: 'utf8', flag: 'wx'});
    await replaceFileAtomic(stagedSubtitlePath, subtitlePath);

    context = await loadProductionContext(projectId);
    if (!context) throw new Error('PRODUCTION_PLAN_NOT_FOUND');
    const finishedAt = new Date().toISOString();
    context.state = await saveProductionContextState(context, completeProductionNarration(context.state, {
      mergedAudioPath: plan.narration.mergedAudioPath,
      sha256: await sha256File(mergedAudioPath),
      durationSeconds: Number(mergedProbe.durationSeconds.toFixed(6)),
      speechDurationSeconds: Number(measuredSegments.at(-1)!.endSeconds.toFixed(6)),
      tailPaddingSeconds: Number(padded.tailPaddingSeconds.toFixed(6)),
      segments: measuredSegments,
      finishedAt,
    }));
  } catch (error) {
    context = await loadProductionContext(projectId);
    if (context) {
      const nextState = active.controller.signal.aborted
        ? interruptProductionNarration(context.state)
        : failProductionNarration(context.state, safeErrorMessage(error));
      context.state = await saveProductionContextState(context, nextState);
    }
  } finally {
    activeNarrationRuns.delete(projectId);
    await active.lock.release();
    await emitProductionProgress(projectId, '__narration__').catch(() => undefined);
  }
};

const startProductionNarration = async (projectIdValue: unknown): Promise<ProductionSnapshot> => {
  const context = await loadProductionContext(projectIdValue);
  if (!context) throw new Error('PRODUCTION_PLAN_NOT_FOUND');
  if (context.registration.readOnly) throw new Error('PROJECT_READ_ONLY');
  if (activeNarrationRuns.has(context.projectId)) throw new Error('LOCAL_TTS_ALREADY_RUNNING');
  if (activeProductionRuns.size > 0) throw new Error('LOCAL_GENERATION_ALREADY_RUNNING');
  const controller = new AbortController();
  const lock = await acquireProductionRunLock(context.registration.root, {kind: 'narration'});
  const active: ActiveNarrationRun = {controller, lock};
  try {
    context.state = await loadProductionState(context.registration.root, {recoverInterrupted: true});
    assertProductionStateMatchesPlan(context.state, context.plan);
    activeNarrationRuns.set(context.projectId, active);
    context.state = await saveProductionContextState(context, beginProductionNarration(context.state));
    void runProductionNarration(context.projectId, active).catch(async (error) => {
      console.error('[production] narration failed before state recovery', error);
      activeNarrationRuns.delete(context.projectId);
      await lock.release();
    });
    const snapshot = await createProductionSnapshot(context.projectId, context);
    await emitProductionProgress(context.projectId, '__narration__');
    return snapshot;
  } catch (error) {
    activeNarrationRuns.delete(context.projectId);
    await lock.release();
    throw error;
  }
};

const resolveGenerationPreset = (
  shot: GeneratedPerformanceShot,
  presets: readonly VideoGenerationPreset[],
): VideoGenerationPreset => {
  const exact = presets.find((preset) => preset.id === shot.generation.preset.id);
  const mapped = exact ?? presets.find((preset) =>
    preset.qualityTier === shot.generation.preset.quality
    && preset.width === shot.generation.raster.width
    && preset.height === shot.generation.raster.height
    && preset.fps === shot.generation.timeline.fps
    && preset.frameCount === shot.generation.timeline.frameCount);
  if (!mapped) throw new Error(`WANGP_PRESET_UNAVAILABLE:${shot.generation.preset.id}`);
  return mapped;
};

const markProductionCandidateInterrupted = (
  stateValue: ProductionState,
  shotId: string,
  candidateId: string,
  interruptedAt = new Date().toISOString(),
): ProductionState => {
  const state = structuredClone(parseProductionState(stateValue));
  const shot = state.shots.find((entry) => entry.shotId === shotId);
  const candidate = shot?.candidates.find((entry) => entry.candidateId === candidateId);
  if (!shot || !candidate) throw new Error('PRODUCTION_STATE_CANDIDATE_NOT_FOUND');
  candidate.status = 'interrupted';
  candidate.interruptedAt = interruptedAt;
  delete candidate.finishedAt;
  delete candidate.error;
  shot.status = 'interrupted';
  shot.interruptedAt = interruptedAt;
  delete shot.selection;
  delete shot.error;
  state.updatedAt = interruptedAt;
  return parseProductionState(state);
};

const markProductionCandidateFailed = (
  stateValue: ProductionState,
  shotId: string,
  candidateId: string,
  message: string,
  failedAt = new Date().toISOString(),
): ProductionState => {
  const state = structuredClone(parseProductionState(stateValue));
  const shot = state.shots.find((entry) => entry.shotId === shotId);
  const candidate = shot?.candidates.find((entry) => entry.candidateId === candidateId);
  if (!shot || !candidate) throw new Error('PRODUCTION_STATE_CANDIDATE_NOT_FOUND');
  candidate.status = 'failed';
  candidate.finishedAt = failedAt;
  candidate.error = message.slice(0, 4_000);
  delete candidate.interruptedAt;
  delete candidate.relativePath;
  delete candidate.sha256;
  delete candidate.technicalQa;
  delete candidate.humanDecision;
  delete shot.selection;
  const complete = shot.candidates.some((entry) => entry.status === 'complete');
  const retryable = shot.candidates.some((entry) => entry.status === 'queued' || entry.status === 'interrupted');
  if (complete) {
    shot.status = 'awaiting-review';
    delete shot.error;
  } else if (retryable) {
    shot.status = 'queued';
    delete shot.error;
  } else {
    shot.status = 'failed';
    shot.error = message.slice(0, 4_000);
  }
  delete shot.interruptedAt;
  state.updatedAt = failedAt;
  return parseProductionState(state);
};

const resetProductionCandidatesForRun = (
  stateValue: ProductionState,
  shotId: string,
): {state: ProductionState; candidateIds: string[]} => {
  const state = structuredClone(parseProductionState(stateValue));
  const shot = state.shots.find((entry) => entry.shotId === shotId);
  if (!shot || shot.shotKind !== 'generated-performance') throw new Error(`PRODUCTION_SHOT_NOT_GENERATED:${shotId}`);
  const retryable = shot.candidates.filter((candidate) =>
    candidate.status !== 'complete'
    || candidate.technicalQa?.result === 'fail'
    || candidate.humanDecision?.decision === 'reject');
  const candidates = retryable.length > 0 ? retryable : shot.candidates;
  for (const candidate of candidates) {
    candidate.status = 'queued';
    delete candidate.startedAt;
    delete candidate.finishedAt;
    delete candidate.interruptedAt;
    delete candidate.relativePath;
    delete candidate.sha256;
    delete candidate.technicalQa;
    delete candidate.humanDecision;
    delete candidate.error;
  }
  shot.status = 'queued';
  delete shot.selection;
  delete shot.interruptedAt;
  delete shot.error;
  state.updatedAt = new Date().toISOString();
  return {state: parseProductionState(state), candidateIds: candidates.map(({candidateId}) => candidateId)};
};

const runProductionShot = async (
  context: ProductionContext,
  shot: GeneratedPerformanceShot,
  candidateIds: readonly string[],
  active: ActiveProductionRun,
): Promise<void> => {
  const managed = productionProviders.get(context.projectId);
  if (!managed?.snapshot.available) throw new Error('WANGP_PROVIDER_NOT_READY');
  const presetResult = await raceWithAbortSignal(managed.provider.listPresets(), active.cancellation.signal);
  if (presetResult.outcome === 'aborted') return;
  const preset = resolveGenerationPreset(shot, presetResult.value);
  let state = context.state;
  for (const candidateId of candidateIds) {
    if (active.cancelRequested) break;
    const candidate = state.shots.find((entry) => entry.shotId === shot.shotId)?.candidates
      .find((entry) => entry.candidateId === candidateId);
    if (!candidate) throw new Error(`PRODUCTION_STATE_CANDIDATE_NOT_FOUND:${candidateId}`);
    active.currentCandidateId = candidateId;
    state = beginProductionCandidate(state, shot.shotId, candidateId);
    state = await saveProductionContextState(context, state);
    productionRuntimeProgress.set(productionCandidateKey(context.projectId, shot.shotId, candidateId), {
      status: 'queued',
      progress: 0,
    });
    await emitProductionProgress(context.projectId, shot.shotId, candidateId);

    try {
      const submissionPromise = managed.provider.submit({
        projectId: context.projectId,
        shotId: shot.shotId,
        keyframePath: resolveProjectAsset(
          context.registration.root,
          shot.generation.conditioning.startKeyframePath,
        ),
        ...(shot.generation.conditioning.mode === 'start-end'
          ? {
              endKeyframePath: resolveProjectAsset(
                context.registration.root,
                shot.generation.conditioning.endKeyframePath,
              ),
            }
          : {}),
        prompt: shot.hybridMotion.actor.prompt,
        negativePrompt: shot.hybridMotion.actor.negativePrompt,
        width: preset.width,
        height: preset.height,
        fps: preset.fps,
        frameCount: preset.frameCount,
        seed: candidate.seed,
        motionStrength: shot.generation.preset.motionStrength,
        presetId: preset.id,
      });
      const submission = await raceWithAbortSignal(submissionPromise, active.cancellation.signal);
      if (submission.outcome === 'aborted') {
        // A late provider response must not keep the run lock hostage. If it
        // eventually exposes a job id, request cancellation in the background.
        void submissionPromise.then(async (lateJob) => {
          await managed.provider.cancel(lateJob.id).catch(() => undefined);
        }).catch(() => undefined);
        state = markProductionCandidateInterrupted(state, shot.shotId, candidateId);
        state = await saveProductionContextState(context, state);
        productionRuntimeProgress.set(
          productionCandidateKey(context.projectId, shot.shotId, candidateId),
          {
            status: 'preparing',
            progress: 0,
            error: {
              code: 'RUN_INTERRUPTED',
              message: 'Generation was interrupted before WanGP returned a job identifier.',
            },
          },
        );
        break;
      }
      let job = submission.value;
      active.currentJobId = job.id;
      const runtimeKey = productionCandidateKey(context.projectId, shot.shotId, candidateId);
      const updateRuntime = async (current: VideoGenerationJob): Promise<void> => {
        productionRuntimeProgress.set(runtimeKey, {
          providerJobId: current.id,
          status: current.status,
          progress: current.progress,
          ...(current.error === undefined ? {} : {error: {code: current.error.code, message: current.error.message}}),
        });
        await emitProductionProgress(context.projectId, shot.shotId, candidateId);
      };
      await updateRuntime(job);
      while (!['complete', 'failed', 'cancelled'].includes(job.status)) {
        if (active.cancelRequested) {
          const cancellation = await settleCooperativeCancellation({
            initialValue: job,
            requestCancel: async () => managed.provider.cancel(job.id),
            readStatus: async () => managed.provider.status(job.id),
            isTerminal: (current) => ['complete', 'failed', 'cancelled'].includes(current.status),
            onStatus: updateRuntime,
            timeoutMs: WANGP_CANCEL_CONFIRMATION_TIMEOUT_MS,
            pollIntervalMs: 500,
          });
          job = cancellation.value;
          if (cancellation.outcome === 'terminal') {
            await updateRuntime(job);
          } else {
            productionRuntimeProgress.set(runtimeKey, {
              providerJobId: job.id,
              status: job.status,
              progress: job.progress,
              error: {
                code: 'CANCEL_CONFIRMATION_TIMEOUT',
                message: `WanGP did not confirm cancellation within ${WANGP_CANCEL_CONFIRMATION_TIMEOUT_MS / 1_000} seconds. The local run was interrupted and its lock released.`,
              },
            });
          }
          break;
        }
        const delay = await raceWithAbortSignal(wait(1_500), active.cancellation.signal);
        if (delay.outcome === 'aborted') continue;
        const status = await raceWithAbortSignal(managed.provider.status(job.id), active.cancellation.signal);
        if (status.outcome === 'aborted') continue;
        job = status.value;
        await updateRuntime(job);
      }
      if (active.cancelRequested || job.status === 'cancelled') {
        state = markProductionCandidateInterrupted(state, shot.shotId, candidateId);
        state = await saveProductionContextState(context, state);
        break;
      }
      if (job.status !== 'complete' || !job.outputPath) {
        throw new Error(`${job.error?.code ?? job.status}:${job.error?.message ?? 'WanGP did not return a video.'}`);
      }

      const candidateDirectory = path.join(context.registration.root, 'generated', 'video', shot.shotId);
      await fs.mkdir(candidateDirectory, {recursive: true});
      const outputPath = path.join(
        candidateDirectory,
        `${candidateId}-${Date.now()}-${randomUUID().slice(0, 8)}.mp4`,
      );
      const normalizationPromise = normalizeVideo({
        sourcePath: job.outputPath,
        outputPath,
        outputRoot: candidateDirectory,
        targetFps: shot.generation.timeline.fps,
        durationSeconds: shot.generation.timeline.frameCount / shot.generation.timeline.fps,
      });
      const normalization = await raceWithAbortSignal(normalizationPromise, active.cancellation.signal);
      if (normalization.outcome === 'aborted') {
        void normalizationPromise.then(async () => {
          await fs.rm(outputPath, {force: true});
        }).catch(() => undefined);
        state = markProductionCandidateInterrupted(state, shot.shotId, candidateId);
        state = await saveProductionContextState(context, state);
        productionRuntimeProgress.set(runtimeKey, {
          providerJobId: job.id,
          status: job.status,
          progress: job.progress,
          error: {
            code: 'RUN_INTERRUPTED',
            message: 'Generation was interrupted while normalizing the WanGP result.',
          },
        });
        break;
      }
      const normalized = normalization.value;
      const probe = normalized.output;
      const relativePath = path.relative(context.registration.root, outputPath).split(path.sep).join('/');
      if (relativePath.startsWith('../') || path.isAbsolute(relativePath)) throw new Error('PRODUCTION_OUTPUT_OUTSIDE_PROJECT');
      const checkedAt = new Date().toISOString();
      const technicalQa = buildGeneratedCandidateTechnicalQa(shot, probe, checkedAt);
      state = completeProductionCandidate(state, shot.shotId, candidateId, {
        relativePath,
        sha256: await sha256File(outputPath),
        technicalQa,
        finishedAt: checkedAt,
      });
      state = await saveProductionContextState(context, state);
      productionRuntimeProgress.delete(runtimeKey);
    } catch (error) {
      const message = safeErrorMessage(error);
      if (active.cancelRequested) state = markProductionCandidateInterrupted(state, shot.shotId, candidateId);
      else state = markProductionCandidateFailed(state, shot.shotId, candidateId, message);
      state = await saveProductionContextState(context, state);
      const runtimeKey = productionCandidateKey(context.projectId, shot.shotId, candidateId);
      const previousRuntime = productionRuntimeProgress.get(runtimeKey);
      productionRuntimeProgress.set(runtimeKey, {
        status: active.cancelRequested ? previousRuntime?.status ?? 'running' : 'failed',
        progress: previousRuntime?.progress ?? 0,
        error: {code: active.cancelRequested ? 'RUN_INTERRUPTED' : 'JOB_FAILED', message},
      });
      if (active.cancelRequested) break;
    } finally {
      delete active.currentCandidateId;
      delete active.currentJobId;
      await emitProductionProgress(context.projectId, shot.shotId, candidateId);
    }
  }
};

const startProductionShot = async (requestValue: unknown): Promise<ProductionSnapshot> => {
  if (!requestValue || typeof requestValue !== 'object') throw new Error('PRODUCTION_REQUEST_INVALID');
  const request = requestValue as Partial<GenerateProductionShotRequest>;
  const context = await loadProductionContext(request.projectId);
  if (!context) throw new Error('PRODUCTION_PLAN_NOT_FOUND');
  if (context.registration.readOnly) throw new Error('PROJECT_READ_ONLY');
  const shotId = requireId(request.shotId, 'SHOT_ID_INVALID');
  const shot = context.plan.shots.find((entry) => entry.shotId === shotId);
  if (!shot || shot.kind !== 'generated-performance') throw new Error('PRODUCTION_SHOT_NOT_GENERATED');
  if (activeNarrationRuns.size > 0) throw new Error('LOCAL_TTS_ALREADY_RUNNING');
  if (activeProductionRuns.size > 0) throw new Error('LOCAL_GENERATION_ALREADY_RUNNING');
  const managed = productionProviders.get(context.projectId);
  if (!managed?.snapshot.available) throw new Error('WANGP_PROVIDER_NOT_READY:run local provider detection first');

  const lock = await acquireProductionRunLock(context.registration.root, {kind: 'generation'});
  try {
    context.state = await loadProductionState(context.registration.root, {recoverInterrupted: true});
    assertProductionStateMatchesPlan(context.state, context.plan);
    const reset = resetProductionCandidatesForRun(context.state, shotId);
    if (reset.candidateIds.length === 0) throw new Error('PRODUCTION_NO_CANDIDATE_TO_GENERATE');
    context.state = await saveProductionContextState(context, reset.state);
    const active: ActiveProductionRun = {
      projectId: context.projectId,
      shotId,
      lock,
      cancelRequested: false,
      cancellation: new AbortController(),
    };
    const key = productionRunKey(context.projectId, shotId);
    activeProductionRuns.set(key, active);
    void runProductionShot(context, shot, reset.candidateIds, active)
      .catch(async (error) => {
        console.error('[production] shot generation failed', error);
        await emitProductionProgress(context.projectId, shotId).catch(() => undefined);
      })
      .finally(async () => {
        activeProductionRuns.delete(key);
        await active.lock.release();
      });
    return createProductionSnapshot(context.projectId, context);
  } catch (error) {
    await lock.release();
    throw error;
  }
};

const refreshProjectRegistry = async (): Promise<void> => {
  projectRegistry.clear();
  const registerChildren = async (root: string, readOnly: boolean) => {
    try {
      for (const entry of await fs.readdir(root, {withFileTypes: true})) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name);
        try {
          const plan = await loadProductionPlan(candidate);
          projectRegistry.set(plan.projectId, {root: candidate, readOnly});
        } catch {
          // Non-project directories are intentionally ignored.
        }
      }
    } catch {
      // First launch may not have either root yet.
    }
  };
  await fs.mkdir(projectsRoot(), {recursive: true});
  await registerChildren(projectsRoot(), false);
};

const projectPayload = async (projectId: string): Promise<ProjectPayload> => {
  const context = await loadProductionContext(projectId);
  if (!context) throw new Error('PRODUCTION_PLAN_NOT_FOUND');
  let renderData: ProjectPayload['renderData'];
  let renderGate: ProjectPayload['renderGate'];
  try {
    renderData = buildProductionRenderData(context.plan, context.state);
    if (context.state.narration.status !== 'complete') delete renderData.narrationPath;
  } catch (error) {
    // An incomplete production stays inspectable, but is never represented as
    // a finished static video. The renderer shows its declared keyframe and
    // production-state gate until every generated shot is explicitly selected.
    const message = safeErrorMessage(error);
    renderGate = {code: message.split(':', 1)[0] || 'PRODUCTION_PREVIEW_GATED', message};
  }
  return {
    plan: context.plan,
    state: context.state,
    ...(renderData === undefined ? {} : {renderData}),
    ...(renderGate === undefined ? {} : {renderGate}),
    assetBase: `gen-video-asset://${projectId}`,
    readOnly: context.registration.readOnly,
  };
};

const recentProject = async (projectId: string): Promise<RecentProject> => {
  const registration = projectRegistry.get(projectId);
  if (!registration) throw new Error('PROJECT_NOT_REGISTERED');
  const plan = await loadProductionPlan(registration.root);
  const stat = await fs.stat(path.join(registration.root, 'production.json'));
  const state = await loadProductionContext(projectId).catch(() => null);
  const generatedShots = state?.state.shots.filter((shot) => shot.shotKind === 'generated-performance') ?? [];
  const hasFailure = generatedShots.some((shot) => shot.status === 'failed');
  const allSelected = generatedShots.every((shot) => shot.status === 'selected');
  const narrationReady = state?.state.narration.status === 'complete';
  return {
    id: projectId,
    name: plan.metadata.title,
    locale: plan.metadata.locale,
    updatedAt: stat.mtime.toISOString(),
    durationSeconds: plan.delivery.timeline.durationFrames / plan.delivery.timeline.fps,
    shotCount: plan.shots.length,
    aspectRatio: '9:16',
    status: hasFailure ? 'needs-attention' : allSelected && narrationReady ? 'ready' : 'draft',
    readOnly: registration.readOnly,
  };
};

const createWindow = (): void => {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    show: true,
    backgroundColor: '#242528',
    title: 'Gen Video Tool',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: rendererSandboxEnabled,
      webSecurity: true,
    },
  });
  const webContentsId = window.webContents.id;
  trustedWebContentsIds.add(webContentsId);
  window.webContents.once('destroyed', () => {
    trustedWebContentsIds.delete(webContentsId);
  });
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (isTrustedRendererLocation(navigationUrl, trustedRenderer)) return;
    event.preventDefault();
    diagnostics.warn('navigation-denied', {url: diagnosticUrl(navigationUrl)});
  });
  window.webContents.setWindowOpenHandler(({url}) => {
    diagnostics.warn('window-open-denied', {url: diagnosticUrl(url)});
    return {action: 'deny'};
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[desktop] renderer process exited', details);
    diagnostics.error('render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  window.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    console.error('[desktop] renderer failed to load', {code, description, validatedUrl});
    diagnostics.error('renderer-load-failed', {
      code,
      description: description.slice(0, 500),
      url: diagnosticUrl(validatedUrl),
    });
  });
  const loadRenderer = trustedRenderer.kind === 'loopback-url'
    ? window.loadURL(trustedRenderer.entryUrl)
    : window.loadFile(trustedRenderer.filePath);
  void loadRenderer.catch((error) => {
    diagnostics.error('renderer-load-rejected', diagnosticError(error));
  });
};

const selectionSource = (handle: unknown): AssetPackSource => {
  if (typeof handle !== 'string') throw new Error('ASSET_HANDLE_INVALID');
  const source = selectedSources.get(handle);
  if (!source) throw new Error('ASSET_HANDLE_EXPIRED');
  return source;
};

type IpcMainHandler = Parameters<typeof ipcMain.handle>[1];

const handleTrustedIpc = (channel: string, listener: IpcMainHandler): void => {
  ipcMain.handle(channel, async (event, ...args) => {
    const senderFrame = event.senderFrame;
    let isMainFrame = false;
    try {
      isMainFrame = Boolean(senderFrame) && senderFrame?.top === senderFrame;
    } catch {
      // A disposed frame is never a trusted sender.
    }
    const senderUrl = senderFrame?.url;
    if (
      !trustedWebContentsIds.has(event.sender.id)
      || !isTrustedIpcSender(senderUrl, isMainFrame, trustedRenderer)
    ) {
      diagnostics.warn('ipc-sender-denied', {
        channel,
        mainFrame: isMainFrame,
        url: senderUrl ? diagnosticUrl(senderUrl) : 'missing',
      });
      throw new Error('IPC_SENDER_NOT_TRUSTED');
    }
    return await listener(event, ...args);
  });
};

const registerIpc = (): void => {
  handleTrustedIpc(IPC_CHANNELS.selectAssetPack, async (): Promise<AssetPackSelection | null> => {
    const sourceChoice = await dialog.showMessageBox({
      type: 'question', title: '导入资产包', message: '选择资产包来源',
      detail: '可以导入 ChatGPT 生成的 ZIP，或已经解压的项目目录。',
      buttons: ['选择 ZIP', '选择项目目录', '取消'], defaultId: 0, cancelId: 2, noLink: true,
    });
    if (sourceChoice.response === 2) return null;
    const selectDirectory = sourceChoice.response === 1;
    const result = await dialog.showOpenDialog({
      title: '导入资产包', buttonLabel: '检查资产包',
      properties: selectDirectory ? ['openDirectory'] : ['openFile'],
      ...(selectDirectory ? {} : {filters: [{name: 'ChatGPT 资产包', extensions: ['zip']}]}),
    });
    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) return null;
    const source: AssetPackSource = {kind: selectDirectory ? 'directory' : 'zip', path: selectedPath};
    const handle = randomUUID();
    selectedSources.set(handle, source);
    return {handle, kind: source.kind, displayPath: selectedPath, name: path.basename(selectedPath)};
  });

  handleTrustedIpc(IPC_CHANNELS.inspectAssetPack, async (_event, handle: unknown) =>
    inspectAssetPack({source: selectionSource(handle)}));

  handleTrustedIpc(IPC_CHANNELS.importAssetPack, async (_event, handle: unknown): Promise<ProjectImportResponse> => {
    const source = selectionSource(handle);
    const result = await importAssetPack({source, projectsRoot: projectsRoot()});
    if (result.status !== 'committed' || !result.projectPath || !result.projectId) {
      return {inspection: {...result, status: 'rejected'}, project: null};
    }
    const priorProvider = productionProviders.get(result.projectId);
    if (priorProvider) await priorProvider.transport.close().catch(() => undefined);
    productionProviders.delete(result.projectId);
    projectRegistry.set(result.projectId, {root: result.projectPath, readOnly: false});
    productionRecoveryComplete.delete(result.projectId);
    productionVolatileState.delete(result.projectId);
    activeNarrationRuns.get(result.projectId)?.controller.abort();
    activeNarrationRuns.delete(result.projectId);
    selectedSources.delete(String(handle));
    return {inspection: {...result, status: 'ready'}, project: await projectPayload(result.projectId)};
  });

  handleTrustedIpc(IPC_CHANNELS.listRecentProjects, async (): Promise<RecentProject[]> => {
    await refreshProjectRegistry();
    const recent = await Promise.all([...projectRegistry.keys()].map(recentProject));
    return recent.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  });

  handleTrustedIpc(IPC_CHANNELS.openProject, async (_event, projectId: unknown): Promise<ProjectPayload> => {
    if (typeof projectId !== 'string') throw new Error('PROJECT_ID_INVALID');
    if (!projectRegistry.has(projectId)) await refreshProjectRegistry();
    return projectPayload(projectId);
  });

  handleTrustedIpc(IPC_CHANNELS.deleteProject, async (_event, projectId: unknown): Promise<void> => {
    if (typeof projectId !== 'string') throw new Error('PROJECT_ID_INVALID');
    const registration = projectRegistry.get(projectId);
    if (!registration) throw new Error('PROJECT_NOT_REGISTERED');
    if (registration.readOnly) throw new Error('PROJECT_READ_ONLY');
    if ([...activeProductionRuns.values()].some((run) => run.projectId === projectId)) {
      throw new Error('PROJECT_HAS_ACTIVE_GENERATION');
    }
    if (activeNarrationRuns.has(projectId)) throw new Error('PROJECT_HAS_ACTIVE_NARRATION');
    const deleteLock = await acquireProductionRunLock(registration.root, {kind: 'review'});
    try {
      const root = path.resolve(projectsRoot());
      const target = path.resolve(registration.root);
      if (target === root || !isInside(root, target)) throw new Error('PROJECT_DELETE_OUTSIDE_ROOT');
      const managed = productionProviders.get(projectId);
      if (managed) await managed.transport.close().catch(() => undefined);
      productionProviders.delete(projectId);
      await fs.rm(target, {recursive: true, force: false});
      productionRecoveryComplete.delete(projectId);
      productionVolatileState.delete(projectId);
      for (const key of productionRuntimeProgress.keys()) {
        if (key.startsWith(`${projectId}:`)) productionRuntimeProgress.delete(key);
      }
      projectRegistry.delete(projectId);
    } finally {
      await deleteLock.release();
    }
  });

  handleTrustedIpc(IPC_CHANNELS.exportProject, async (event, projectId: unknown): Promise<ExportProjectResult> => {
    if (typeof projectId !== 'string') throw new Error('PROJECT_ID_INVALID');
    const registration = projectRegistry.get(projectId);
    if (!registration) throw new Error('PROJECT_NOT_REGISTERED');
    if (activeNarrationRuns.has(projectId)) throw new Error('LOCAL_TTS_STILL_RUNNING');
    if (activeExports.has(projectId)) throw new Error('EXPORT_ALREADY_RUNNING');
    const renderLock = await acquireProductionRunLock(registration.root, {kind: 'render'});
    const cancellation = makeCancelSignal();
    activeExports.set(projectId, {cancel: cancellation.cancel});
    try {
      const result = await renderProjectDirectory({
        projectRoot: registration.root,
        outputRoot: outputRoot(projectId),
        workspaceRoot: workspaceRoot(),
        cancelSignal: cancellation.cancelSignal,
        onProgress: (phase, progress) => event.sender.send(IPC_CHANNELS.exportProgress, {projectId, phase, progress}),
      });
      return {
        videoName: path.basename(result.videoPath),
        subtitlesName: result.subtitlesPath ? path.basename(result.subtitlesPath) : null,
        qaFrameCount: result.qaFramePaths.length,
        durationSeconds: result.durationSeconds,
      };
    } finally {
      activeExports.delete(projectId);
      await renderLock.release();
    }
  });

  handleTrustedIpc(IPC_CHANNELS.cancelExport, async (_event, projectId: unknown): Promise<void> => {
    if (typeof projectId !== 'string') throw new Error('PROJECT_ID_INVALID');
    activeExports.get(projectId)?.cancel();
  });

  handleTrustedIpc(IPC_CHANNELS.revealOutput, async (_event, projectId: unknown): Promise<void> => {
    if (typeof projectId !== 'string' || !projectRegistry.has(projectId)) throw new Error('PROJECT_ID_INVALID');
    await fs.mkdir(outputRoot(projectId), {recursive: true});
    await shell.openPath(outputRoot(projectId));
  });

  handleTrustedIpc(
    IPC_CHANNELS.getProductionSnapshot,
    async (_event, projectId: unknown): Promise<ProductionSnapshot> => createProductionSnapshot(projectId),
  );

  handleTrustedIpc(
    IPC_CHANNELS.detectProductionProvider,
    async (_event, projectId: unknown): Promise<ProductionSnapshot> => {
      const context = await loadProductionContext(projectId);
      if (!context) return createProductionSnapshot(projectId, null);
      await detectProductionProvider(context);
      return createProductionSnapshot(context.projectId, context);
    },
  );

  handleTrustedIpc(
    IPC_CHANNELS.synthesizeProductionNarration,
    async (_event, projectId: unknown): Promise<ProductionSnapshot> => startProductionNarration(projectId),
  );

  handleTrustedIpc(
    IPC_CHANNELS.cancelProductionNarration,
    async (_event, projectIdValue: unknown): Promise<ProductionSnapshot> => {
      const context = await loadProductionContext(projectIdValue);
      if (!context) throw new Error('PRODUCTION_PLAN_NOT_FOUND');
      if (context.registration.readOnly) throw new Error('PROJECT_READ_ONLY');
      activeNarrationRuns.get(context.projectId)?.controller.abort();
      return createProductionSnapshot(context.projectId);
    },
  );

  handleTrustedIpc(
    IPC_CHANNELS.generateProductionShot,
    async (_event, request: unknown): Promise<ProductionSnapshot> => startProductionShot(request),
  );

  handleTrustedIpc(
    IPC_CHANNELS.cancelProductionShot,
    async (_event, projectIdValue: unknown, shotIdValue: unknown): Promise<ProductionSnapshot> => {
      const context = await loadProductionContext(projectIdValue);
      if (!context) throw new Error('PRODUCTION_PLAN_NOT_FOUND');
      if (context.registration.readOnly) throw new Error('PROJECT_READ_ONLY');
      const shotId = requireId(shotIdValue, 'SHOT_ID_INVALID');
      const active = activeProductionRuns.get(productionRunKey(context.projectId, shotId));
      if (!active) return createProductionSnapshot(context.projectId, context);
      active.cancelRequested = true;
      active.cancellation.abort();
      return createProductionSnapshot(context.projectId);
    },
  );

  handleTrustedIpc(
    IPC_CHANNELS.selectProductionCandidate,
    async (
      _event,
      projectIdValue: unknown,
      shotIdValue: unknown,
      candidateIdValue: unknown,
    ): Promise<ProductionSnapshot> => {
      const context = await loadProductionContext(projectIdValue);
      if (!context) throw new Error('PRODUCTION_PLAN_NOT_FOUND');
      if (context.registration.readOnly) throw new Error('PROJECT_READ_ONLY');
      const shotId = requireId(shotIdValue, 'SHOT_ID_INVALID');
      const candidateId = requireId(candidateIdValue, 'CANDIDATE_ID_INVALID');
      if (activeProductionRuns.has(productionRunKey(context.projectId, shotId))) {
        throw new Error('PRODUCTION_SHOT_STILL_GENERATING');
      }
      const lock = await acquireProductionRunLock(context.registration.root, {kind: 'review'});
      try {
        context.state = await loadProductionState(context.registration.root, {recoverInterrupted: true});
        assertProductionStateMatchesPlan(context.state, context.plan);
        const reviewedAt = new Date().toISOString();
        const reviewed = reviewProductionCandidate(context.state, shotId, candidateId, {
          decision: 'accept',
          reviewedAt,
        });
        const selected = selectProductionCandidate(reviewed, shotId, candidateId, reviewedAt);
        context.state = await saveProductionContextState(context, selected);
        const snapshot = await createProductionSnapshot(context.projectId, context);
        await emitProductionProgress(context.projectId, shotId, candidateId);
        return snapshot;
      } finally {
        await lock.release();
      }
    },
  );

  handleTrustedIpc(
    IPC_CHANNELS.rejectProductionCandidate,
    async (
      _event,
      projectIdValue: unknown,
      shotIdValue: unknown,
      candidateIdValue: unknown,
    ): Promise<ProductionSnapshot> => {
      const context = await loadProductionContext(projectIdValue);
      if (!context) throw new Error('PRODUCTION_PLAN_NOT_FOUND');
      if (context.registration.readOnly) throw new Error('PROJECT_READ_ONLY');
      const shotId = requireId(shotIdValue, 'SHOT_ID_INVALID');
      const candidateId = requireId(candidateIdValue, 'CANDIDATE_ID_INVALID');
      if (activeProductionRuns.has(productionRunKey(context.projectId, shotId))) {
        throw new Error('PRODUCTION_SHOT_STILL_GENERATING');
      }
      const lock = await acquireProductionRunLock(context.registration.root, {kind: 'review'});
      try {
        context.state = await loadProductionState(context.registration.root, {recoverInterrupted: true});
        assertProductionStateMatchesPlan(context.state, context.plan);
        context.state = await saveProductionContextState(context, reviewProductionCandidate(
          context.state,
          shotId,
          candidateId,
          {decision: 'reject', reviewedAt: new Date().toISOString()},
        ));
        const snapshot = await createProductionSnapshot(context.projectId, context);
        await emitProductionProgress(context.projectId, shotId, candidateId);
        return snapshot;
      } finally {
        await lock.release();
      }
    },
  );
};

const primaryInstance = app.requestSingleInstanceLock();

if (!primaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  void app.whenReady().then(async () => {
    await refreshProjectRegistry();
    protocol.handle('gen-video-asset', async (request) => {
      const url = new URL(request.url);
      const projectId = url.hostname;
      const registration = projectRegistry.get(projectId);
      if (!registration) return new Response('Project not found', {status: 404});
      let relativePath = '';
      try { relativePath = decodeURIComponent(url.pathname.slice(1)); } catch { return new Response('Invalid path', {status: 400}); }
      if (!relativePath || relativePath.includes('\\') || relativePath.split('/').some((segment) => segment === '..' || segment === '')) {
        return new Response('Invalid path', {status: 400});
      }
      const target = path.resolve(registration.root, ...relativePath.split('/'));
      if (!isInside(registration.root, target)) return new Response('Forbidden', {status: 403});
      return await createLocalAssetResponse(target, request);
    });
    registerIpc();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  for (const active of activeProductionRuns.values()) {
    active.cancelRequested = true;
    active.cancellation.abort();
  }
  for (const active of activeNarrationRuns.values()) active.controller.abort();
  for (const managed of productionProviders.values()) void managed.transport.close().catch(() => undefined);
});

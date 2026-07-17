import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  cloneVideoGenerationJob,
  VideoProviderError,
  type VideoGenerationInput,
  type VideoGenerationJob,
  type VideoGenerationPreset,
  type VideoGenerationProvider,
  type VideoGenerationProviderCallbacks,
  type VideoGenerationStatus,
  type VideoProviderDetection,
  type VideoProviderErrorCode,
} from './provider.js';
import {
  WanGPMcpError,
  type WanGPMcpClient,
  type WanGPMcpTool,
} from './wangp-transport.js';
import {
  applyWanGPCachePolicy,
  buildWanGPAcceleratorProfile,
  buildWanGPCapabilityCatalog,
  buildWanGPModelCapability,
  resolveWanGPCachePolicy,
  type WanGPAcceleratorProfile,
  type WanGPAcceleratorProfileSource,
  type WanGPCapabilityCatalog,
  type WanGPModelCapability,
  type WanGPTierSelection,
} from './wangp-capabilities.js';
import {WanGPTelemetryTracker} from './wangp-telemetry.js';

type UnknownRecord = Record<string, unknown>;

type ModelAvailability = 'available' | 'partial' | 'missing' | 'unknown';

type InternalModel = {
  modelType: string;
  label: string;
  availability: ModelAvailability;
  raw: UnknownRecord;
  metadata?: UnknownRecord;
  defaultSettings?: UnknownRecord;
  schema?: UnknownRecord;
};

type InternalPreset = {
  publicPreset: VideoGenerationPreset;
  model: InternalModel;
  modelCapability: WanGPModelCapability;
  profile?: WanGPAcceleratorProfile;
  tier: WanGPTierSelection;
};

type StagedKeyframes = {
  start: string;
  end?: string;
};

type WanGPEvent = {
  kind: string;
  timestamp?: number | string;
  data?: unknown;
};

type WanGPResult = {
  success: boolean;
  cancelled: boolean;
  generatedFiles: string[];
  artifacts: UnknownRecord[];
  errors: string[];
};

type WanGPJobSnapshot = {
  jobId: string;
  done: boolean;
  cancelRequested: boolean;
  events: WanGPEvent[];
  result?: WanGPResult;
};

type InternalJob = {
  publicJob: VideoGenerationJob;
  input: VideoGenerationInput;
  preset: InternalPreset;
  workDirectory: string;
  telemetry: WanGPTelemetryTracker;
  backendJobId?: string;
};

export type WanGPProviderOptions = {
  transport: WanGPMcpClient;
  /** App-owned directory where verified results and ASCII-safe staging files live. */
  outputDirectory: string;
  /** @deprecated Dynamic metadata matching is used; retained for source compatibility. */
  preferredModelTypes?: Partial<Record<'preview' | 'quality', string>>;
  /** Reads only profile directories advertised by WanGP MCP model schemas. */
  profileSource?: (directories: readonly string[]) => Promise<WanGPAcceleratorProfileSource[]>;
  callbacks?: VideoGenerationProviderCallbacks;
};

export type WanGPSubmitOptions = {
  configurationId?: string;
  modelRuntimeId?: string;
  acceleratorProfileId?: string;
};

const REQUIRED_TOOLS = [
  'wangp_list_models',
  'wangp_get_model_metadata',
  'wangp_get_model_availability',
  'wangp_get_default_settings',
  'wangp_get_model_schema',
  'wangp_generate',
  'wangp_get_job',
  'wangp_cancel_job',
] as const;

const LEGACY_FAST_PRESET_ID = 'local-i2v-fast-portrait';
const LEGACY_QUALITY_PRESET_ID = 'local-i2v-quality-portrait';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function availabilityFrom(value: unknown): ModelAvailability {
  if (typeof value === 'string') {
    const status = value.toLowerCase();
    if (status === 'available' || status === 'partial' || status === 'missing') {
      return status;
    }
  }
  if (isRecord(value)) {
    const direct = availabilityFrom(
      value.status ?? value.state ?? value.model_status ?? value.availability,
    );
    if (direct !== 'unknown') {
      return direct;
    }
    if (value.available === true || value.is_available === true || value.installed === true) {
      return 'available';
    }
    if (value.available === false || value.is_available === false || value.installed === false) {
      return 'missing';
    }
  }
  return 'unknown';
}

function modelArray(result: unknown): UnknownRecord[] {
  if (Array.isArray(result)) {
    return result.filter(isRecord);
  }
  if (!isRecord(result)) {
    return [];
  }
  for (const key of ['models', 'items', 'model_defs']) {
    const value = result[key];
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }
  }
  return [];
}

function profileArray(result: unknown): UnknownRecord[] {
  if (Array.isArray(result)) return result.filter(isRecord);
  if (!isRecord(result)) return [];
  for (const key of ['profiles', 'accelerator_profiles', 'items']) {
    const value = result[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function profileSourceFromRecord(value: UnknownRecord): WanGPAcceleratorProfileSource | null {
  const settings = isRecord(value.settings) ? value.settings : value;
  const directory = asString(value.directory ?? value.profile_directory ?? value.profiles_dir);
  const label = asString(value.label ?? value.name ?? value.title);
  const relativePath = asString(value.relative_path ?? value.relativePath ?? value.path);
  if (!directory || !label || !relativePath) return null;
  return {directory, label, relativePath, settings, source: 'mcp'};
}

function unwrapRecord(result: unknown, preferredKeys: readonly string[]): UnknownRecord {
  if (!isRecord(result)) {
    return {};
  }
  for (const key of preferredKeys) {
    if (isRecord(result[key])) {
      return result[key];
    }
  }
  return result;
}

function sanitizePathPart(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  return safe.slice(0, 64) || 'item';
}

function isTerminal(status: VideoGenerationStatus): boolean {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}

function modelSupportsEndKeyframe(model: InternalModel): boolean {
  let supported = false;
  const visit = (value: unknown, keyPath = ''): void => {
    if (supported) return;
    const normalizedPath = keyPath.toLowerCase();
    if (typeof value === 'boolean') {
      if (value && normalizedPath.includes('image') && /(^|\.)(end|image_end)$/.test(normalizedPath)) {
        supported = true;
      }
      return;
    }
    if (typeof value === 'string') {
      if (
        (normalizedPath.includes('image_prompt_types_allowed')
          || normalizedPath.includes('image_prompt_type'))
        && value.toUpperCase().includes('E')
      ) {
        supported = true;
      }
      return;
    }
    if (Array.isArray(value)) {
      if (
        normalizedPath.includes('image_prompt_type')
        && value.some((entry) => typeof entry === 'string' && entry.toUpperCase() === 'E')
      ) {
        supported = true;
        return;
      }
      value.forEach((entry) => visit(entry, keyPath));
      return;
    }
    if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, keyPath === '' ? key : `${keyPath}.${key}`);
      }
    }
  };
  visit({schema: model.schema, metadata: model.metadata});
  return supported;
}

function numericProgress(data: unknown): number | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const direct = data.progress ?? data.percent ?? data.percentage;
  if (isRecord(direct)) {
    return numericProgress(direct);
  }
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct > 1 ? clamp(direct / 100, 0, 1) : clamp(direct, 0, 1);
  }
  const current = data.current ?? data.step ?? data.current_step;
  const total = data.total ?? data.total_steps ?? data.steps;
  if (
    typeof current === 'number' &&
    typeof total === 'number' &&
    Number.isFinite(current) &&
    Number.isFinite(total) &&
    total > 0
  ) {
    return clamp(current / total, 0, 1);
  }
  return undefined;
}

function resultStrings(value: unknown): string[] {
  if (typeof value === 'string' && value.trim() !== '') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(resultStrings);
  }
  if (isRecord(value)) {
    const message = asString(value.message ?? value.error ?? value.detail);
    return message === undefined ? [] : [message];
  }
  return [];
}

function filePathStrings(value: unknown): string[] {
  if (typeof value === 'string' && value.trim() !== '') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(filePathStrings);
  }
  if (isRecord(value)) {
    const candidate = asString(
      value.path ?? value.output_path ?? value.outputPath ?? value.file ?? value.filename,
    );
    return candidate === undefined ? [] : [candidate];
  }
  return [];
}

function parseSnapshot(value: unknown): WanGPJobSnapshot {
  let source = value;
  if (isRecord(source)) {
    for (const key of ['job', 'snapshot']) {
      if (isRecord(source[key])) {
        source = source[key];
        break;
      }
    }
  }
  if (!isRecord(source)) {
    throw new VideoProviderError('PROTOCOL_ERROR', 'WanGP returned an invalid job snapshot');
  }
  const jobId = asString(source.job_id ?? source.jobId ?? source.id);
  if (jobId === undefined) {
    throw new VideoProviderError('PROTOCOL_ERROR', 'WanGP job snapshot has no job id');
  }
  const events: WanGPEvent[] = Array.isArray(source.events)
    ? source.events
        .filter(isRecord)
        .map((event): WanGPEvent => {
          const kind = asString(event.kind ?? event.type ?? event.event) ?? 'unknown';
          const rawTimestamp = event.timestamp ?? event.time;
          const timestamp = typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)
            ? rawTimestamp
            : asString(rawTimestamp);
          return {
            kind,
            ...(timestamp === undefined ? {} : { timestamp }),
            ...('data' in event ? { data: event.data } : {}),
          };
        })
    : [];

  let parsedResult: WanGPResult | undefined;
  if (isRecord(source.result)) {
    const rawResult = source.result;
    const generated = rawResult.generated_files ?? rawResult.generatedFiles ?? rawResult.files;
    const artifacts = Array.isArray(rawResult.artifacts) ? rawResult.artifacts.filter(isRecord) : [];
    parsedResult = {
      success: asBoolean(rawResult.success),
      cancelled: asBoolean(rawResult.cancelled ?? rawResult.canceled),
      generatedFiles: filePathStrings(generated),
      artifacts,
      errors: resultStrings(rawResult.errors ?? rawResult.error),
    };
  }
  return {
    jobId,
    done: asBoolean(source.done),
    cancelRequested: asBoolean(source.cancel_requested ?? source.cancelRequested),
    events,
    ...(parsedResult === undefined ? {} : { result: parsedResult }),
  };
}

function artifactPaths(result: WanGPResult): string[] {
  const paths = [...result.generatedFiles];
  for (const artifact of result.artifacts) {
    const candidate = asString(
      artifact.path ?? artifact.output_path ?? artifact.outputPath ?? artifact.file ?? artifact.filename,
    );
    if (candidate !== undefined) {
      paths.push(candidate);
    }
  }
  return [...new Set(paths)];
}

function publicError(error: VideoProviderError): { code: string; message: string; details?: unknown } {
  return {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

/** Map concrete runtime failures to stable UI-facing codes without claiming success. */
export function classifyWanGPError(error: unknown): VideoProviderError {
  if (error instanceof VideoProviderError) {
    return error;
  }
  const message = serializeError(error);
  const normalized = message.toLowerCase();
  let code: VideoProviderErrorCode = 'JOB_FAILED';
  if (/cuda.*out of memory|out of memory.*cuda|vram|cublas.*alloc/.test(normalized)) {
    code = 'VRAM_INSUFFICIENT';
  } else if (/system ram|host memory|cannot allocate memory|memoryerror/.test(normalized)) {
    code = 'RAM_INSUFFICIENT';
  } else if (/already.*(generation|job).*progress|only one.*job|busy/.test(normalized)) {
    code = 'PROVIDER_BUSY';
  } else if (/model.*(missing|not found|unavailable)|missing.*(weight|checkpoint)|no such model/.test(normalized)) {
    code = 'MODEL_MISSING';
  } else if (/timed? out|timeout|aborterror/.test(normalized)) {
    code = 'REQUEST_TIMEOUT';
  } else if (/unable to start process|unable to reach|connection refused|econnrefused/.test(normalized)) {
    code = 'SERVICE_UNAVAILABLE';
  } else if (/econnreset|epipe|socket|fetch failed|process exited|not running|disconnected/.test(normalized)) {
    code = 'SERVICE_DISCONNECTED';
  } else if (/invalid.*(request|argument|parameter|config)|validation/.test(normalized)) {
    code = 'INVALID_REQUEST';
  } else if (/cancelled|canceled/.test(normalized)) {
    code = 'JOB_CANCELLED';
  } else if (error instanceof WanGPMcpError && error.rpcCode === -32601) {
    code = 'PROTOCOL_ERROR';
  }
  return new VideoProviderError(code, message);
}

export class WanGPProvider implements VideoGenerationProvider {
  readonly id = 'wangp' as const;

  readonly #transport: WanGPMcpClient;
  readonly #outputDirectory: string;
  readonly #profileSource?: WanGPProviderOptions['profileSource'];
  readonly #callbacks: VideoGenerationProviderCallbacks;
  readonly #jobs = new Map<string, InternalJob>();
  #tools: WanGPMcpTool[] | undefined;
  #models: InternalModel[] | undefined;
  #presets: InternalPreset[] | undefined;
  #capabilityCatalog: WanGPCapabilityCatalog | undefined;
  #startupMs: number | undefined;

  constructor(options: WanGPProviderOptions) {
    this.#transport = options.transport;
    this.#outputDirectory = path.resolve(options.outputDirectory);
    this.#profileSource = options.profileSource;
    this.#callbacks = options.callbacks ?? {};
  }

  async detect(): Promise<VideoProviderDetection> {
    const startedAt = performance.now();
    try {
      await this.#transport.connect();
      const tools = await this.#transport.listTools();
      this.#tools = tools;
      const names = new Set(tools.map((tool) => tool.name));
      const missingTools = REQUIRED_TOOLS.filter((name) => !names.has(name));
      if (missingTools.length > 0) {
        return {
          available: false,
          endpoint: this.#transport.endpointDescription,
          reason: `WanGP MCP is missing required tools: ${missingTools.join(', ')}`,
        };
      }
      const models = await this.#discoverModels(true);
      if (models.length === 0) {
        return {
          available: false,
          endpoint: this.#transport.endpointDescription,
          reason: 'WanGP is reachable, but no image-to-video model definition was returned.',
        };
      }
      const version = this.#transport.serverInfo.version;
      this.#startupMs = performance.now() - startedAt;
      return {
        available: true,
        endpoint: this.#transport.endpointDescription,
        ...(version === undefined ? {} : { version }),
        ...(models.some((model) => model.availability === 'available')
          ? {}
          : { reason: 'WanGP is reachable; the selected low-VRAM model will download on first generation.' }),
      };
    } catch (error) {
      this.#startupMs = performance.now() - startedAt;
      const classified = classifyWanGPError(error);
      return {
        available: false,
        endpoint: this.#transport.endpointDescription,
        reason: classified.message,
      };
    }
  }

  async listPresets(): Promise<VideoGenerationPreset[]> {
    await this.getCapabilityCatalog(true);
    const presets = await this.#getInternalPresets();
    return presets.map(({ publicPreset }) => ({ ...publicPreset }));
  }

  async getCapabilityCatalog(force = false): Promise<WanGPCapabilityCatalog> {
    if (!force && this.#capabilityCatalog !== undefined) return structuredClone(this.#capabilityCatalog);
    const models = await this.#discoverModels(force);
    const tools = this.#tools ?? await this.#transport.listTools().catch(() => []);
    this.#tools = tools;
    const toolNames = new Set(tools.map((tool) => tool.name));

    if (toolNames.has('wangp_list_model_defs')) {
      try {
        const rawDefinitions = await this.#transport.callTool('wangp_list_model_defs', {
          main_output: 'video',
          inputs: 'image',
        });
        const definitions = modelArray(rawDefinitions);
        const byId = new Map(definitions.flatMap((definition) => {
          const id = asString(definition.model_type ?? definition.modelType ?? definition.id);
          return id === undefined ? [] : [[id, definition] as const];
        }));
        for (const model of models) {
          const definition = byId.get(model.modelType);
          if (definition !== undefined) {
            model.schema = {model_def: definition, metadata: model.raw};
            if (model.defaultSettings === undefined && isRecord(definition.settings)) {
              model.defaultSettings = {...definition.settings};
            }
          }
        }
      } catch (error) {
        this.#callbacks.log?.('warn', 'Unable to read WanGP model definitions in one MCP call', {
          message: serializeError(error),
        });
      }
    }

    let capabilities = models.flatMap((model) => {
      const capability = buildWanGPModelCapability({
        raw: model.raw,
        ...(model.schema === undefined ? {} : {schema: model.schema}),
        ...(model.defaultSettings === undefined ? {} : {defaultSettings: model.defaultSettings}),
      });
      return capability === null || !capability.imageToVideo ? [] : [capability];
    });
    const provisional = buildWanGPCapabilityCatalog({models: capabilities, profiles: []});
    const shortlisted = new Set([
      ...provisional.tiers.map((tier) => tier.modelRuntimeId),
      ...capabilities.filter((model) => model.availability === 'available').map((model) => model.runtimeModelId),
    ]);
    for (const model of models) {
      if (shortlisted.has(model.modelType)) await this.#hydrateModel(model);
    }
    capabilities = models.flatMap((model) => {
      const capability = buildWanGPModelCapability({
        raw: model.raw,
        ...(model.schema === undefined ? {} : {schema: model.schema}),
        ...(model.defaultSettings === undefined ? {} : {defaultSettings: model.defaultSettings}),
      });
      return capability === null || !capability.imageToVideo ? [] : [capability];
    });

    const profileDirectories = [...new Set(capabilities.flatMap((model) => model.profileDirectories))];
    const rawProfiles = await this.#discoverAcceleratorProfiles(profileDirectories, toolNames);
    const profiles = rawProfiles.map(buildWanGPAcceleratorProfile);
    this.#capabilityCatalog = buildWanGPCapabilityCatalog({models: capabilities, profiles});
    this.#presets = undefined;
    return structuredClone(this.#capabilityCatalog);
  }

  async submit(input: VideoGenerationInput, options: WanGPSubmitOptions = {}): Promise<VideoGenerationJob> {
    this.#validateInput(input);
    const preset = await this.#resolvePreset(input.presetId, options);
    this.#validatePresetInput(input, preset);
    if (input.endKeyframePath !== undefined && !modelSupportsEndKeyframe(preset.model)) {
      throw new VideoProviderError(
        'INVALID_REQUEST',
        `The model selected by ${input.presetId} does not advertise end-keyframe conditioning.`,
      );
    }

    const publicId = randomUUID();
    const now = new Date().toISOString();
    const workDirectory = path.join(
      this.#outputDirectory,
      sanitizePathPart(input.projectId),
      sanitizePathPart(input.shotId),
      publicId,
    );
    const publicJob: VideoGenerationJob = {
      id: publicId,
      providerId: this.id,
      status: 'queued',
      progress: 0,
      createdAt: now,
      updatedAt: now,
      ...(input.seed === undefined ? {} : { seed: input.seed }),
    };
    const telemetry = new WanGPTelemetryTracker(
      this.#startupMs === undefined ? {} : {startupMs: this.#startupMs},
    );
    publicJob.metrics = telemetry.snapshot();
    const internal: InternalJob = { publicJob, input: { ...input }, preset, workDirectory, telemetry };
    this.#jobs.set(publicId, internal);
    await this.#publish(internal);

    try {
      await this.#setJob(internal, { status: 'preparing', progress: 0.02 });
      const stagedKeyframes = await this.#stageKeyframes(internal);
      const source = this.#buildGenerationSource(internal, stagedKeyframes);
      const response = await this.#transport.callTool('wangp_generate', {
        source,
        wait: false,
        event_limit: 500,
      });
      const snapshot = parseSnapshot(response);
      internal.backendJobId = snapshot.jobId;
      await this.#applySnapshot(internal, snapshot);
    } catch (error) {
      await this.#fail(internal, classifyWanGPError(error));
    }
    return cloneVideoGenerationJob(internal.publicJob);
  }

  async status(jobId: string): Promise<VideoGenerationJob> {
    const internal = this.#jobs.get(jobId);
    if (internal === undefined) {
      throw new VideoProviderError('JOB_NOT_FOUND', `Unknown WanGP job: ${jobId}`);
    }
    if (isTerminal(internal.publicJob.status)) {
      return cloneVideoGenerationJob(internal.publicJob);
    }
    if (internal.backendJobId === undefined) {
      await this.#fail(
        internal,
        new VideoProviderError('SERVICE_DISCONNECTED', 'WanGP did not return a backend job id.'),
      );
      return cloneVideoGenerationJob(internal.publicJob);
    }
    try {
      const response = await this.#transport.callTool('wangp_get_job', {
        job_id: internal.backendJobId,
        event_limit: 500,
      });
      await this.#applySnapshot(internal, parseSnapshot(response));
    } catch (error) {
      await this.#fail(internal, classifyWanGPError(error));
    }
    return cloneVideoGenerationJob(internal.publicJob);
  }

  async cancel(jobId: string): Promise<void> {
    const internal = this.#jobs.get(jobId);
    if (internal === undefined) {
      throw new VideoProviderError('JOB_NOT_FOUND', `Unknown WanGP job: ${jobId}`);
    }
    if (isTerminal(internal.publicJob.status)) {
      return;
    }
    if (internal.backendJobId === undefined) {
      await this.#setJob(internal, { status: 'cancelled' });
      return;
    }
    try {
      const response = await this.#transport.callTool('wangp_cancel_job', {
        job_id: internal.backendJobId,
      });
      // Cancellation in WanGP is cooperative.  Only record cancelled if the
      // backend snapshot confirms it; otherwise the next status poll decides.
      try {
        const snapshot = parseSnapshot(response);
        await this.#applySnapshot(internal, snapshot);
      } catch {
        await this.#setJob(internal, {});
      }
    } catch (error) {
      const classified = classifyWanGPError(error);
      this.#callbacks.log?.('error', 'Unable to request WanGP job cancellation', classified);
      throw classified;
    }
  }

  async importResult(sourcePath: string): Promise<string> {
    const source = path.resolve(sourcePath);
    await this.#assertUsableFile(source, 'Imported video');
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) {
      throw new VideoProviderError('INVALID_PATH', 'Imported result is not a supported video file.');
    }
    const directory = path.join(this.#outputDirectory, 'imports', randomUUID());
    await mkdir(directory, { recursive: true });
    const destination = path.join(directory, `imported${path.extname(source).toLowerCase()}`);
    await this.#atomicCopy(source, destination);
    return destination;
  }

  async #discoverAcceleratorProfiles(
    directories: readonly string[],
    toolNames: ReadonlySet<string>,
  ): Promise<WanGPAcceleratorProfileSource[]> {
    if (toolNames.has('wangp_list_accelerator_profiles')) {
      try {
        const response = await this.#transport.callTool('wangp_list_accelerator_profiles', {
          profile_directories: directories,
        });
        return profileArray(response).flatMap((profile) => {
          const source = profileSourceFromRecord(profile);
          return source === null ? [] : [source];
        });
      } catch (error) {
        this.#callbacks.log?.('warn', 'WanGP MCP accelerator profile discovery failed', {
          message: serializeError(error),
        });
      }
    }
    if (this.#profileSource === undefined) return [];
    return this.#profileSource(directories);
  }

  async #discoverModels(force = false): Promise<InternalModel[]> {
    if (!force && this.#models !== undefined) {
      return this.#models;
    }
    const raw = await this.#transport.callTool('wangp_list_models', {
      main_output: 'video',
      inputs: 'image',
      include_availability: true,
    });
    const candidates: InternalModel[] = [];
    for (const item of modelArray(raw)) {
      const modelType = asString(item.model_type ?? item.modelType ?? item.id ?? item.key);
      if (modelType === undefined) {
        continue;
      }
      const outputs = resultStrings(item.main_output ?? item.mainOutput ?? item.outputs)
        .join(' ')
        .toLowerCase();
      const inputs = resultStrings(item.inputs ?? item.input_types ?? item.inputTypes)
        .join(' ')
        .toLowerCase();
      if ((outputs !== '' && !outputs.includes('video')) || (inputs !== '' && !inputs.includes('image'))) {
        continue;
      }
      let availability = availabilityFrom(item.availability ?? item.status);
      if (availability === 'unknown') {
        try {
          const availabilityResult = await this.#transport.callTool(
            'wangp_get_model_availability',
            { model_type: modelType },
          );
          availability = availabilityFrom(availabilityResult);
        } catch (error) {
          this.#callbacks.log?.('warn', 'Unable to read WanGP model availability', {
            message: serializeError(error),
          });
        }
      }
      candidates.push({
        modelType,
        label: asString(item.name ?? item.label ?? item.description) ?? modelType,
        availability,
        raw: item,
      });
    }
    this.#models = candidates;
    this.#presets = undefined;
    this.#capabilityCatalog = undefined;
    return candidates;
  }

  async #hydrateModel(model: InternalModel): Promise<void> {
    if (model.metadata === undefined) {
      const metadata = await this.#transport.callTool('wangp_get_model_metadata', {
        model_type: model.modelType,
      });
      model.metadata = unwrapRecord(metadata, ['metadata', 'model_metadata']);
    }
    if (model.defaultSettings === undefined) {
      const defaults = await this.#transport.callTool('wangp_get_default_settings', {
        model_type: model.modelType,
      });
      model.defaultSettings = unwrapRecord(defaults, ['default_settings', 'settings', 'defaults']);
    }
    if (model.schema === undefined) {
      const schema = await this.#transport.callTool('wangp_get_model_schema', {
        model_type: model.modelType,
      });
      model.schema = unwrapRecord(schema, ['schema', 'model_schema']);
    }
  }

  async #getInternalPresets(): Promise<InternalPreset[]> {
    if (this.#presets !== undefined) return this.#presets;
    const catalog = await this.getCapabilityCatalog();
    const models = await this.#discoverModels();
    const modelsById = new Map(models.map((model) => [model.modelType, model]));
    const capabilitiesById = new Map(catalog.models.map((model) => [model.runtimeModelId, model]));
    const profilesById = new Map(catalog.acceleratorProfiles.map((profile) => [profile.id, profile]));
    const presets: InternalPreset[] = [];
    for (const tier of catalog.tiers) {
      const model = modelsById.get(tier.modelRuntimeId);
      const modelCapability = capabilitiesById.get(tier.modelRuntimeId);
      if (!model || !modelCapability) continue;
      await this.#hydrateModel(model);
      const profile = tier.acceleratorProfileId === undefined
        ? undefined
        : profilesById.get(tier.acceleratorProfileId);
      presets.push({
        publicPreset: {
          id: tier.configurationId,
          label: `${tier.tier} · ${tier.modelLabel}`,
          width: tier.width,
          height: tier.height,
          fps: tier.fps,
          frameCount: tier.frameCount,
          candidateCount: 1,
          qualityTier: tier.tier === 'quality-local' ? 'quality' : 'preview',
          allowUpscale: true,
          allowInterpolation: tier.tier !== 'ultra-preview',
        },
        model,
        modelCapability,
        ...(profile === undefined ? {} : {profile}),
        tier,
      });
    }
    this.#presets = presets;
    return presets;
  }

  async #resolvePreset(id: string, options: WanGPSubmitOptions = {}): Promise<InternalPreset> {
    const presets = await this.#getInternalPresets();
    const requestedId = options.configurationId ?? id;
    const requestedTier = requestedId === LEGACY_FAST_PRESET_ID
      ? 'balanced-local'
      : requestedId === LEGACY_QUALITY_PRESET_ID ? 'quality-local' : undefined;
    const basePreset = presets.find((candidate) => candidate.publicPreset.id === requestedId)
      ?? (requestedTier === undefined ? undefined : presets.find((candidate) => candidate.tier.tier === requestedTier));
    if (basePreset === undefined) {
      throw new VideoProviderError(
        'MODEL_MISSING',
        `Video preset is not available on this WanGP installation: ${requestedId}`,
      );
    }
    if (options.modelRuntimeId === undefined) return basePreset;
    const catalog = await this.getCapabilityCatalog();
    const modelCapability = catalog.models.find((model) => model.runtimeModelId === options.modelRuntimeId);
    const model = (await this.#discoverModels()).find((candidate) => candidate.modelType === options.modelRuntimeId);
    if (!model || !modelCapability || !modelCapability.imageToVideo) {
      throw new VideoProviderError('MODEL_MISSING', 'Selected WanGP model is not an MCP-advertised image-to-video model.');
    }
    const profile = options.acceleratorProfileId === undefined
      ? undefined
      : catalog.acceleratorProfiles.find((candidate) => candidate.id === options.acceleratorProfileId);
    if (options.acceleratorProfileId !== undefined && (
      profile === undefined || !modelCapability.profileDirectories.includes(profile.directory)
    )) {
      throw new VideoProviderError('INVALID_REQUEST', 'Selected accelerator profile is not compatible with the selected WanGP model metadata.');
    }
    await this.#hydrateModel(model);
    const steps = profile?.steps ?? modelCapability.defaultSteps ?? basePreset.tier.steps;
    const guidance = profile?.guidance ?? modelCapability.defaultGuidance ?? basePreset.tier.guidance;
    const {
      acceleratorProfileId: _baseProfileId,
      acceleratorProfileLabel: _baseProfileLabel,
      ...baseTier
    } = basePreset.tier;
    return {
      ...basePreset,
      model,
      modelCapability,
      ...(profile === undefined ? {} : {profile}),
      tier: {
        ...baseTier,
        modelRuntimeId: modelCapability.runtimeModelId,
        modelLabel: modelCapability.label,
        steps,
        guidance,
        quantization: modelCapability.quantization,
        cachePolicy: resolveWanGPCachePolicy({
          model: modelCapability,
          ...(profile === undefined ? {} : {profile}),
          steps,
        }),
        ...(profile === undefined ? {} : {
          acceleratorProfileId: profile.id,
          acceleratorProfileLabel: profile.label,
        }),
      },
    };
  }

  #validateInput(input: VideoGenerationInput): void {
    if (input.projectId.trim() === '' || input.shotId.trim() === '') {
      throw new VideoProviderError('INVALID_REQUEST', 'projectId and shotId are required.');
    }
    if (input.prompt.trim() === '') {
      throw new VideoProviderError('INVALID_REQUEST', 'A non-empty motion prompt is required.');
    }
    for (const [name, value] of [
      ['width', input.width],
      ['height', input.height],
      ['fps', input.fps],
      ['frameCount', input.frameCount],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new VideoProviderError('INVALID_REQUEST', `${name} must be a positive integer.`);
      }
    }
    if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0)) {
      throw new VideoProviderError('INVALID_REQUEST', 'seed must be a non-negative safe integer.');
    }
    if (input.steps !== undefined && (!Number.isInteger(input.steps) || input.steps <= 0)) {
      throw new VideoProviderError('INVALID_REQUEST', 'steps must be a positive integer.');
    }
    if (input.guidance !== undefined && (!Number.isFinite(input.guidance) || input.guidance < 0)) {
      throw new VideoProviderError('INVALID_REQUEST', 'guidance must be a non-negative number.');
    }
    if (
      input.motionStrength !== undefined
      && (!Number.isFinite(input.motionStrength) || input.motionStrength < 0 || input.motionStrength > 1)
    ) {
      throw new VideoProviderError('INVALID_REQUEST', 'motionStrength must be between 0 and 1.');
    }
  }

  #validatePresetInput(input: VideoGenerationInput, preset: InternalPreset): void {
    const expected = preset.publicPreset;
    if (
      input.width !== expected.width ||
      input.height !== expected.height ||
      input.fps !== expected.fps ||
      input.frameCount !== expected.frameCount
    ) {
      throw new VideoProviderError(
        'INVALID_REQUEST',
        `Input dimensions/timing must match preset ${expected.id}: ${expected.width}x${expected.height}, ${expected.fps} fps, ${expected.frameCount} frames.`,
      );
    }
  }

  async #stageImage(sourcePath: string, label: string, destinationName: string, staging: string): Promise<string> {
    const source = path.resolve(sourcePath);
    await this.#assertUsableFile(source, label);
    const extension = path.extname(source).toLowerCase();
    if (!new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']).has(extension)) {
      throw new VideoProviderError('INVALID_PATH', `${label} must be a supported image file.`);
    }
    const destination = path.join(staging, `${destinationName}${extension}`);
    await this.#atomicCopy(source, destination);
    return destination;
  }

  async #stageKeyframes(internal: InternalJob): Promise<StagedKeyframes> {
    const staging = path.join(this.#outputDirectory, '.wangp-staging', internal.publicJob.id);
    await mkdir(staging, { recursive: true });
    const start = await this.#stageImage(
      internal.input.keyframePath,
      'Start keyframe',
      'start',
      staging,
    );
    if (internal.input.endKeyframePath === undefined) return {start};
    const end = await this.#stageImage(
      internal.input.endKeyframePath,
      'End keyframe',
      'end',
      staging,
    );
    return {start, end};
  }

  #buildGenerationSource(internal: InternalJob, keyframes: StagedKeyframes): UnknownRecord {
    const defaults = internal.preset.model.defaultSettings ?? {};
    const profileSettings = internal.preset.profile?.settings ?? {};
    const input = internal.input;
    const steps = input.steps ?? internal.preset.tier.steps;
    const guidance = input.guidance ?? internal.preset.tier.guidance;
    const cachePolicy = resolveWanGPCachePolicy({
      model: internal.preset.modelCapability,
      ...(internal.preset.profile === undefined ? {} : {profile: internal.preset.profile}),
      steps,
    });
    return applyWanGPCachePolicy({
      ...defaults,
      ...profileSettings,
      model_type: internal.preset.model.modelType,
      prompt: input.prompt,
      ...(input.negativePrompt === undefined ? {} : { negative_prompt: input.negativePrompt }),
      image_prompt_type: keyframes.end === undefined ? 'S' : 'SE',
      image_start: keyframes.start,
      ...(keyframes.end === undefined ? {} : {image_end: keyframes.end}),
      resolution: `${input.width}x${input.height}`,
      video_length: input.frameCount,
      force_fps: String(input.fps),
      override_profile: 4,
      override_attention: '',
      ...(input.seed === undefined ? {} : { seed: input.seed }),
      num_inference_steps: steps,
      guidance_scale: guidance,
      ...(input.motionStrength === undefined
        ? {}
        : {motion_amplitude: 1 + input.motionStrength * 0.4}),
    }, cachePolicy);
  }

  async #applySnapshot(internal: InternalJob, snapshot: WanGPJobSnapshot): Promise<void> {
    if (internal.backendJobId !== undefined && snapshot.jobId !== internal.backendJobId) {
      throw new VideoProviderError('PROTOCOL_ERROR', 'WanGP returned a snapshot for a different job.');
    }
    internal.backendJobId = snapshot.jobId;
    internal.publicJob.metrics = internal.telemetry.ingest(snapshot.events, snapshot.done);
    if (snapshot.done) {
      const result = snapshot.result;
      if (result === undefined) {
        await this.#fail(
          internal,
          new VideoProviderError('PROTOCOL_ERROR', 'WanGP marked the job done without a result.'),
        );
        return;
      }
      if (result.cancelled) {
        await this.#setJob(internal, { status: 'cancelled', progress: internal.publicJob.progress });
        return;
      }
      if (!result.success) {
        const message = result.errors.join('; ') || 'WanGP generation failed.';
        await this.#fail(internal, classifyWanGPError(message));
        return;
      }
      await this.#completeFromResult(internal, result);
      return;
    }

    let status: VideoGenerationStatus = internal.publicJob.status;
    let progress = internal.publicJob.progress;
    for (const event of snapshot.events) {
      const eventData = isRecord(event.data) ? event.data : {};
      const phase = asString(eventData.phase ?? eventData.stage ?? eventData.status) ?? '';
      const kind = `${event.kind} ${phase}`.toLowerCase();
      const measured = numericProgress(event.data);
      if (/load|prepar|encode|prompt|model/.test(kind)) {
        status = 'preparing';
        progress = Math.max(progress, 0.04);
      }
      if (/infer|sampl|generat|progress|step/.test(kind)) {
        status = 'running';
        progress = Math.max(progress, measured === undefined ? 0.1 : 0.08 + measured * 0.84);
      }
      if (/decod|sav|artifact|output|download/.test(kind)) {
        status = 'downloading';
        progress = Math.max(progress, 0.94);
      }
    }
    if (status === 'queued' || status === 'preparing') {
      status = snapshot.events.length === 0 ? 'queued' : status;
    }
    await this.#setJob(internal, { status, progress: clamp(progress, 0, 0.99) });
  }

  async #completeFromResult(internal: InternalJob, result: WanGPResult): Promise<void> {
    const candidates = artifactPaths(result).filter((candidate) =>
      VIDEO_EXTENSIONS.has(path.extname(candidate).toLowerCase()),
    );
    if (candidates.length === 0) {
      await this.#fail(
        internal,
        new VideoProviderError('OUTPUT_MISSING', 'WanGP reported success but returned no video file.'),
      );
      return;
    }
    const absoluteCandidates = candidates.filter((candidate) => path.isAbsolute(candidate));
    let source: string | undefined;
    for (const candidate of absoluteCandidates) {
      try {
        await this.#assertUsableFile(candidate, 'WanGP output');
        source = candidate;
        break;
      } catch {
        // WanGP can report more than one task artifact; continue to the next.
      }
    }
    if (source === undefined) {
      await this.#fail(
        internal,
        new VideoProviderError(
          'OUTPUT_MISSING',
          absoluteCandidates.length === 0
            ? 'WanGP returned no absolute video path; a local/shared absolute path is required.'
            : 'WanGP reported video paths, but none exists on the local/shared filesystem.',
        ),
      );
      return;
    }
    try {
      await this.#setJob(internal, { status: 'downloading', progress: 0.97 });
      await mkdir(internal.workDirectory, { recursive: true });
      const destination = path.join(
        internal.workDirectory,
        `generated${path.extname(source).toLowerCase()}`,
      );
      await this.#atomicCopy(source, destination);
      await this.#assertUsableFile(destination, 'Copied WanGP output');
      await this.#setJob(internal, {
        status: 'complete',
        progress: 1,
        outputPath: destination,
        error: undefined,
      });
    } catch (error) {
      const classified = classifyWanGPError(error);
      const outputError =
        classified.code === 'INVALID_PATH'
          ? new VideoProviderError('OUTPUT_MISSING', classified.message)
          : new VideoProviderError('OUTPUT_COPY_FAILED', classified.message);
      await this.#fail(internal, outputError);
    }
  }

  async #assertUsableFile(filePath: string, label: string): Promise<void> {
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size <= 0) {
        throw new Error('not a non-empty regular file');
      }
    } catch (cause) {
      throw new VideoProviderError('INVALID_PATH', `${label} is not readable: ${filePath}`, {
        message: serializeError(cause),
      });
    }
  }

  async #atomicCopy(source: string, destination: string): Promise<void> {
    const resolvedSource = path.resolve(source);
    const resolvedDestination = path.resolve(destination);
    if (resolvedSource.toLowerCase() === resolvedDestination.toLowerCase()) {
      await this.#assertUsableFile(resolvedDestination, 'Video file');
      return;
    }
    await mkdir(path.dirname(resolvedDestination), { recursive: true });
    const temporary = `${resolvedDestination}.partial-${randomUUID()}`;
    try {
      await copyFile(resolvedSource, temporary);
      await this.#assertUsableFile(temporary, 'Temporary copy');
      await rename(temporary, resolvedDestination);
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      if (cause instanceof VideoProviderError) {
        throw cause;
      }
      throw new VideoProviderError('OUTPUT_COPY_FAILED', 'Unable to copy video output safely.', {
        message: serializeError(cause),
      });
    }
  }

  async #setJob(
    internal: InternalJob,
    patch: {
      status?: VideoGenerationStatus;
      progress?: number;
      outputPath?: string;
      previewPath?: string;
      seed?: number;
      metrics?: VideoGenerationJob['metrics'];
      error?: VideoGenerationJob['error'] | undefined;
    },
  ): Promise<void> {
    const { error: patchedError, metrics: patchedMetrics, ...patchWithoutOptional } = patch;
    const updated: VideoGenerationJob = {
      ...internal.publicJob,
      ...patchWithoutOptional,
      ...(patchedMetrics === undefined ? {} : {metrics: patchedMetrics}),
      ...(patchedError === undefined ? {} : { error: patchedError }),
      updatedAt: new Date().toISOString(),
    };
    if (patchedError === undefined && 'error' in patch) {
      delete updated.error;
    }
    internal.publicJob = updated;
    await this.#publish(internal);
  }

  async #fail(internal: InternalJob, error: VideoProviderError): Promise<void> {
    await this.#setJob(internal, {
      status: error.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed',
      progress: internal.publicJob.progress,
      error: publicError(error),
    });
  }

  async #publish(internal: InternalJob): Promise<void> {
    const snapshot = cloneVideoGenerationJob(internal.publicJob);
    for (const [name, callback] of [
      ['persistJob', this.#callbacks.persistJob],
      ['onJobUpdated', this.#callbacks.onJobUpdated],
    ] as const) {
      if (callback === undefined) {
        continue;
      }
      try {
        await callback(cloneVideoGenerationJob(snapshot));
      } catch (error) {
        this.#callbacks.log?.('error', `Video provider ${name} callback failed`, {
          jobId: snapshot.id,
          message: serializeError(error),
        });
      }
    }
  }
}

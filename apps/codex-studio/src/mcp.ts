import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';

const baseUrl = process.env.GEN_VIDEO_STUDIO_URL?.trim() || 'http://127.0.0.1:4390';
const sessionToken = process.env.GEN_VIDEO_STUDIO_TOKEN?.trim();
if (!sessionToken) throw new Error('GEN_VIDEO_STUDIO_TOKEN_REQUIRED');

const api = async <T>(pathname: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: T & {error?: string};
  try { body = JSON.parse(text) as T & {error?: string}; } catch { throw new Error(text || `Studio returned HTTP ${response.status}`); }
  if (!response.ok) throw new Error(body.error || `Studio returned HTTP ${response.status}`);
  return body;
};

const result = <T extends object>(value: T) => ({
  content: [{type: 'text' as const, text: JSON.stringify(value, null, 2)}],
  structuredContent: value,
});

export const createGenVideoMcpServer = () => {
  const server = new McpServer({name: 'gen-video-tool', version: '0.1.0'});

  server.registerTool('gen_video_get_status', {
    title: 'Get Gen Video Tool status',
    description: 'Start or locate the private localhost video studio and return its browser URL, active local job, and storage roots.',
    inputSchema: {},
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async () => result(await api<Record<string, unknown>>('/api/status')));

  server.registerTool('gen_video_list_projects', {
    title: 'List local video projects',
    description: 'List validated v3 projects with duration, shot selection progress, narration status, and update time. Project content is omitted.',
    inputSchema: {},
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async () => result(await api<{total: number; projects: unknown[]}>('/api/projects')));

  server.registerTool('gen_video_get_project', {
    title: 'Read one local video project',
    description: 'Read the immutable production plan and mutable local production state. Always use before deciding which generation gate is next.',
    inputSchema: {project_id: z.string().min(1).max(128)},
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async ({project_id}) => result(await api<Record<string, unknown>>(`/api/projects/${encodeURIComponent(project_id)}`)));

  server.registerTool('gen_video_inspect_asset_pack', {
    title: 'Inspect a source asset pack',
    description: 'Validate a local v3 asset-pack ZIP or directory without importing it or changing project state.',
    inputSchema: {source_path: z.string().min(1).max(4_000).describe('Absolute local ZIP or directory path')},
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async ({source_path}) => result(await api<Record<string, unknown>>('/api/packs/inspect', {method: 'POST', body: JSON.stringify({sourcePath: source_path})})));

  server.registerTool('gen_video_import_asset_pack', {
    title: 'Import a source asset pack',
    description: 'Atomically import a validated local v3 asset pack into the studio project library. This does not start model generation.',
    inputSchema: {
      source_path: z.string().min(1).max(4_000).describe('Absolute local ZIP or directory path'),
      destination_name: z.string().max(128).optional(),
    },
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false},
  }, async ({source_path, destination_name}) => result(await api<Record<string, unknown>>('/api/packs/import', {
    method: 'POST',
    body: JSON.stringify({sourcePath: source_path, ...(destination_name ? {destinationName: destination_name} : {})}),
  })));

  const jobTool = (
    name: string,
    title: string,
    description: string,
    suffix: (input: {project_id: string; shot_id?: string}) => string,
    withShot = false,
  ): void => {
    server.registerTool(name, {
      title,
      description,
      inputSchema: {
        project_id: z.string().min(1).max(128),
        ...(withShot ? {shot_id: z.string().min(1).max(128)} : {}),
      },
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    }, async (input) => result(await api<Record<string, unknown>>(suffix(input), {method: 'POST', body: '{}'})));
  };
  jobTool('gen_video_detect_runtime', 'Detect local WanGP runtime', 'Queue local-only WanGP, CUDA, model, and preset detection. Returns a job; poll it before generation.', ({project_id}) => `/api/projects/${encodeURIComponent(project_id)}/detect`);
  jobTool('gen_video_generate_shot', 'Generate the next shot candidate', 'Queue one immutable WanGP candidate seed for one generated-performance shot. It never auto-selects.', ({project_id, shot_id}) => `/api/projects/${encodeURIComponent(project_id)}/shots/${encodeURIComponent(shot_id!)}/generate`, true);
  jobTool('gen_video_synthesize_narration', 'Synthesize local narration', 'Queue F5-TTS narration after every generated shot has an accepted candidate.', ({project_id}) => `/api/projects/${encodeURIComponent(project_id)}/narrate`);
  jobTool('gen_video_render_project', 'Render the final video', 'Queue deterministic Remotion/FFmpeg rendering after candidate and narration gates pass.', ({project_id}) => `/api/projects/${encodeURIComponent(project_id)}/render`);

  server.registerTool('gen_video_get_job', {
    title: 'Get local job status',
    description: 'Read progress, result, error, and bounded logs for an asynchronous local production job.',
    inputSchema: {job_id: z.string().uuid()},
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async ({job_id}) => result(await api<Record<string, unknown>>(`/api/jobs/${encodeURIComponent(job_id)}`)));

  server.registerTool('gen_video_list_jobs', {
    title: 'List local jobs',
    description: 'List queued, running, and recent terminal local production jobs.',
    inputSchema: {},
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  }, async () => result(await api<{jobs: unknown[]}>('/api/jobs')));

  server.registerTool('gen_video_cancel_job', {
    title: 'Cancel a local job',
    description: 'Cancel a queued or running studio job. Use only when the user asks to stop it or it is an obvious duplicate.',
    inputSchema: {job_id: z.string().uuid()},
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  }, async ({job_id}) => result(await api<Record<string, unknown>>(`/api/jobs/${encodeURIComponent(job_id)}/cancel`, {method: 'POST', body: '{}'})));

  const reviewTool = (decision: 'select' | 'reject'): void => {
    server.registerTool(`gen_video_${decision === 'select' ? 'select' : 'reject'}_candidate`, {
      title: decision === 'select' ? 'Accept and select a candidate' : 'Reject a candidate',
      description: decision === 'select'
        ? 'Record explicit human acceptance and select a technically passing candidate. Never call without user review.'
        : 'Record explicit human rejection with a concrete visible reason.',
      inputSchema: {
        project_id: z.string().min(1).max(128),
        shot_id: z.string().min(1).max(128),
        candidate_id: z.string().min(1).max(128),
        notes: decision === 'reject' ? z.string().min(1).max(4_000) : z.string().max(4_000).optional(),
      },
      annotations: {readOnlyHint: false, destructiveHint: decision === 'reject', idempotentHint: false, openWorldHint: false},
    }, async ({project_id, shot_id, candidate_id, notes}) => result(await api<Record<string, unknown>>(
      `/api/projects/${encodeURIComponent(project_id)}/shots/${encodeURIComponent(shot_id)}/candidates/${encodeURIComponent(candidate_id)}/${decision}`,
      {method: 'POST', body: JSON.stringify({...(notes ? {notes} : {})})},
    )));
  };
  reviewTool('select');
  reviewTool('reject');
  return server;
};

const main = async (): Promise<void> => {
  const server = createGenVideoMcpServer();
  await server.connect(new StdioServerTransport());
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

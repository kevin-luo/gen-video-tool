import {mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {WanGPProvider} from '../src/providers/wangp-provider';
import type {
  WanGPMcpClient,
  WanGPMcpServerInfo,
  WanGPMcpTool,
} from '../src/providers/wangp-transport';

const roots: string[] = [];

class FakeWanGPTransport implements WanGPMcpClient {
  readonly endpointDescription = 'fake:wangp';
  readonly serverInfo: Readonly<WanGPMcpServerInfo> = {name: 'fake', version: '1'};
  readonly generatedSources: Array<Record<string, unknown>> = [];

  constructor(
    private readonly supportsEnd: boolean,
    private readonly supportsText = false,
  ) {}

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async listTools(): Promise<WanGPMcpTool[]> { return []; }

  async callTool<T = unknown>(name: string, arguments_: Record<string, unknown> = {}): Promise<T> {
    let result: unknown;
    if (name === 'wangp_list_models') {
      result = {models: [{model_type: 'fun_inp_1.3B', availability: 'available'}]};
    } else if (name === 'wangp_get_model_metadata') {
      result = {metadata: {
        image_prompt_types_allowed: `${this.supportsText ? 'T' : ''}${this.supportsEnd ? 'SEVL' : 'SVL'}`,
      }};
    } else if (name === 'wangp_get_default_settings') {
      result = {default_settings: {num_inference_steps: 4}};
    } else if (name === 'wangp_get_model_schema') {
      result = {schema: {media_inputs: {image: {start: true, end: this.supportsEnd}}}};
    } else if (name === 'wangp_generate') {
      this.generatedSources.push(arguments_.source as Record<string, unknown>);
      result = {
        job_id: 'fake-job',
        done: false,
        cancel_requested: false,
        events: [{kind: 'generation_progress', data: {current: 1, total: 4}}],
      };
    } else {
      throw new Error(`Unexpected fake tool call: ${name}`);
    }
    return result as T;
  }
}

const fixture = async (): Promise<{root: string; start: string; end: string}> => {
  const root = await mkdtemp(path.join(tmpdir(), 'wangp-start-end-'));
  roots.push(root);
  const start = path.join(root, '起始 画面.png');
  const end = path.join(root, '结束 画面.png');
  await writeFile(start, 'start-image');
  await writeFile(end, 'end-image');
  return {root, start, end};
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('WanGP start/end conditioning', () => {
  it('generates from text without staging image files', async () => {
    const {root} = await fixture();
    const transport = new FakeWanGPTransport(false, true);
    const outputDirectory = path.join(root, 'output');
    const provider = new WanGPProvider({transport, outputDirectory});

    const job = await provider.submit({
      projectId: 'project',
      shotId: 'text-shot',
      prompt: 'a small cat serves noodles at a warm street stall',
      width: 480,
      height: 832,
      fps: 24,
      frameCount: 81,
      presetId: 'local-i2v-fast-portrait',
    });

    expect(job.status).toBe('running');
    const source = transport.generatedSources[0]!;
    expect(source.image_prompt_type).toBe('');
    expect(source).not.toHaveProperty('image_start');
    expect(source).not.toHaveProperty('image_end');
    await expect(stat(path.join(outputDirectory, '.wangp-staging'))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('stages one start image and sends the S protocol', async () => {
    const {root, start} = await fixture();
    const transport = new FakeWanGPTransport(false);
    const provider = new WanGPProvider({transport, outputDirectory: path.join(root, 'output')});

    const job = await provider.submit({
      projectId: 'project',
      shotId: 'start-shot',
      keyframePath: start,
      prompt: 'one continuous full-body action',
      width: 480,
      height: 832,
      fps: 24,
      frameCount: 81,
      presetId: 'local-i2v-fast-portrait',
    });

    expect(job.status).toBe('running');
    const source = transport.generatedSources[0]!;
    expect(source.image_prompt_type).toBe('S');
    expect(path.basename(String(source.image_start))).toBe('start.png');
    expect(source).not.toHaveProperty('image_end');
  });

  it('stages ASCII-safe start/end files and sends the SE protocol', async () => {
    const {root, start, end} = await fixture();
    const transport = new FakeWanGPTransport(true);
    const provider = new WanGPProvider({transport, outputDirectory: path.join(root, 'output')});

    const job = await provider.submit({
      projectId: 'project',
      shotId: 'shot',
      keyframePath: start,
      endKeyframePath: end,
      prompt: 'one continuous full-body action',
      width: 480,
      height: 832,
      fps: 24,
      frameCount: 81,
      presetId: 'local-i2v-fast-portrait',
    });

    expect(job.status).toBe('running');
    expect(transport.generatedSources).toHaveLength(1);
    const source = transport.generatedSources[0]!;
    expect(source.image_prompt_type).toBe('SE');
    expect(path.basename(String(source.image_start))).toBe('start.png');
    expect(path.basename(String(source.image_end))).toBe('end.png');
  });

  it('fails before generation when the selected model does not advertise an end image', async () => {
    const {root, start, end} = await fixture();
    const transport = new FakeWanGPTransport(false);
    const provider = new WanGPProvider({transport, outputDirectory: path.join(root, 'output')});

    await expect(provider.submit({
      projectId: 'project',
      shotId: 'shot',
      keyframePath: start,
      endKeyframePath: end,
      prompt: 'one continuous full-body action',
      width: 480,
      height: 832,
      fps: 24,
      frameCount: 81,
      presetId: 'local-i2v-fast-portrait',
    })).rejects.toMatchObject({code: 'INVALID_REQUEST'});
    expect(transport.generatedSources).toHaveLength(0);
  });

  it('rejects an end keyframe without a start keyframe', async () => {
    const {root, end} = await fixture();
    const transport = new FakeWanGPTransport(true, true);
    const provider = new WanGPProvider({transport, outputDirectory: path.join(root, 'output')});

    await expect(provider.submit({
      projectId: 'project',
      shotId: 'shot',
      endKeyframePath: end,
      prompt: 'one continuous full-body action',
      width: 480,
      height: 832,
      fps: 24,
      frameCount: 81,
      presetId: 'local-i2v-fast-portrait',
    })).rejects.toMatchObject({code: 'INVALID_REQUEST'});
    expect(transport.generatedSources).toHaveLength(0);
  });
});

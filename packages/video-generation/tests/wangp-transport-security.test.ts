import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {buildLocalOnlyWanGPEnvironment} from '../src/providers/wangp-environment';
import {
  normalizeLocalWanGPMcpEndpoint,
  WanGPMcpTransport,
} from '../src/providers/wangp-transport';

describe('WanGP transport local-only boundary', () => {
  it.each([
    'http://127.0.0.1:7866/mcp',
    'http://localhost:7866/mcp',
    'https://[::1]:7866/mcp',
  ])('accepts a loopback MCP endpoint: %s', (endpoint) => {
    const normalized = normalizeLocalWanGPMcpEndpoint(endpoint);
    expect(new URL(normalized).hostname).toBe(new URL(endpoint).hostname);
    expect(new WanGPMcpTransport({kind: 'streamable-http', endpoint}).endpointDescription)
      .toBe(normalized);
  });

  it.each([
    'https://api.example.com/mcp',
    'http://localhost.example.com/mcp',
    'file:///tmp/wangp.sock',
    'not a URL',
    'http://user:secret@127.0.0.1:7866/mcp',
  ])('rejects a remote, credentialed, or invalid endpoint: %s', (endpoint) => {
    expect(() => new WanGPMcpTransport({kind: 'streamable-http', endpoint})).toThrow();
  });

  it('forces model tooling into offline mode with project-owned caches', () => {
    const environment = buildLocalOnlyWanGPEnvironment('F:\\model-cache\\wangp', {PATH: 'local-bin'});
    expect(environment).toMatchObject({
      PATH: 'local-bin',
      HF_HOME: path.resolve('F:\\model-cache\\wangp'),
      TRITON_CACHE_DIR: path.resolve('F:\\model-cache\\wangp', 'triton'),
      TORCHINDUCTOR_CACHE_DIR: path.resolve('F:\\model-cache\\wangp', 'torchinductor'),
      CUDA_CACHE_PATH: path.resolve('F:\\model-cache\\wangp', 'cuda'),
      XDG_CACHE_HOME: path.resolve('F:\\model-cache\\wangp', 'xdg'),
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_DATASETS_OFFLINE: '1',
      WANDB_MODE: 'offline',
    });
  });
});

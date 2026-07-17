import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {
  diagnosticUrl,
  isTrustedIpcSender,
  isTrustedRendererLocation,
  parseLoopbackRendererUrl,
  selectTrustedRenderer,
} from '../../../apps/desktop/src/main/desktop-security';
import {
  createDesktopDiagnostics,
  diagnosticError,
} from '../../../apps/desktop/src/main/desktop-diagnostics';

const roots: string[] = [];
const rendererFileUrl = pathToFileURL(path.resolve('out/renderer/index.html')).toString();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('desktop renderer trust policy', () => {
  it.each([
    'http://localhost:32147',
    'https://localhost:32147/editor',
    'http://127.0.0.1:32147',
    'https://[::1]:32147',
  ])('accepts a loopback HTTP(S) development renderer: %s', (value) => {
    expect(parseLoopbackRendererUrl(value)?.origin).toBe(new URL(value).origin);
  });

  it.each([
    'https://example.com/app',
    'http://localhost.example.com',
    'file:///tmp/index.html',
    'data:text/html,test',
    'http://user:password@localhost:32147',
  ])('rejects an untrusted development renderer: %s', (value) => {
    expect(parseLoopbackRendererUrl(value)).toBeNull();
    const selection = selectTrustedRenderer({
      isPackaged: false,
      environmentUrl: value,
      fileRendererUrl: rendererFileUrl,
    });
    expect(selection.renderer.kind).toBe('file');
    expect(selection.ignoredEnvironmentUrl).toBe(true);
  });

  it('always uses the bundled file renderer in packaged builds', () => {
    const selection = selectTrustedRenderer({
      isPackaged: true,
      environmentUrl: 'http://127.0.0.1:32147',
      fileRendererUrl: rendererFileUrl,
    });
    expect(selection.renderer.kind).toBe('file');
    expect(selection.ignoredEnvironmentUrl).toBe(true);
  });

  it('trusts only the selected origin and only the main IPC frame', () => {
    const selection = selectTrustedRenderer({
      isPackaged: false,
      environmentUrl: 'http://127.0.0.1:32147/editor',
      fileRendererUrl: rendererFileUrl,
    });
    expect(selection.renderer.kind).toBe('loopback-url');
    expect(isTrustedRendererLocation('http://127.0.0.1:32147/other?value=1', selection.renderer)).toBe(true);
    expect(isTrustedRendererLocation('http://127.0.0.1:32148/editor', selection.renderer)).toBe(false);
    expect(isTrustedRendererLocation('https://127.0.0.1:32147/editor', selection.renderer)).toBe(false);
    expect(isTrustedIpcSender('http://127.0.0.1:32147/editor', true, selection.renderer)).toBe(true);
    expect(isTrustedIpcSender('http://127.0.0.1:32147/editor', false, selection.renderer)).toBe(false);
  });

  it('trusts the exact bundled renderer file and no adjacent file', () => {
    const selection = selectTrustedRenderer({isPackaged: true, fileRendererUrl: rendererFileUrl});
    expect(isTrustedRendererLocation(rendererFileUrl, selection.renderer)).toBe(true);
    expect(isTrustedRendererLocation(pathToFileURL(path.resolve('out/renderer/other.html')).toString(), selection.renderer)).toBe(false);
  });

  it('removes credentials, queries, and fragments from diagnostic URLs', () => {
    expect(diagnosticUrl('https://user:secret@localhost:32147/editor?token=secret#value'))
      .toBe('https://localhost:32147/editor');
  });
});

describe('desktop Electron security wiring', () => {
  it('routes every IPC registration through the trusted-sender wrapper', async () => {
    const source = await fs.readFile(path.resolve('apps/desktop/src/main/index.ts'), 'utf8');
    expect(source.match(/ipcMain\.handle\(/gu)).toHaveLength(1);
    expect(source.match(/handleTrustedIpc\(/gu)?.length).toBeGreaterThan(10);
    expect(source).toContain("webContents.on('will-navigate'");
    expect(source).toContain('webContents.setWindowOpenHandler');
  });

  it('does not allow inline scripts in the renderer CSP', async () => {
    const html = await fs.readFile(path.resolve('apps/desktop/src/renderer/index.html'), 'utf8');
    const scriptPolicy = html.match(/script-src[^;]+/u)?.[0];
    expect(scriptPolicy).toBe("script-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("frame-src 'none'");
  });
});

describe('desktop persistent diagnostics', () => {
  it('writes JSONL under userData/logs and redacts common secret forms', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-diagnostics-'));
    roots.push(root);
    const diagnostics = createDesktopDiagnostics(root);
    diagnostics.error('uncaught-exception', diagnosticError(new Error('token=abc Bearer very-secret')));

    const line = JSON.parse((await fs.readFile(diagnostics.logPath, 'utf8')).trim()) as Record<string, unknown>;
    expect(line.event).toBe('uncaught-exception');
    expect(line.message).toBe('token=[redacted] Bearer [redacted]');
    expect(String(line.stack)).not.toContain('very-secret');
  });
});

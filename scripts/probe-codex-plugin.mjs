import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = 44_000 + Math.floor(Math.random() * 1_000);
const token = randomBytes(32).toString('base64url');
const dataRoot = path.join(root, '.desktop-data', 'codex-plugin-smoke');
await fs.mkdir(dataRoot, {recursive: true});

const child = spawn(process.execPath, [path.join(root, 'scripts/start-codex-plugin.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    GEN_VIDEO_STUDIO_PORT: String(port),
    GEN_VIDEO_STUDIO_TOKEN: token,
    GEN_VIDEO_STUDIO_HOME: dataRoot,
    FORCE_COLOR: '0',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-32_000); });
const pending = new Map();
let stdoutBuffer = '';
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString('utf8');
  const lines = stdoutBuffer.split(/\r?\n/u);
  stdoutBuffer = lines.pop() || '';
  for (const line of lines.filter(Boolean)) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

const request = (id, method, params = {}) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`MCP timeout for ${method}\n${stderr}`));
  }, 30_000);
  pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
  child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
});

const stop = () => {
  child.stdin.end();
  setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM'); }, 2_000).unref();
};

try {
  const initialized = await request(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: {name: 'gen-video-tool-probe', version: '0.1.0'},
  });
  if (initialized.error) throw new Error(JSON.stringify(initialized.error));
  child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized', params: {}})}\n`);
  const listed = await request(2, 'tools/list');
  const toolNames = listed.result?.tools?.map((tool) => tool.name) || [];
  for (const required of ['gen_video_get_status', 'gen_video_import_asset_pack', 'gen_video_generate_shot', 'gen_video_get_job', 'gen_video_select_candidate', 'gen_video_render_project']) {
    if (!toolNames.includes(required)) throw new Error(`Missing MCP tool: ${required}`);
  }
  const status = await request(3, 'tools/call', {name: 'gen_video_get_status', arguments: {}});
  if (status.error || status.result?.isError) throw new Error(JSON.stringify(status.error || status.result));
  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json());
  const html = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
  if (health.service !== 'gen-video-tool' || !html.includes('Codex Studio')) throw new Error('Studio browser surface did not load.');
  process.stdout.write(`${JSON.stringify({ok: true, port, tools: toolNames.length, service: health.service}, null, 2)}\n`);
} finally {
  stop();
}

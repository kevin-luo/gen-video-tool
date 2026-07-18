import {spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.GEN_VIDEO_STUDIO_PORT || 4390);
const baseUrl = process.env.GEN_VIDEO_STUDIO_URL || `http://127.0.0.1:${port}`;
const sessionToken = process.env.GEN_VIDEO_STUDIO_TOKEN || randomBytes(32).toString('base64url');
const webOnly = process.argv.includes('--web-only');
const dataDir = process.env.GEN_VIDEO_STUDIO_HOME
  || process.env.GEN_VIDEO_DESKTOP_DATA_ROOT
  || (existsSync(path.join(rootDir, '.git')) ? path.join(rootDir, '.desktop-data') : path.join(homedir(), '.gen-video-tool'));
const tsxCli = path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const serverEntry = path.join(rootDir, 'apps', 'codex-studio', 'src', 'server.ts');
const mcpEntry = path.join(rootDir, 'apps', 'codex-studio', 'src', 'mcp.ts');
let webProcess = null;
let mcpProcess = null;

const npmCommand = (args) => process.platform === 'win32'
  ? {command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args]}
  : {command: 'npm', args};

const ensurePrepared = () => {
  if (existsSync(tsxCli)) return;
  const npm = npmCommand(['install']);
  const result = spawnSync(npm.command, npm.args, {cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm install failed with exit code ${String(result.status)}.`);
};

const isReady = async () => {
  try {
    const response = await fetch(`${baseUrl}/healthz`, {signal: AbortSignal.timeout(1_500)});
    const body = await response.json();
    return response.ok && body?.ok === true && body?.service === 'gen-video-tool';
  } catch {
    return false;
  }
};

const isAuthorized = async () => {
  try {
    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {authorization: `Bearer ${sessionToken}`},
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const pipe = (child, prefix) => {
  child.stdout?.on('data', (chunk) => process.stderr.write(`[${prefix}] ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[${prefix}] ${chunk}`));
};

const sharedEnvironment = () => ({
  ...process.env,
  FORCE_COLOR: '0',
  GEN_VIDEO_STUDIO_URL: baseUrl,
  GEN_VIDEO_STUDIO_PORT: String(port),
  GEN_VIDEO_STUDIO_TOKEN: sessionToken,
  GEN_VIDEO_STUDIO_HOME: dataDir,
});

const startWebIfNeeded = async () => {
  if (await isReady()) {
    if (await isAuthorized()) return;
    throw new Error(`Gen Video Studio is already running at ${baseUrl} with a different session. Stop that process or choose another GEN_VIDEO_STUDIO_PORT.`);
  }
  await mkdir(dataDir, {recursive: true});
  webProcess = spawn(process.execPath, [tsxCli, serverEntry], {
    cwd: rootDir,
    env: sharedEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  pipe(webProcess, 'gen-video-web');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await isReady()) return;
    if (webProcess.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Gen Video Studio could not start at ${baseUrl}.`);
};

const stopChildren = () => {
  if (mcpProcess && mcpProcess.exitCode === null) mcpProcess.kill('SIGTERM');
  if (webProcess && webProcess.exitCode === null) webProcess.kill('SIGTERM');
};

const main = async () => {
  ensurePrepared();
  await startWebIfNeeded();
  const studioUrl = `${baseUrl}/?session=${encodeURIComponent(sessionToken)}`;
  process.stderr.write(`[gen-video-tool] Studio ready at ${studioUrl}\n`);
  if (webOnly) {
    if (!webProcess) throw new Error('Web-only mode cannot take ownership of an existing studio process.');
    const exitCode = await new Promise((resolve) => webProcess.once('exit', (code) => resolve(code ?? 1)));
    process.exitCode = exitCode;
    return;
  }
  mcpProcess = spawn(process.execPath, [tsxCli, mcpEntry], {
    cwd: rootDir,
    env: sharedEnvironment(),
    stdio: ['inherit', 'inherit', 'inherit'],
    windowsHide: true,
  });
  mcpProcess.once('error', (error) => {
    process.stderr.write(`[gen-video-mcp] ${error.message}\n`);
    stopChildren();
  });
  const exitCode = await new Promise((resolve) => mcpProcess.once('exit', (code) => resolve(code ?? 1)));
  stopChildren();
  process.exitCode = exitCode;
};

process.on('SIGINT', stopChildren);
process.on('SIGTERM', stopChildren);
process.on('exit', stopChildren);

main().catch((error) => {
  process.stderr.write(`[gen-video-tool] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  stopChildren();
  process.exitCode = 1;
});

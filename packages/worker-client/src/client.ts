import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  motionWorkerRequestSchema,
  motionWorkerResultSchema,
  type MotionWorkerRequest,
  type MotionWorkerResult,
} from './protocol';

const allowedExecutableExtensions = new Set(process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['', '.app']);

const assertExecutable = (executable: string) => {
  if (!path.isAbsolute(executable)) throw new Error('WORKER_EXECUTABLE_NOT_ABSOLUTE');
  const extension = path.extname(executable).toLowerCase();
  if (!allowedExecutableExtensions.has(extension)) throw new Error('WORKER_EXECUTABLE_EXTENSION_BLOCKED');
};

export const runMotionWorker = async (
  executable: string,
  input: MotionWorkerRequest,
  options: {projectPath: string; timeoutMs?: number} ,
): Promise<MotionWorkerResult> => {
  assertExecutable(executable);
  const request = motionWorkerRequestSchema.parse(input);
  const projectPath = path.resolve(options.projectPath);
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-motion-worker-'));
  const requestPath = path.join(tempDirectory, 'request.json');
  const resultPath = path.join(tempDirectory, 'result.json');
  await fs.writeFile(requestPath, JSON.stringify(request, null, 2), 'utf8');
  const args = ['--headless', '--path', projectPath, '--', '--request', requestPath, '--result', resultPath];

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('WORKER_TIMEOUT'));
      }, options.timeoutMs ?? 120_000);
      child.once('error', reject);
      child.once('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`WORKER_EXIT_${code ?? 'UNKNOWN'}: ${stderr.trim()}`));
      });
    });
    const raw = JSON.parse(await fs.readFile(resultPath, 'utf8')) as unknown;
    return motionWorkerResultSchema.parse(raw);
  } finally {
    await fs.rm(tempDirectory, {recursive: true, force: true});
  }
};

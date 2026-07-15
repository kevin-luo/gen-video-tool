import fs from 'node:fs';
import path from 'node:path';

const executableName = (name: 'ffmpeg' | 'ffprobe') => process.platform === 'win32' ? `${name}.exe` : name;

export const findRemotionTool = (root: string, name: 'ffmpeg' | 'ffprobe'): string => {
  const environment = process.env[`${name.toUpperCase()}_PATH`];
  if (environment && path.isAbsolute(environment) && fs.existsSync(environment)) return environment;
  const remotionRoot = path.join(root, 'node_modules', '@remotion');
  if (fs.existsSync(remotionRoot)) {
    for (const directory of fs.readdirSync(remotionRoot)) {
      if (!directory.startsWith('compositor-')) continue;
      const candidate = path.join(remotionRoot, directory, executableName(name));
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return executableName(name);
};

export const findBrowserExecutable = (): string | null => {
  const candidates = [
    process.env.REMOTION_BROWSER_EXECUTABLE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
};

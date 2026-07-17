import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {_electron as electron} from 'playwright';

const projectRoot = process.cwd();
const qaDirectory = path.join(projectRoot, '.desktop-data', 'qa');
const screenshotPath = path.join(qaDirectory, 'electron-startup-smoke.png');
const dataRoot = path.resolve(
  process.env.GEN_VIDEO_SMOKE_DATA_ROOT || path.join(projectRoot, '.desktop-data', 'startup-smoke'),
);
const openProjectTitle = process.env.GEN_VIDEO_SMOKE_OPEN_PROJECT?.trim();
const stderr = [];
const rendererErrors = [];
let rendererCrashed = false;

await fs.mkdir(qaDirectory, {recursive: true});

const application = await electron.launch({
  // Keep this identical to the desktop shortcut's product startup. Windows
  // compatibility is configured by the application itself, not hidden in the
  // automation harness.
  args: ['.'],
  cwd: projectRoot,
  env: {
    ...process.env,
    GEN_VIDEO_DESKTOP_DATA_ROOT: dataRoot,
  },
  timeout: 20_000,
});

application.process().stderr?.on('data', (chunk) => stderr.push(String(chunk)));

try {
  const page = await application.firstWindow({timeout: 20_000});
  page.on('crash', () => { rendererCrashed = true; });
  page.on('pageerror', (error) => rendererErrors.push(error.message));

  await page.waitForLoadState('domcontentloaded');
  if (openProjectTitle) {
    const projectButton = page.getByRole('button', {name: `打开 ${openProjectTitle}`, exact: true});
    await projectButton.waitFor({state: 'visible', timeout: 20_000});
    await projectButton.click();
    await page.getByText(openProjectTitle, {exact: true}).first().waitFor({state: 'visible', timeout: 20_000});
  }
  await page.waitForTimeout(12_000);
  await page.screenshot({path: screenshotPath, fullPage: true});

  const result = {
    title: await page.title(),
    url: page.url(),
    dataRoot,
    openedProject: openProjectTitle ?? null,
    rendererCrashed,
    rendererErrors,
    bodyText: (await page.locator('body').innerText()).slice(0, 240),
    screenshotPath,
    fatalGpuError: stderr.some((line) => line.includes("GPU process isn't usable")),
    stderr: stderr.join('').slice(-4_000),
  };

  console.log(JSON.stringify(result, null, 2));
  if (rendererCrashed || rendererErrors.length > 0 || result.fatalGpuError) process.exitCode = 1;
} catch (error) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.error(JSON.stringify({
    error: error instanceof Error ? error.stack : String(error),
    stderr: stderr.join('').slice(-8_000),
  }, null, 2));
  process.exitCode = 1;
} finally {
  await application.close();
}

import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const readJson = (relativePath: string) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8')) as Record<string, unknown>;

describe('Codex plugin distribution', () => {
  it('publishes one root plugin, marketplace entry, MCP launcher, and bundled skills', () => {
    const plugin = readJson('.codex-plugin/plugin.json');
    const marketplace = readJson('.agents/plugins/marketplace.json') as {plugins: Array<{name: string; policy: object}>};
    const mcp = readJson('.mcp.json') as {mcpServers: Record<string, {args: string[]}>};
    expect(plugin.name).toBe('gen-video-tool');
    expect(plugin.skills).toBe('./skills/');
    expect(plugin.mcpServers).toBe('./.mcp.json');
    expect(marketplace.plugins[0]).toMatchObject({
      name: 'gen-video-tool',
      policy: {installation: 'AVAILABLE', authentication: 'ON_INSTALL'},
    });
    expect(mcp.mcpServers['gen-video-tool']?.args.join(' ')).toContain('scripts/start-codex-plugin.mjs');
    expect(fs.existsSync(path.join(root, 'skills/gen-video-studio/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'skills/create-gen-video-asset-pack/SKILL.md'))).toBe(true);
  });

  it('has no scaffold placeholders in the user-facing plugin artifacts', () => {
    for (const relativePath of ['.codex-plugin/plugin.json', 'skills/gen-video-studio/SKILL.md', 'skills/gen-video-studio/agents/openai.yaml']) {
      expect(fs.readFileSync(path.join(root, relativePath), 'utf8')).not.toContain('[TODO:');
    }
  });
});

import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';

export const templateMarketEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  category: z.enum(['sports', 'story', 'explainer', 'commerce']),
  summary: z.string().min(1),
  sourcePath: z.string().regex(/^[^\\/](?:[^\\]*[^\\/])?$/),
  actions: z.array(z.string()).default([]),
  recipes: z.array(z.string()).default([]),
}).strict();

export const templateCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  templates: z.array(templateMarketEntrySchema),
}).strict();

export type TemplateMarketEntry = z.infer<typeof templateMarketEntrySchema>;

const safeRelative = (root: string, relativePath: string): string => {
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('TEMPLATE_SOURCE_OUTSIDE_CATALOG');
  return target;
};

export const loadTemplateCatalog = async (catalogPath: string): Promise<TemplateMarketEntry[]> => {
  const raw = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as unknown;
  return templateCatalogSchema.parse(raw).templates;
};

export const installTemplate = async (catalogPath: string, templateId: string, installRoot: string): Promise<string> => {
  const entry = (await loadTemplateCatalog(catalogPath)).find((candidate) => candidate.id === templateId);
  if (!entry) throw new Error('TEMPLATE_NOT_FOUND');
  const source = safeRelative(path.dirname(catalogPath), entry.sourcePath);
  const targetDirectory = path.join(path.resolve(installRoot), entry.id);
  await fs.mkdir(targetDirectory, {recursive: true});
  await fs.copyFile(source, path.join(targetDirectory, 'template.json'));
  await fs.writeFile(path.join(targetDirectory, 'install.json'), `${JSON.stringify({id: entry.id, version: entry.version, installedAt: new Date().toISOString()}, null, 2)}\n`, 'utf8');
  return targetDirectory;
};

import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import express, {type ErrorRequestHandler, type RequestHandler} from 'express';
import {z} from 'zod';

import {
  rejectLocalProductionCandidate,
  selectLocalProductionCandidate,
} from '../../../scripts/local-production.js';
import {createStudioConfig, type StudioConfig} from './config.js';
import {StudioJobRunner, type StudioJobAction} from './job-runner.js';
import {ProjectService} from './project-service.js';

const webRoot = path.resolve(import.meta.dirname, '../web');

const asyncRoute = (handler: (request: express.Request, response: express.Response) => Promise<void>): RequestHandler =>
  (request, response, next) => { void handler(request, response).catch(next); };

const routeParam = (request: express.Request, name: string): string => {
  const value = request.params[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name.toUpperCase()}_REQUIRED`);
  return value;
};

const readBearer = (authorization: string | undefined): string | null => {
  if (!authorization?.startsWith('Bearer ')) return null;
  return authorization.slice('Bearer '.length);
};

const requestToken = (request: express.Request): string | null =>
  readBearer(request.get('authorization'))
  ?? (typeof request.query.session === 'string' ? request.query.session : null);

const assertLocalOrigin = (request: express.Request, config: StudioConfig): void => {
  const origin = request.get('origin');
  if (!origin) return;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error('STUDIO_ORIGIN_REJECTED'); }
  if (parsed.origin !== config.baseUrl) throw new Error('STUDIO_ORIGIN_REJECTED');
};

const secureHeaders: RequestHandler = (_request, response, next) => {
  response.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; form-action 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
};

export const createStudioApp = async (config = createStudioConfig()) => {
  const app = express();
  const projects = new ProjectService(config);
  const jobs = new StudioJobRunner(config);
  await Promise.all([projects.initialize(), jobs.initialize()]);

  app.disable('x-powered-by');
  app.use(secureHeaders);
  app.use(express.json({limit: '1mb'}));

  app.get('/healthz', (_request, response) => response.json({ok: true, service: 'gen-video-tool'}));

  app.use('/api', (request, response, next) => {
    try {
      assertLocalOrigin(request, config);
      if (requestToken(request) !== config.sessionToken) {
        response.status(401).json({error: 'STUDIO_SESSION_REQUIRED'});
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/status', asyncRoute(async (_request, response) => {
    const projectList = await projects.listProjects();
    response.json({
      ok: true,
      service: 'gen-video-tool',
      studioUrl: `${config.baseUrl}/?session=${encodeURIComponent(config.sessionToken)}`,
      projectCount: projectList.length,
      projectsRoot: config.projectsRoot,
      outputRoot: config.outputRoot,
      activeJob: jobs.list().find((job) => job.status === 'running') ?? null,
    });
  }));

  app.get('/api/projects', asyncRoute(async (_request, response) => {
    const list = await projects.listProjects();
    response.json({total: list.length, projects: list});
  }));
  app.get('/api/projects/:projectId', asyncRoute(async (request, response) => {
    response.json(await projects.getProject(routeParam(request, 'projectId')));
  }));
  app.post('/api/packs/inspect', asyncRoute(async (request, response) => {
    const input = z.object({sourcePath: z.string().min(1).max(4_000)}).parse(request.body);
    response.json(await projects.inspectPack(input.sourcePath));
  }));
  app.post('/api/packs/import', asyncRoute(async (request, response) => {
    const input = z.object({
      sourcePath: z.string().min(1).max(4_000),
      destinationName: z.string().max(128).optional(),
    }).parse(request.body);
    response.json(await projects.importPack(input.sourcePath, input.destinationName));
  }));

  const startJob = (action: StudioJobAction, shotRequired = false): RequestHandler => asyncRoute(async (request, response) => {
    const projectId = routeParam(request, 'projectId');
    await projects.getProject(projectId);
    const shotId = shotRequired ? routeParam(request, 'shotId') : undefined;
    response.status(202).json(await jobs.start(action, projectId, shotId));
  });
  app.post('/api/projects/:projectId/detect', startJob('detect-runtime'));
  app.post('/api/projects/:projectId/shots/:shotId/generate', startJob('generate-shot', true));
  app.post('/api/projects/:projectId/narrate', startJob('synthesize-narration'));
  app.post('/api/projects/:projectId/render', startJob('render-project'));

  app.post('/api/projects/:projectId/shots/:shotId/candidates/:candidateId/select', asyncRoute(async (request, response) => {
    const input = z.object({notes: z.string().max(4_000).optional()}).parse(request.body ?? {});
    const {projectRoot} = await projects.getProject(routeParam(request, 'projectId'));
    response.json(await selectLocalProductionCandidate({
      projectRoot,
      shotId: routeParam(request, 'shotId'),
      candidateId: routeParam(request, 'candidateId'),
      ...(input.notes?.trim() ? {notes: input.notes.trim()} : {}),
    }));
  }));
  app.post('/api/projects/:projectId/shots/:shotId/candidates/:candidateId/reject', asyncRoute(async (request, response) => {
    const input = z.object({notes: z.string().min(1).max(4_000)}).parse(request.body);
    const {projectRoot} = await projects.getProject(routeParam(request, 'projectId'));
    response.json(await rejectLocalProductionCandidate({
      projectRoot,
      shotId: routeParam(request, 'shotId'),
      candidateId: routeParam(request, 'candidateId'),
      notes: input.notes.trim(),
    }));
  }));

  app.get('/api/jobs', (_request, response) => response.json({jobs: jobs.list()}));
  app.get('/api/jobs/:jobId', (request, response) => response.json(jobs.get(routeParam(request, 'jobId'))));
  app.post('/api/jobs/:jobId/cancel', asyncRoute(async (request, response) => {
    response.json(await jobs.cancel(routeParam(request, 'jobId')));
  }));

  app.get('/api/media', asyncRoute(async (request, response) => {
    const input = z.object({
      scope: z.enum(['project', 'output']),
      projectId: z.string().min(1).max(128),
      path: z.string().min(1).max(4_000),
    }).parse(request.query);
    const mediaPath = input.scope === 'project'
      ? projects.resolveProjectMedia(input.projectId, input.path)
      : projects.resolveOutputMedia(input.projectId, input.path);
    await fs.access(mediaPath);
    response.sendFile(mediaPath);
  }));

  app.get('/tokens.css', (_request, response) => response.sendFile(path.join(config.repositoryRoot, 'apps/desktop/src/renderer/styles/tokens.css')));
  app.get('/studio.css', (_request, response) => response.sendFile(path.join(webRoot, 'studio.css')));
  app.get('/studio.js', (_request, response) => response.sendFile(path.join(webRoot, 'studio.js')));
  app.get('/', (_request, response) => response.sendFile(path.join(webRoot, 'index.html')));

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('NOT_FOUND') || (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 404
      : message.includes('CONFLICT') || message.includes('LOCK') ? 409 : 400;
    response.status(status).json({error: message.slice(0, 4_000)});
  };
  app.use(errorHandler);
  return app;
};

const main = async (): Promise<void> => {
  const config = createStudioConfig();
  const app = await createStudioApp(config);
  app.listen(config.port, config.host, () => {
    process.stderr.write(`[gen-video-studio] ready at ${config.baseUrl}\n`);
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

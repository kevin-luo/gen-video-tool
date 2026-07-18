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
import {CreationService, CREATION_PLATFORMS, type CreationRecord} from './creation-service.js';
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
  const creations = new CreationService(config);
  const jobs = new StudioJobRunner(config);
  await Promise.all([projects.initialize(), creations.initialize(), jobs.initialize()]);

  const creationView = (creation: CreationRecord) => {
    if (!creation.jobId) {
      return creation.assetStatus === 'awaiting-assets'
        ? {
            ...creation,
            status: 'awaiting-assets',
            progress: 0.05,
            stage: 'prepare-paper-assets',
            detail: '等待完整角色与分层纸片资产',
            message: '等待完整角色与分层纸片资产',
            job: null,
          }
        : {...creation, status: 'draft', progress: 0, stage: 'draft', job: null};
    }
    try {
      const job = jobs.get(creation.jobId);
      let stage: string = job.status;
      let detail: string | undefined;
      for (const log of [...job.logs].reverse()) {
        try {
          const event = JSON.parse(log.text) as {event?: string; stage?: string; detail?: string; phase?: string};
          if (event.event === 'quick-progress' || event.event === 'paper-collage-progress') {
            stage = event.stage ?? stage;
            detail = event.detail;
            break;
          }
          if (event.event === 'render-progress') {
            stage = 'render-paper-collage';
            detail = typeof event.phase === 'string'
              ? `正在渲染纸片动画：${event.phase}`
              : '正在渲染纸片动画';
            break;
          }
        } catch {
          // Provider logs are intentionally not part of the creator-facing view.
        }
      }
      const result = typeof job.result === 'object' && job.result !== null
        ? job.result as Record<string, unknown>
        : null;
      const mediaPath = (value: unknown): string | null => {
        if (typeof value !== 'string' || !value.trim()) return null;
        const query = new URLSearchParams({
          scope: 'output',
          projectId: creation.id,
          path: value,
        });
        return `/api/media?${query.toString()}`;
      };
      const videoPath = mediaPath(result?.videoPath);
      const subtitlePath = mediaPath(result?.subtitlePath);
      const thumbnailPath = mediaPath(result?.thumbnailPath);
      const output = videoPath === null ? undefined : {
        videoPath,
        ...(subtitlePath === null ? {} : {subtitlePath}),
        ...(thumbnailPath === null ? {} : {thumbnailPath}),
      };
      return {
        ...creation,
        status: job.status,
        progress: job.progress,
        stage,
        ...(detail ? {detail, message: detail} : {}),
        ...(job.error ? {error: job.error} : {}),
        ...(output === undefined ? {} : {output}),
        ...(typeof result?.durationSeconds === 'number' ? {durationSeconds: result.durationSeconds} : {}),
        job: {
          id: job.id,
          status: job.status,
          progress: job.progress,
          ...(job.error ? {error: job.error} : {}),
          ...(job.result === undefined ? {} : {result: job.result}),
        },
      };
    } catch {
      return {...creation, status: 'interrupted', progress: 0, stage: 'interrupted', job: null};
    }
  };

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
    const [projectList, creationList] = await Promise.all([projects.listProjects(), creations.list()]);
    response.json({
      ok: true,
      service: 'gen-video-tool',
      studioUrl: `${config.baseUrl}/?session=${encodeURIComponent(config.sessionToken)}`,
      projectCount: projectList.length,
      creationCount: creationList.length,
      projectsRoot: config.projectsRoot,
      outputRoot: config.outputRoot,
      activeJob: jobs.list().find((job) => job.status === 'running') ?? null,
    });
  }));

  app.get('/api/creations', asyncRoute(async (_request, response) => {
    const list = (await creations.list()).map(creationView);
    response.json({total: list.length, creations: list});
  }));
  app.get('/api/creations/:creationId', asyncRoute(async (request, response) => {
    response.json(creationView(await creations.get(routeParam(request, 'creationId'))));
  }));
  app.post('/api/creations', asyncRoute(async (request, response) => {
    const input = z.object({
      script: z.string().trim().min(2).max(300),
      platform: z.enum(CREATION_PLATFORMS).default('douyin'),
      durationSeconds: z.number().int().min(20).max(60).default(20),
      voice: z.boolean().default(true),
    }).parse(request.body);
    const creation = await creations.create(input);
    response.status(202).json(creationView(creation));
  }));
  const restartCreation: RequestHandler = asyncRoute(async (request, response) => {
    const creation = await creations.get(routeParam(request, 'creationId'));
    if (creation.assetStatus !== 'ready') throw new Error('PAPER_COLLAGE_ASSET_PROJECT_REQUIRED');
    if (creation.jobId) {
      const current = jobs.get(creation.jobId);
      if (current.status === 'queued' || current.status === 'running') {
        response.status(202).json(creationView(creation));
        return;
      }
    }
    const job = await jobs.start('produce-video', creation.id);
    response.status(202).json(creationView(await creations.attachJob(creation.id, job.id)));
  });
  app.post('/api/creations/:creationId/retry', restartCreation);
  app.post('/api/creations/:creationId/finalize', restartCreation);
  app.post('/api/creations/:creationId/assets/inspect', asyncRoute(async (request, response) => {
    const creationId = routeParam(request, 'creationId');
    await creations.get(creationId);
    const input = z.object({sourcePath: z.string().trim().min(1).max(4_000)}).parse(request.body);
    response.json(await creations.inspectPaperProject(creationId, input.sourcePath));
  }));
  app.post('/api/creations/:creationId/assets', asyncRoute(async (request, response) => {
    const creationId = routeParam(request, 'creationId');
    const input = z.object({sourcePath: z.string().trim().min(1).max(4_000)}).parse(request.body);
    let creation = await creations.attachPaperProject(creationId, input.sourcePath);
    let hasActiveJob = false;
    if (creation.jobId) {
      try {
        const current = jobs.get(creation.jobId);
        hasActiveJob = current.status === 'queued' || current.status === 'running';
      } catch {
        // The bounded job history may no longer contain an old creation job.
      }
    }
    if (!hasActiveJob) {
      const job = await jobs.start('produce-video', creation.id);
      creation = await creations.attachJob(creation.id, job.id);
    }
    response.status(202).json(creationView(creation));
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
    await new Promise<void>((resolve, reject) => {
      response.sendFile(mediaPath, {
        acceptRanges: true,
        cacheControl: false,
        dotfiles: 'allow',
      }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
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

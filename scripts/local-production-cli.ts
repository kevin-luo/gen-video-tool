import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  detectLocalProductionRuntime,
  generateLocalProductionShot,
  getLocalProductionStatus,
  rejectLocalProductionCandidate,
  selectLocalProductionCandidate,
} from './local-production';

const usage = `Usage:
  npm run local:production -- detect <projectRoot>
  npm run local:production -- status <projectRoot>
  npm run local:production -- generate <projectRoot> <shotId>
  npm run local:production -- select <projectRoot> <shotId> <candidateId> [--notes=<text>]
  npm run local:production -- reject <projectRoot> <shotId> <candidateId> [--notes=<text>]

All generation is local-only. generate serializes the two immutable seeds and never selects a candidate.
select and reject are explicit human review actions.`;

export const runLocalProductionCli = async (argv: readonly string[]): Promise<number> => {
  const [command, projectRootValue, shotId, candidateId, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage);
    return command === undefined ? 1 : 0;
  }
  if (!projectRootValue) throw new Error('LOCAL_PRODUCTION_PROJECT_ROOT_REQUIRED');
  const projectRoot = path.resolve(projectRootValue);
  if (command === 'detect') {
    const result = await detectLocalProductionRuntime(projectRoot);
    console.log(JSON.stringify(result, null, 2));
    return result.available ? 0 : 2;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await getLocalProductionStatus(projectRoot), null, 2));
    return 0;
  }
  if (command === 'generate') {
    if (!shotId) throw new Error('LOCAL_PRODUCTION_SHOT_ID_REQUIRED');
    const lastProgressByCandidate = new Map<string, string>();
    const result = await generateLocalProductionShot({
      projectRoot,
      shotId,
      onProgress: (activeCandidateId, job) => {
        const roundedPercent = Math.round(job.progress * 100);
        const signature = `${job.status}:${roundedPercent}`;
        if (lastProgressByCandidate.get(activeCandidateId) === signature) return;
        lastProgressByCandidate.set(activeCandidateId, signature);
        console.error(`[${activeCandidateId}] ${job.status} ${roundedPercent}%`);
      },
    });
    console.log(JSON.stringify(result, null, 2));
    return result.failed.length === 0 ? 0 : 2;
  }
  if (command === 'select') {
    if (!shotId) throw new Error('LOCAL_PRODUCTION_SHOT_ID_REQUIRED');
    if (!candidateId) throw new Error('LOCAL_PRODUCTION_CANDIDATE_ID_REQUIRED');
    const notesArgument = rest.find((argument) => argument.startsWith('--notes='));
    const notes = notesArgument?.slice('--notes='.length).trim();
    const result = await selectLocalProductionCandidate({
      projectRoot,
      shotId,
      candidateId,
      ...(notes ? {notes} : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (command === 'reject') {
    if (!shotId) throw new Error('LOCAL_PRODUCTION_SHOT_ID_REQUIRED');
    if (!candidateId) throw new Error('LOCAL_PRODUCTION_CANDIDATE_ID_REQUIRED');
    const notesArgument = rest.find((argument) => argument.startsWith('--notes='));
    const notes = notesArgument?.slice('--notes='.length).trim();
    const result = await rejectLocalProductionCandidate({
      projectRoot,
      shotId,
      candidateId,
      ...(notes ? {notes} : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  throw new Error(`LOCAL_PRODUCTION_COMMAND_UNKNOWN:${command}\n${usage}`);
};

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  runLocalProductionCli(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}

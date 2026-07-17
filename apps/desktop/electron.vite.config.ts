import {createDesktopConfig, findRepositoryRoot} from '../../electron.vite.config';

// Keep one desktop build graph and one output directory. Workspace commands
// intentionally reuse the repository-root factory so they cannot create a
// stale second copy under apps/desktop/out.
export default createDesktopConfig(findRepositoryRoot());

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

/**
 * Build identity shown in the sidebar, on the environment page, in logs and by
 * `hubium version`, fixed at build time: the version from the root manifest, the commit from
 * BUILD_COMMIT (Docker and CI builds have no .git) or the checkout, and the build time.
 */
export function buildInfo() {
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  let commit = process.env.BUILD_COMMIT?.trim() ?? '';
  if (!commit) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Not a git checkout: the version alone identifies the build.
    }
  }
  return {
    HUBIUM_VERSION: version,
    HUBIUM_COMMIT: commit.slice(0, 7),
    HUBIUM_BUILT_AT: new Date().toISOString(),
  };
}

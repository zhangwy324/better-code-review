// `render --open` (#34): opens review.html with the system's default handler, normally the
// browser. It resolves once the opener starts and does not wait for it, so a desktop handler that
// keeps running never holds the CLI up. Opening is best effort: the caller reports a failure.
import { spawn as nodeSpawn } from 'node:child_process';

/** The command that opens a file with its default handler on `platform`. */
function opener(platform: NodeJS.Platform, path: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [path]];
  // explorer.exe opens a file with its default handler, without cmd's `start` quoting rules.
  if (platform === 'win32') return ['explorer.exe', [path]];
  return ['xdg-open', [path]];
}

/** The platform and `spawn` to use; tests replace them, so no browser starts. */
export interface OpenEnv {
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
}

export function openFile(
  path: string,
  { platform = process.platform, spawn = nodeSpawn }: OpenEnv = {},
): Promise<void> {
  const [command, args] = opener(platform, path);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

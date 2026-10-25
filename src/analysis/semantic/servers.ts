// Which language servers we know, how we find one already installed (MVP spec D11: never
// install or download), and the exact command we would run. Discovery only reads files, plus
// one `git ls-files` in `checkProjectPackages`: it never executes a server to probe a version.
// README.md lists the resulting commands.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveExecutable } from '../../git/run.ts';

export type ServerId = 'typescript' | 'python' | 'java' | 'rust';

/** How the session decides a server has loaded the project (README, "Readiness"). */
export type Readiness = 'stable-answers' | 'service-ready';

/** An exact command line, plus what we send the server once it runs. */
export interface Launch {
  /** Server name as reported in the artifact, e.g. `typescript-language-server`. */
  name: string;
  /** From the server's package.json; replaced by `serverInfo.version` when it sends one. */
  version: string | null;
  command: string;
  args: string[];
  /** Only for Windows `.cmd`/`.bat` launchers, which Node cannot run without a shell. */
  shell: boolean;
  initializationOptions: unknown;
  /** Answers to `workspace/configuration`. */
  settings: Record<string, unknown>;
  /** Which setup was used, shown in the artifact, e.g. `TypeScript 5.9.3 from the project`. */
  configuration: string;
}

/** A user-supplied server command that replaces discovery for one server. */
export interface ServerOverride {
  command: string;
  args?: string[];
  initializationOptions?: unknown;
  settings?: Record<string, unknown>;
}

export interface DiscoveryContext {
  root: string;
  /** The `PATH` to search, without the entries `safeSearchPath` drops unless project code is allowed. */
  searchPath: string;
  allowProjectCode: boolean;
  /** Why the project's `node_modules` may hold project code (`checkProjectPackages`), or null. */
  untrustedPackages: string | null;
  platform: NodeJS.Platform;
}

export type Discovery = { launch: Launch } | { launch: null; why: string };

export interface ServerSpec {
  id: ServerId;
  /** Grammar names (`AnalyzedFile.language`) this server covers. */
  languages: readonly string[];
  /** Used in guidance, e.g. "Python callers: possible only — …". */
  label: string;
  /** What to install when no server is found. */
  installHint: string;
  /** Why this server runs project code while indexing, or null. Non-null needs an opt-in (D11). */
  runsProjectCode: string | null;
  readiness: Readiness;
  /** What to do when the project does not resolve. */
  healthHint: string;
  discover(ctx: DiscoveryContext): Discovery;
}

export const SERVERS: readonly ServerSpec[] = [
  {
    id: 'typescript',
    languages: ['typescript', 'tsx', 'javascript'],
    label: 'TypeScript/JavaScript',
    installHint:
      'install typescript-language-server with TypeScript 5.x, or use TypeScript 7 (`tsc --lsp`) in the project',
    runsProjectCode: null,
    readiness: 'stable-answers',
    healthHint: "Install the project's dependencies (e.g. `npm ci`) so imports resolve.",
    discover: discoverTypeScript,
  },
  {
    id: 'python',
    languages: ['python'],
    label: 'Python',
    installHint: 'install pyright (`npm i -g pyright`) to verify',
    runsProjectCode: null,
    readiness: 'stable-answers',
    healthHint:
      "Install the project's dependencies where pyright finds them, or add its source roots to pyright's extraPaths.",
    discover: discoverPython,
  },
  {
    id: 'java',
    languages: ['java'],
    label: 'Java',
    installHint: 'install jdtls (needs a Java 25 runtime for jdtls 1.62) to verify',
    runsProjectCode: 'jdtls imports Maven and Gradle builds, which runs build scripts and plugins',
    readiness: 'service-ready',
    healthHint: 'Check that the Maven or Gradle import succeeds (dependencies downloaded).',
    discover: (ctx) => {
      const jdtls = findOnPath('jdtls', ctx);
      if (!jdtls) return { launch: null, why: 'jdtls not found' };
      // jdtls keeps its workspace index in -data; one per project root, outside the repository.
      const hash = createHash('sha256').update(ctx.root).digest('hex').slice(0, 16);
      const data = join(tmpdir(), 'better-code-review', 'jdtls', hash);
      return {
        launch: {
          name: 'jdtls',
          version: null,
          ...executable(jdtls, ['-data', data], ctx),
          initializationOptions: {},
          settings: {},
          configuration: `workspace data in ${data}`,
        },
      };
    },
  },
  {
    id: 'rust',
    languages: ['rust'],
    label: 'Rust',
    installHint: 'install rust-analyzer (`rustup component add rust-analyzer`) to verify',
    runsProjectCode: 'rust-analyzer runs build scripts (build.rs) and procedural macros',
    readiness: 'stable-answers',
    healthHint: 'Check that `cargo metadata` succeeds for the workspace.',
    discover: (ctx) => {
      const ra = findOnPath('rust-analyzer', ctx);
      if (!ra) return { launch: null, why: 'rust-analyzer not found' };
      return {
        launch: {
          name: 'rust-analyzer',
          version: null,
          ...executable(ra, [], ctx),
          initializationOptions: {},
          settings: {},
          configuration: 'default settings',
        },
      };
    },
  },
];

export function serverFor(language: string): ServerSpec | undefined {
  return SERVERS.find((s) => s.languages.includes(language));
}

/** The launch for an override: the user's command, run as given. */
export function overrideLaunch(override: ServerOverride, ctx: DiscoveryContext): Launch {
  const command = findOnPath(override.command, ctx) ?? override.command;
  return {
    name: override.command,
    version: null,
    ...executable(command, override.args ?? [], ctx),
    initializationOptions: override.initializationOptions ?? {},
    settings: override.settings ?? {},
    configuration: 'user-configured command',
  };
}

// ---------------------------------------------------------------------------------------------
// TypeScript: prefer the project's own TypeScript (ADR 0001). TS 7 (Go-native) has no
// tsserver.js, so it is served by its built-in `tsc --lsp`; TS 5.x/6.x through
// typescript-language-server, which fails to start on TS 7.

function discoverTypeScript(ctx: DiscoveryContext): Discovery {
  return withPackagesNote(ctx, findTypeScript(ctx));
}

// Automatic type acquisition runs `npm install @types/…` for the project's dependencies, from the
// registry (D11: never install or download). Both servers do it by default.
const NO_TYPE_ACQUISITION = {
  disableAutomaticTypeAcquisition: true,
  tsserver: { automaticTypeAcquisition: { enabled: false } },
};

function findTypeScript(ctx: DiscoveryContext): Discovery {
  const projectTs = projectPackage('typescript', ctx);
  if (projectTs && major(projectTs.version) >= 7) {
    return { launch: tscLsp(projectTs, 'from the project', ctx) };
  }

  const tsls = findNodePackage('typescript-language-server', 'typescript-language-server', ctx);
  if (tsls) {
    // The TypeScript it will load: the project's, else the one it resolves itself.
    const ts =
      projectTs ?? readPackage(resolvePackageDir('typescript', tsls.dir), 'typescript') ?? null;
    if (ts && major(ts.version) < 7) {
      const where = ts === projectTs ? 'from the project' : `next to ${tsls.name}`;
      return {
        launch: {
          name: 'typescript-language-server',
          version: tsls.version,
          ...nodeBin(tsls, 'typescript-language-server', ['--stdio'], ctx),
          initializationOptions: {
            tsserver: { path: join(ts.dir, 'lib') },
            disableAutomaticTypingAcquisition: true,
          },
          settings: {},
          configuration: `TypeScript ${ts.version} ${where}, via typescript-language-server`,
        },
      };
    }
  }

  const tsc = findNodePackage('tsc', 'typescript', ctx);
  if (tsc && major(tsc.version) >= 7) return { launch: tscLsp(tsc, 'on PATH', ctx) };

  return {
    launch: null,
    why: tsls
      ? 'typescript-language-server was found, but no TypeScript 5.x/6.x for it to load'
      : 'neither typescript-language-server nor TypeScript 7 was found',
  };
}

function tscLsp(ts: NodePackage, where: string, ctx: DiscoveryContext): Launch {
  return {
    name: 'tsc --lsp',
    version: ts.version,
    ...nodeBin(ts, 'tsc', ['--lsp', '--stdio'], ctx),
    initializationOptions: {},
    // TS 7 reads this from `js/ts`; older builds from `typescript` and `javascript`.
    settings: {
      'js/ts': NO_TYPE_ACQUISITION,
      typescript: NO_TYPE_ACQUISITION,
      javascript: NO_TYPE_ACQUISITION,
    },
    configuration: `TypeScript ${ts.version} ${where}, native \`tsc --lsp\``,
  };
}

// ---------------------------------------------------------------------------------------------
// Python: pyright (or basedpyright). Projects with a `src/` layout need `src` on the search path,
// or pyright silently returns a fraction of the references (#42: 4 of 37 on click).

function discoverPython(ctx: DiscoveryContext): Discovery {
  return withPackagesNote(ctx, findPython(ctx));
}

function findPython(ctx: DiscoveryContext): Discovery {
  const pkg =
    findNodePackage('pyright-langserver', 'pyright', ctx) ??
    findNodePackage('basedpyright-langserver', 'basedpyright', ctx);
  let base: Pick<Launch, 'name' | 'version' | 'command' | 'args' | 'shell'> | null = null;
  if (pkg) {
    const bin = pkg.name === 'pyright' ? 'pyright-langserver' : 'basedpyright-langserver';
    base = { name: pkg.name, version: pkg.version, ...nodeBin(pkg, bin, ['--stdio'], ctx) };
  } else {
    // e.g. the PyPI `pyright` wrapper or a native install: no package.json to read.
    for (const name of ['pyright-langserver', 'basedpyright-langserver']) {
      const found = findOnPath(name, ctx);
      if (!found) continue;
      base = {
        name: name.replace('-langserver', ''),
        version: null,
        ...executable(found, ['--stdio'], ctx),
      };
      break;
    }
  }
  if (!base) return { launch: null, why: 'pyright not found' };

  const notes: string[] = [];
  const analysis: Record<string, unknown> = {};
  if (hasSrcLayout(ctx.root)) {
    analysis.extraPaths = ['src'];
    notes.push('extraPaths: src (src layout)');
  }
  const python: Record<string, unknown> = { analysis };
  const venv = findVenvPython(ctx.root, ctx.platform);
  if (venv && ctx.allowProjectCode) {
    // pyright runs this interpreter to find site-packages. It is inside the repository, so it
    // is project code: only with the opt-in.
    python.pythonPath = venv;
    notes.push(`interpreter: ${venv}`);
  } else if (venv) {
    notes.push('repository virtualenv not used (needs the project-code opt-in)');
  }
  if (['pyrightconfig.json', 'pyproject.toml'].some((f) => existsSync(join(ctx.root, f)))) {
    notes.push("the project's own pyright settings take precedence");
  }
  return {
    launch: {
      ...base,
      initializationOptions: {},
      settings: { python },
      configuration: notes.length ? notes.join('; ') : 'default settings',
    },
  };
}

function hasSrcLayout(root: string): boolean {
  const src = join(root, 'src');
  if (!isDirectory(src) || existsSync(join(src, '__init__.py'))) return false;
  return readdirSync(src).some((name) => existsSync(join(src, name, '__init__.py')));
}

function findVenvPython(root: string, platform: NodeJS.Platform): string | null {
  for (const dir of ['.venv', 'venv']) {
    const python =
      platform === 'win32'
        ? join(root, dir, 'Scripts', 'python.exe')
        : join(root, dir, 'bin', 'python');
    if (existsSync(python)) return python;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Project code. Without the opt-in (D11), nothing the reviewed change could have written is run:
// no package from a `node_modules` that Git tracks or that links into the repository, and no
// command found through a relative or in-repository `PATH` entry. When unsure, we refuse.

/**
 * Why the project's `node_modules` may hold project code, or null when it is the user's own
 * install. Tracked files are part of the change under review. So are workspace and `file:`
 * packages, which package managers link from `node_modules` into the repository; tsserver loads
 * `tsconfig.json` plugins from the `node_modules` its TypeScript sits in. Any failure counts as
 * untrusted.
 */
export function checkProjectPackages(root: string): string | null {
  const modules = join(root, 'node_modules');
  if (!existsSync(modules)) return null;
  // A checkout without `.git` (src/git/checkout.ts) only holds tracked files, and Git run there
  // would answer for whatever repository encloses the directory, if any.
  if (!existsSync(join(root, '.git'))) return 'node_modules was checked out from Git';
  const git = resolveExecutable('git');
  const tracked =
    git === null
      ? null
      : spawnSync(git, ['ls-files', '-z', '--', 'node_modules'], { cwd: root, encoding: 'utf8' });
  if (tracked === null || tracked.error || tracked.status !== 0) {
    return 'could not check with Git whether node_modules is tracked';
  }
  if (tracked.stdout) return 'node_modules is tracked by Git';
  try {
    const realRoot = realpathSync(root);
    const realModules = realpathSync(modules);
    if (isInside(realModules, realRoot) && realModules !== join(realRoot, 'node_modules')) {
      return `node_modules links to ${relative(realRoot, realModules)} in the repository`;
    }
    for (const name of packageEntries(modules)) {
      const entry = join(modules, name);
      if (!lstatSync(entry).isSymbolicLink() || !existsSync(entry)) continue;
      const target = realpathSync(entry);
      if (isInside(target, realRoot) && !isInside(target, realModules)) {
        return `node_modules/${name} links to ${relative(realRoot, target)} in the repository`;
      }
    }
  } catch {
    return 'could not inspect node_modules';
  }
  return null;
}

/** Top-level package names in a `node_modules` directory, including `@scope/name`. */
function packageEntries(modules: string): string[] {
  return readdirSync(modules).flatMap((name) =>
    name.startsWith('@') &&
    isDirectory(join(modules, name)) &&
    !lstatSync(join(modules, name)).isSymbolicLink()
      ? readdirSync(join(modules, name)).map((sub) => `${name}/${sub}`)
      : [name],
  );
}

/**
 * `path` without entries where project code could stand in for a server or the interpreter a
 * server runs: relative entries (resolved against whatever the working directory is) and entries
 * inside the repository, such as an activated in-repository virtualenv.
 */
export function safeSearchPath(path: string, root: string): string {
  const realRoot = realpathOr(root);
  return path
    .split(delimiter)
    .filter((dir) => dir && isAbsolute(dir) && !isInside(realpathOr(dir), realRoot))
    .join(delimiter);
}

function projectPackage(packageName: string, ctx: DiscoveryContext): NodePackage | null {
  if (ctx.untrustedPackages && !ctx.allowProjectCode) return null;
  return readPackage(join(ctx.root, 'node_modules', packageName), packageName);
}

/** Says why the project's own packages were passed over, if they were. */
function withPackagesNote(ctx: DiscoveryContext, found: Discovery): Discovery {
  if (!ctx.untrustedPackages || ctx.allowProjectCode) return found;
  if (!existsSync(join(ctx.root, 'node_modules'))) return found;
  const note = `project node_modules not used: ${ctx.untrustedPackages} (needs the project-code opt-in)`;
  return found.launch
    ? { launch: { ...found.launch, configuration: `${found.launch.configuration}; ${note}` } }
    : { launch: null, why: `${found.why}; ${note}` };
}

/** Whether `path` is `dir` or inside it, by name: `..x` is a name, `../x` is outside. */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// ---------------------------------------------------------------------------------------------
// Finding commands and Node packages.

interface NodePackage {
  name: string;
  version: string;
  dir: string;
  bin: Record<string, string>;
}

/**
 * A Node package providing `binName`: the project's `node_modules` first, then `PATH`. Node
 * servers are run as `node <script>`, which works the same on every OS (no `.cmd` shims).
 */
function findNodePackage(
  binName: string,
  packageName: string,
  ctx: DiscoveryContext,
): NodePackage | null {
  const local = projectPackage(packageName, ctx);
  if (local?.bin[binName]) return local;
  const onPath = findOnPath(binName, ctx);
  if (!onPath) return null;
  // npm global installs: a symlink to the script (Unix) or a shim next to node_modules (Windows).
  const candidates = [join(dirname(onPath), 'node_modules', packageName)];
  try {
    candidates.unshift(packageDirOf(realpathSync(onPath), packageName) ?? '');
  } catch {
    // Unreadable link: fall through to the Windows layout.
  }
  for (const dir of candidates) {
    const pkg = dir ? readPackage(dir, packageName) : null;
    if (pkg?.bin[binName]) return pkg;
  }
  return null;
}

function packageDirOf(file: string, packageName: string): string | null {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    if (readPackage(dir, packageName)) return dir;
  }
  return null;
}

function resolvePackageDir(packageName: string, fromDir: string): string {
  try {
    const require = createRequire(join(fromDir, 'package.json'));
    return dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    return '';
  }
}

function readPackage(dir: string, expectedName?: string): NodePackage | null {
  if (!dir) return null;
  try {
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
      bin?: string | Record<string, string>;
    };
    if (!json.name || !json.version) return null;
    if (expectedName && json.name !== expectedName) return null;
    const bin = typeof json.bin === 'string' ? { [json.name]: json.bin } : (json.bin ?? {});
    return { name: json.name, version: json.version, dir, bin };
  } catch {
    return null;
  }
}

function nodeBin(
  pkg: NodePackage,
  binName: string,
  args: string[],
  ctx: DiscoveryContext,
): Pick<Launch, 'command' | 'args' | 'shell'> {
  return executable(process.execPath, [join(pkg.dir, pkg.bin[binName]!), ...args], ctx);
}

function executable(
  command: string,
  args: string[],
  ctx: DiscoveryContext,
): Pick<Launch, 'command' | 'args' | 'shell'> {
  const shell = ctx.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
  // With a shell, Node joins command and arguments with spaces: quote what may contain them.
  if (shell) return { command: `"${command}"`, args: args.map((a) => `"${a}"`), shell };
  return { command, args, shell };
}

/** Absolute path of `name` on the search path (with `PATHEXT` on Windows), or null. */
export function findOnPath(name: string, ctx: DiscoveryContext): string | null {
  if (name.includes('/') || name.includes('\\')) return existsSync(name) ? name : null;
  const exts =
    ctx.platform === 'win32' && !extname(name)
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  for (const dir of ctx.searchPath.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, name + ext.toLowerCase());
      if (isFile(file)) return file;
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function major(version: string): number {
  return Number.parseInt(version, 10) || 0;
}

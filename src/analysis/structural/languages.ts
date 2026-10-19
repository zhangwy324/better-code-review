// Built-in languages (ADR 0001): language detection, grammar loading and declaration queries.
// The grammars are vendored `.wasm` files (grammars/README.md); the queries are our own (queries/).
import { readFileSync } from 'node:fs';
import { Language, Parser, Query } from 'web-tree-sitter';

/** A built-in grammar. TSX is its own grammar; JSX parses with the JavaScript grammar. */
export type GrammarName = 'typescript' | 'tsx' | 'javascript' | 'python' | 'java';

/** One entry of grammars/manifest.json, which scripts/grammars.ts generates from the pins. */
export interface GrammarPin {
  grammar: GrammarName;
  /** npm package the `.wasm` is taken from. */
  package: string;
  version: string;
  /** File name of the `.wasm`, both in the package and in grammars/. */
  file: string;
  /** Integrity of the package tarball, as the npm registry reports it. */
  integrity?: string;
  /** Source repository of the package. */
  repository?: string | undefined;
  /** SPDX licence of the package. */
  license?: string;
  /** The package's licence text, in grammars/. */
  licenseFile?: string;
  sha256?: string;
}

export interface GrammarManifest {
  $comment?: string;
  /** The web-tree-sitter version the grammars were vendored against. */
  engine?: string;
  grammars: GrammarPin[];
}

const EXTENSIONS: Record<string, GrammarName> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.java': 'java',
};

/**
 * Query files per grammar, concatenated in order. TypeScript adds its own declarations to the
 * JavaScript ones, as the upstream tags queries do.
 */
const QUERY_FILES: Record<GrammarName, string[]> = {
  typescript: ['javascript.scm', 'typescript.scm'],
  tsx: ['javascript.scm', 'typescript.scm'],
  javascript: ['javascript.scm'],
  python: ['python.scm'],
  java: ['java.scm'],
};

/**
 * The built-in grammar for a repository path, by extension (case-insensitive), or null when
 * there is none. Content is never inspected.
 */
export function detectLanguage(path: string): GrammarName | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXTENSIONS[name.slice(dot)] ?? null;
}

// Same relative location from src/ and dist/; the build copies grammars/ and queries/.
const GRAMMARS_DIR = new URL('./grammars/', import.meta.url);
const QUERIES_DIR = new URL('./queries/', import.meta.url);

export function readManifest(): GrammarManifest {
  return JSON.parse(
    readFileSync(new URL('manifest.json', GRAMMARS_DIR), 'utf8'),
  ) as GrammarManifest;
}

export function grammarFile(grammar: GrammarName): URL {
  const pin = readManifest().grammars.find((g) => g.grammar === grammar);
  if (!pin) throw new Error(`grammars/manifest.json has no entry for ${grammar}`);
  return new URL(pin.file, GRAMMARS_DIR);
}

export function querySource(grammar: GrammarName): string {
  return QUERY_FILES[grammar]
    .map((file) => readFileSync(new URL(file, QUERIES_DIR), 'utf8'))
    .join('\n');
}

/** A loaded grammar and its compiled declaration query. */
export interface LoadedLanguage {
  grammar: GrammarName;
  language: Language;
  declarations: Query;
}

let engine: Promise<void> | undefined;
const loading = new Map<GrammarName, Promise<LoadedLanguage>>();
const loaded = new Map<GrammarName, LoadedLanguage>();

/** Initialises the WASM engine once per process. */
export function initEngine(): Promise<void> {
  engine ??= Parser.init();
  return engine;
}

/**
 * Loads a built-in grammar and compiles its query, once per process. Failure means a broken
 * install or a bad query file, so it throws rather than reporting the file as unsupported.
 */
export function loadLanguage(grammar: GrammarName): Promise<LoadedLanguage> {
  let promise = loading.get(grammar);
  if (!promise) {
    promise = (async () => {
      await initEngine();
      const language = await Language.load(readFileSync(grammarFile(grammar)));
      const result = { grammar, language, declarations: new Query(language, querySource(grammar)) };
      loaded.set(grammar, result);
      return result;
    })();
    loading.set(grammar, promise);
  }
  return promise;
}

/** A grammar that `loadLanguage()` has already loaded, e.g. the one a parsed file used. */
export function loadedLanguage(grammar: GrammarName): LoadedLanguage {
  const result = loaded.get(grammar);
  if (!result) throw new Error(`grammar ${grammar} is not loaded`);
  return result;
}

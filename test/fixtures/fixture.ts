// The shape of a portfolio fixture (README.md): a base and a head snapshot, and the facts
// `generate --no-lsp` must report for the change between them.
import type { FileSpec } from './repo.ts';

export type Files = Record<string, FileSpec>;

/**
 * What the deterministic graph holds with no language server. Every list is exact (no more, no
 * fewer) and order does not matter. Full hunk coverage and "nothing verified" are checked for
 * every fixture, so they are not repeated here.
 */
export interface ExpectedFacts {
  /**
   * Every changed file: `path tier`, then `test` for a test file, and the reason its structure was
   * skipped or its content omitted, if any.
   */
  files: string[];
  /** Every node: `kind displayName`. */
  nodes: string[];
  /**
   * Every code edge: `from relation to (sides)`, by display name, or by path for a test file. All
   * are `possible` without a language server.
   */
  edges: string[];
  /** Capped fan-out: `name relation shown/total`. */
  caps?: string[];
}

export interface Fixture {
  /** Kebab-case; `npm run fixtures -- <name> <dir>`. */
  name: string;
  /** What the fixture exercises, in one sentence. */
  summary: string;
  base: Files;
  /** Changes on top of `base`; null deletes a file. */
  head: Files;
  expected: ExpectedFacts;
  /**
   * Facts that need more than `generate --no-lsp`: a language server, or a later milestone. Not
   * checked yet; #21 and #26 turn them into assertions.
   */
  later: string[];
}

/** Joins lines into a file with a trailing newline. */
export const lines = (...l: string[]) => `${l.join('\n')}\n`;

/** A strict tsconfig with `.ts` imports, so a language server can type-check the fixture. */
export const TSCONFIG =
  '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "nodenext", "allowImportingTsExtensions": true, "noEmit": true } }\n';

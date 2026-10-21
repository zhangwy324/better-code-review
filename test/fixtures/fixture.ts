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

/**
 * How the edges change with a language server for every parsed language: each edge in
 * `ExpectedFacts.edges` is verified, except those it rejects, which are gone, and those it
 * cannot settle, which stay possible. Files in those languages become `semantic`; nothing else
 * changes.
 */
export interface WithLsp {
  rejected?: string[];
  possible?: string[];
}

/**
 * What an agent's plan must do on the fixture (#26), checked by test/ai/score.ts on every live
 * eval run and recording. Nodes are named as in `ExpectedFacts.nodes`, without the kind.
 */
export interface PlanFacts {
  /**
   * Reading chains, each a list of steps: every node of a step is read before every node of the
   * next. A node is read where its home group is in the reading order (`groupOrder`, each group
   * followed by its children), and within one group in `nodeIds` order.
   */
  order?: string[][][];
  /** Node sets that each share one home group. */
  together?: string[][];
  /** Node sets that share no home group with each other. */
  apart?: string[][];
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
  /** With a language server; every edge is verified when omitted. */
  withLsp?: WithLsp;
  /** What an agent's plan must do; only checked on live and recorded runs. */
  plan?: PlanFacts;
  /** Facts for a later milestone or issue, not checked yet. */
  later: string[];
}

/** Joins lines into a file with a trailing newline. */
export const lines = (...l: string[]) => `${l.join('\n')}\n`;

/** A strict tsconfig with `.ts` imports, so a language server can type-check the fixture. */
export const TSCONFIG =
  '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "nodenext", "allowImportingTsExtensions": true, "noEmit": true } }\n';

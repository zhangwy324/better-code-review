// The #3/#4 signature-propagation fixture (MVP spec "Signature fixture", ADR 0001), as a real
// two-commit repository, and helpers to run the semantic analyzer on it. `formatPrice(amount)`
// gains `currency`; 3 of its 4 direct callers are updated and `emailSummary` is not. The
// collisions are changed too, so they are in scope under D12: `legacyLabel` calls a different
// `formatPrice` (src/legacy/price.ts), `viaMethod` calls `Fmt.formatPrice`, and `aliasCaller`
// reaches the changed `formatPrice` only through `export { formatPrice as fmt }` in an unchanged
// file. On the Python side `tax(amount)` gains `rate`, with a module-alias caller `t.tax(a)` and
// a colliding `Calc.tax`.
import { extractChangeSet } from '../../git/extract.ts';
import { TestRepo } from '../../git/test-repo.test-helper.ts';
import type { ChangeSet } from '../../schemas/changeset.ts';
import type { SemanticEvidence } from '../../schemas/semantic.ts';
import type { StructuralChangeSet } from '../../schemas/structural.ts';
import { analyzeStructure } from '../structural/analyze.ts';
import { analyzeSemantics, type SemanticOptions } from './analyze.ts';
import { gitSnapshotFiles } from './snapshot-files.ts';

export type Files = Record<string, string | null>;

const lines = (...l: string[]) => `${l.join('\n')}\n`;

export const SIGNATURE_BASE: Files = {
  'tsconfig.json':
    '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "nodenext", "allowImportingTsExtensions": true, "noEmit": true } }\n',
  'config.json': '{ "currency": "USD" }\n',
  'src/price.ts': lines(
    'export function formatPrice(amount: number): string {',
    '  return amount.toFixed(2);',
    '}',
  ),
  'src/checkout.ts': lines(
    "import { formatPrice } from './price.ts';",
    '',
    'export function checkoutSummary(total: number): string {',
    "  return 'Checkout: ' + formatPrice(total);",
    '}',
  ),
  'src/invoice.ts': lines(
    "import { formatPrice } from './price.ts';",
    '',
    'export function invoiceSummary(total: number): string {',
    "  return 'Invoice: ' + formatPrice(total);",
    '}',
  ),
  'src/receipt.ts': lines(
    "import { formatPrice } from './price.ts';",
    '',
    'export function receiptSummary(total: number): string {',
    "  return 'Receipt: ' + formatPrice(total);",
    '}',
  ),
  'src/email.ts': lines(
    "import { formatPrice } from './price.ts';",
    '',
    'export function emailSummary(total: number): string {',
    "  return 'Email: ' + formatPrice(total);",
    '}',
  ),
  'src/legacy/price.ts': lines(
    'export function formatPrice(n: number): string {',
    '  return String(n);',
    '}',
  ),
  'src/legacyLabel.ts': lines(
    "import { formatPrice } from './legacy/price.ts';",
    '',
    'export function legacyLabel(n: number): string {',
    "  return 'Legacy ' + formatPrice(n);",
    '}',
  ),
  'src/fmt.ts': lines(
    'export class Fmt {',
    '  formatPrice(n: number): string {',
    '    return String(n);',
    '  }',
    '}',
    '',
    'export function viaMethod(f: Fmt): string {',
    '  return f.formatPrice(1);',
    '}',
  ),
  'src/reexport.ts': "export { formatPrice as fmt } from './price.ts';\n",
  'src/viaAlias.ts': lines(
    "import { fmt } from './reexport.ts';",
    '',
    'export function aliasCaller(): string {',
    '  return fmt(1);',
    '}',
  ),
  'tax.py': lines('def tax(amount):', '    return amount * 0.1'),
  'orders.py': lines('from tax import tax', '', '', 'def order_total(a):', '    return a + tax(a)'),
  'refunds.py': lines('import tax as t', '', '', 'def refund(a):', '    return t.tax(a)'),
  'calc.py': lines(
    'class Calc:',
    '    def tax(self, a):',
    '        return a',
    '',
    '',
    'def use_calc():',
    '    return Calc().tax(1)',
  ),
};

export const SIGNATURE_HEAD: Files = {
  'config.json': '{ "currency": "EUR" }\n',
  'src/price.ts': lines(
    'export function formatPrice(amount: number, currency: string): string {',
    '  return `${currency} ${amount.toFixed(2)}`;',
    '}',
  ),
  'src/checkout.ts': lines(
    "import { formatPrice } from './price.ts';",
    '',
    'export function checkoutSummary(total: number): string {',
    "  return 'Checkout: ' + formatPrice(total, 'USD');",
    '}',
  ),
  'src/invoice.ts': lines(
    "import { formatPrice } from './price.ts';",
    '',
    'export function invoiceSummary(total: number): string {',
    "  return 'Invoice: ' + formatPrice(total, 'USD');",
    '}',
  ),
  'src/receipt.ts': lines(
    "import { formatPrice } from './price.ts';",
    '',
    'export function receiptSummary(total: number): string {',
    "  return 'Receipt: ' + formatPrice(total, 'USD');",
    '}',
  ),
  'src/legacyLabel.ts': lines(
    "import { formatPrice } from './legacy/price.ts';",
    '',
    'export function legacyLabel(n: number): string {',
    "  return 'Old ' + formatPrice(n);",
    '}',
  ),
  'src/fmt.ts': lines(
    'export class Fmt {',
    '  formatPrice(n: number): string {',
    '    return String(n);',
    '  }',
    '}',
    '',
    'export function viaMethod(f: Fmt): string {',
    '  return f.formatPrice(2);',
    '}',
  ),
  'src/viaAlias.ts': lines(
    "import { fmt } from './reexport.ts';",
    '',
    'export function aliasCaller(): string {',
    "  return fmt(1, 'USD');",
    '}',
  ),
  'tax.py': lines('def tax(amount, rate=0.1):', '    return amount * rate'),
  'orders.py': lines(
    'from tax import tax',
    '',
    '',
    'def order_total(a):',
    '    return a + tax(a, 0.2)',
  ),
  'refunds.py': lines('import tax as t', '', '', 'def refund(a):', '    return t.tax(a, 0.2)'),
  'calc.py': lines(
    'class Calc:',
    '    def tax(self, a):',
    '        return a',
    '',
    '',
    'def use_calc():',
    '    return Calc().tax(2)',
  ),
};

export interface Analysed {
  repo: TestRepo;
  changes: ChangeSet;
  structure: StructuralChangeSet;
  evidence: SemanticEvidence;
}

/**
 * Commits `base`, then `head` on top, and runs the extractor and both analyzers. `options` may
 * be a function of the repository, whose working tree then holds `head` (for a language server).
 */
export async function analyse(
  base: Files,
  head: Files,
  options:
    | Omit<SemanticOptions, 'files'>
    | ((repo: TestRepo) => Promise<Omit<SemanticOptions, 'files'>>) = {},
): Promise<Analysed> {
  const repo = new TestRepo();
  const commit = repo.commit([repo.commit([], base)], head);
  const changes = await extractChangeSet(repo.path, { kind: 'commit', commit });
  const structure = await analyzeStructure(changes);
  let semanticOptions: Omit<SemanticOptions, 'files'>;
  if (typeof options === 'function') {
    // `commit()` leaves `head` in the index; write it out as the working tree.
    repo.git('checkout-index', '--all', '--force');
    semanticOptions = await options(repo);
  } else {
    semanticOptions = options;
  }
  const evidence = await analyzeSemantics(changes, structure, {
    ...semanticOptions,
    files: gitSnapshotFiles(repo.path, changes),
  });
  return { repo, changes, structure, evidence };
}

/**
 * One line per hit: `side relation source -> target @path:line methods`, where methods lists
 * each record's method and outcome, e.g. `text-search:candidate import-resolution:confirmed`.
 */
export function summary({
  structure,
  evidence,
}: Pick<Analysed, 'structure' | 'evidence'>): string[] {
  const name = (id: string) => {
    const e = structure.entities.find((x) => x.id === id)!;
    return e.name === null
      ? `<module ${e.path}>`
      : e.container
        ? `${e.container}.${e.name}`
        : e.name;
  };
  const byHit = new Map<string, string[]>();
  for (const r of evidence.records) {
    const key = `${r.location.side} ${r.relation} ${name(r.sourceEntityId)} -> ${name(r.targetEntityId)} @${r.location.path}:${r.location.range.startLine}`;
    byHit.set(key, [...(byHit.get(key) ?? []), `${r.method}:${r.outcome}`]);
  }
  return [...byHit].map(([key, methods]) => `${key} ${methods.join(' ')}`);
}

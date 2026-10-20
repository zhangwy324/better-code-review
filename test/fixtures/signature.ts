// The #3/#4 signature-propagation fixture (MVP spec "Signature fixture", ADR 0001).
// `formatPrice(amount)` gains `currency`; 3 of its 4 direct callers are updated and
// `emailSummary` is not. The collisions are changed too, so they are in scope under D12:
// `legacyLabel` calls a different `formatPrice` (src/legacy/price.ts), `viaMethod` calls
// `Fmt.formatPrice`, and `aliasCaller` reaches the changed `formatPrice` only through
// `export { formatPrice as fmt }` in an unchanged file. On the Python side `tax(amount)` gains
// `rate`, with a module-alias caller `t.tax(a)` and a colliding `Calc.tax`. Python is the only
// non-TypeScript part of the portfolio so far (#77).
import { type Fixture, lines } from './fixture.ts';

/** Text only, so tests can edit it as strings. */
type TextFiles = Record<string, string | null>;

export const base: TextFiles = {
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

export const head: TextFiles = {
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

export const signature: Fixture = {
  name: 'signature',
  summary:
    'A changed signature with updated callers, a missed unchanged caller and same-name collisions.',
  base,
  head,
  expected: {
    files: [
      'config.json git-only',
      'src/price.ts structural',
      'src/checkout.ts structural',
      'src/invoice.ts structural',
      'src/receipt.ts structural',
      'src/legacyLabel.ts structural',
      'src/fmt.ts structural',
      'src/viaAlias.ts structural',
      'tax.py structural',
      'orders.py structural',
      'refunds.py structural',
      'calc.py structural',
    ],
    // emailSummary is unchanged, so it is not a node (D12).
    nodes: [
      'file config.json',
      'symbol formatPrice',
      'symbol checkoutSummary',
      'symbol invoiceSummary',
      'symbol receiptSummary',
      'symbol legacyLabel',
      'symbol viaMethod',
      'symbol aliasCaller',
      'symbol tax',
      'symbol order_total',
      'symbol refund',
      'symbol use_calc',
    ],
    // legacyLabel's call is rejected by import resolution. The receiver calls f.formatPrice and
    // Calc().tax only types settle, so they stay possible.
    edges: [
      'checkoutSummary calls formatPrice (both)',
      'invoiceSummary calls formatPrice (both)',
      'receiptSummary calls formatPrice (both)',
      'aliasCaller calls formatPrice (both)',
      'viaMethod calls formatPrice (both)',
      'order_total calls tax (both)',
      'refund calls tax (both)',
      'use_calc calls tax (both)',
    ],
  },
  // MVP spec M1, with typescript-language-server and pyright.
  withLsp: { rejected: ['viaMethod calls formatPrice (both)', 'use_calc calls tax (both)'] },
  later: ['M2: the plan puts the formatPrice contract group first, then its callers (#26).'],
};

// Static references versus same-name unrelated symbols. Two modules each change their own
// `validate`, and each caller imports its own; a method `Form.validate` changes too, and is
// called through a receiver.
import { type Files, type Fixture, lines, TSCONFIG } from './fixture.ts';

const base: Files = {
  'tsconfig.json': TSCONFIG,
  'src/users/validate.ts': lines(
    'export function validate(name: string): boolean {',
    '  return name.length > 0;',
    '}',
  ),
  'src/users/signup.ts': lines(
    "import { validate } from './validate.ts';",
    '',
    'export function signup(name: string): string {',
    "  return validate(name) ? 'ok' : 'invalid';",
    '}',
  ),
  'src/orders/validate.ts': lines(
    'export function validate(quantity: number): boolean {',
    '  return quantity > 0;',
    '}',
  ),
  'src/orders/submit.ts': lines(
    "import { validate } from './validate.ts';",
    '',
    'export function submit(quantity: number): string {',
    "  return validate(quantity) ? 'ok' : 'invalid';",
    '}',
  ),
  'src/forms/form.ts': lines(
    'export class Form {',
    '  constructor(readonly fields: Record<string, string>) {}',
    '',
    '  validate(): boolean {',
    "    return Object.values(this.fields).every((v) => v !== '');",
    '  }',
    '}',
    '',
    'export function submitForm(form: Form): string {',
    "  return form.validate() ? 'sent' : 'invalid';",
    '}',
  ),
};

const head: Files = {
  'src/users/validate.ts': lines(
    'export function validate(name: string): boolean {',
    '  return name.trim().length > 0;',
    '}',
  ),
  'src/users/signup.ts': lines(
    "import { validate } from './validate.ts';",
    '',
    'export function signup(name: string): string {',
    "  return validate(name) ? 'ok' : 'invalid name';",
    '}',
  ),
  'src/orders/validate.ts': lines(
    'export function validate(quantity: number): boolean {',
    '  return Number.isInteger(quantity) && quantity > 0;',
    '}',
  ),
  'src/orders/submit.ts': lines(
    "import { validate } from './validate.ts';",
    '',
    'export function submit(quantity: number): string {',
    "  return validate(quantity) ? 'ok' : 'invalid quantity';",
    '}',
  ),
  'src/forms/form.ts': lines(
    'export class Form {',
    '  constructor(readonly fields: Record<string, string>) {}',
    '',
    '  validate(): boolean {',
    "    return Object.values(this.fields).every((v) => v.trim() !== '');",
    '  }',
    '}',
    '',
    'export function submitForm(form: Form): string {',
    "  return form.validate() ? 'sent' : 'invalid form';",
    '}',
  ),
};

export const sameName: Fixture = {
  name: 'same-name',
  summary: 'Three changed symbols named validate, each called through its own import or receiver.',
  base,
  head,
  expected: {
    files: [
      'src/users/validate.ts structural',
      'src/users/signup.ts structural',
      'src/orders/validate.ts structural',
      'src/orders/submit.ts structural',
      'src/forms/form.ts structural',
    ],
    nodes: [
      'symbol validate [src/users/validate.ts]',
      'symbol signup',
      'symbol validate [src/orders/validate.ts]',
      'symbol submit',
      'symbol Form.validate',
      'symbol submitForm',
    ],
    // Import resolution rejects each plain call's link to the other module's validate. The
    // receiver call form.validate() stays possible to all three.
    edges: [
      'signup calls validate [src/users/validate.ts] (both)',
      'submit calls validate [src/orders/validate.ts] (both)',
      'submitForm calls Form.validate (both)',
      'submitForm calls validate [src/users/validate.ts] (both)',
      'submitForm calls validate [src/orders/validate.ts] (both)',
    ],
  },
  withLsp: {
    rejected: [
      'submitForm calls validate [src/users/validate.ts] (both)',
      'submitForm calls validate [src/orders/validate.ts] (both)',
    ],
  },
  // The three validates are unrelated symbols that share a name. Their callers are left out: a
  // plan may group the three message changes by purpose.
  plan: {
    apart: [
      ['validate [src/users/validate.ts]'],
      ['validate [src/orders/validate.ts]'],
      ['Form.validate'],
    ],
  },
  later: [],
};

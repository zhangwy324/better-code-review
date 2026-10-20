// Removed and replaced calls, which only the base snapshot shows (#66). src/notify.ts and its
// `notifyByEmail` are deleted and `placeOrder` calls the new `enqueueNotification` in
// src/queue.ts instead; `refundOrder` stops calling `audit`, whose message changes. (Had the new
// function replaced the old one in the same file, with the same parameters, the structural
// matcher would pair them as a rename.)
import { type Files, type Fixture, lines, TSCONFIG } from './fixture.ts';

const base: Files = {
  'tsconfig.json': TSCONFIG,
  'src/notify.ts': lines(
    'export function notifyByEmail(orderId: string): void {',
    '  console.log(`email for ${orderId}`);',
    '}',
  ),
  'src/audit.ts': lines(
    'export function audit(event: string): void {',
    '  console.log(`audit: ${event}`);',
    '}',
  ),
  'src/orders.ts': lines(
    "import { audit } from './audit.ts';",
    "import { notifyByEmail } from './notify.ts';",
    '',
    'export function placeOrder(orderId: string): void {',
    '  notifyByEmail(orderId);',
    '}',
    '',
    'export function refundOrder(orderId: string): void {',
    '  audit(`refund ${orderId}`);',
    '}',
  ),
};

const head: Files = {
  'src/notify.ts': null,
  'src/queue.ts': lines(
    'const queue: string[] = [];',
    '',
    'export function enqueueNotification(orderId: string): void {',
    '  queue.push(orderId);',
    '}',
  ),
  'src/audit.ts': lines(
    'export function audit(event: string): void {',
    '  console.log(`audit event: ${event}`);',
    '}',
  ),
  'src/orders.ts': lines(
    "import { enqueueNotification } from './queue.ts';",
    '',
    'export function placeOrder(orderId: string): void {',
    '  enqueueNotification(orderId);',
    '}',
    '',
    'export function refundOrder(orderId: string): void {',
    '  console.log(`refund ${orderId}`);',
    '}',
  ),
};

export const removedCalls: Fixture = {
  name: 'removed-calls',
  summary: 'A deleted function, a replaced call and a removed call, found on the old side.',
  base,
  head,
  expected: {
    files: [
      'src/notify.ts structural',
      'src/queue.ts structural',
      'src/audit.ts structural',
      'src/orders.ts structural',
    ],
    nodes: [
      'symbol notifyByEmail',
      'module src/queue.ts',
      'symbol enqueueNotification',
      'symbol audit',
      'module src/orders.ts',
      'symbol placeOrder',
      'symbol refundOrder',
    ],
    edges: [
      'placeOrder calls notifyByEmail (old)',
      'placeOrder calls enqueueNotification (new)',
      'refundOrder calls audit (old)',
    ],
  },
  // With a language server every edge is verified, the old-side ones by a base-side server (#66).
  later: [],
};

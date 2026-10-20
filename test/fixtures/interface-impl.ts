// An interface gains a method: one implementation adds it, a new implementation is added, and
// callers use it through the interface type and through each implementation's own type.
import { type Files, type Fixture, lines, TSCONFIG } from './fixture.ts';

const base: Files = {
  'tsconfig.json': TSCONFIG,
  'src/payments/gateway.ts': lines(
    'export interface PaymentGateway {',
    '  charge(cents: number): Promise<string>;',
    '}',
  ),
  'src/payments/stripe.ts': lines(
    "import type { PaymentGateway } from './gateway.ts';",
    '',
    'export class StripeGateway implements PaymentGateway {',
    '  async charge(cents: number): Promise<string> {',
    '    return `stripe:${cents}`;',
    '  }',
    '}',
  ),
  'src/checkout.ts': lines(
    "import type { PaymentGateway } from './payments/gateway.ts';",
    '',
    'export async function pay(gateway: PaymentGateway, cents: number): Promise<string> {',
    '  return gateway.charge(cents);',
    '}',
  ),
};

const head: Files = {
  'src/payments/gateway.ts': lines(
    'export interface PaymentGateway {',
    '  charge(cents: number): Promise<string>;',
    '  refund(chargeId: string): Promise<void>;',
    '}',
  ),
  'src/payments/stripe.ts': lines(
    "import type { PaymentGateway } from './gateway.ts';",
    '',
    'export class StripeGateway implements PaymentGateway {',
    '  async charge(cents: number): Promise<string> {',
    '    return `stripe:${cents}`;',
    '  }',
    '',
    '  async refund(chargeId: string): Promise<void> {',
    '    console.log(`stripe refund ${chargeId}`);',
    '  }',
    '}',
  ),
  'src/payments/paypal.ts': lines(
    "import type { PaymentGateway } from './gateway.ts';",
    '',
    'export class PaypalGateway implements PaymentGateway {',
    '  async charge(cents: number): Promise<string> {',
    '    return `paypal:${cents}`;',
    '  }',
    '',
    '  async refund(chargeId: string): Promise<void> {',
    '    console.log(`paypal refund ${chargeId}`);',
    '  }',
    '}',
  ),
  'src/checkout.ts': lines(
    "import type { PaymentGateway } from './payments/gateway.ts';",
    "import type { PaypalGateway } from './payments/paypal.ts';",
    "import type { StripeGateway } from './payments/stripe.ts';",
    '',
    'export async function pay(gateway: PaymentGateway, cents: number): Promise<string> {',
    '  return gateway.charge(cents);',
    '}',
    '',
    'export async function cancel(gateway: PaymentGateway, chargeId: string): Promise<void> {',
    '  await gateway.refund(chargeId);',
    '}',
    '',
    'export async function refundStripe(stripe: StripeGateway, chargeId: string): Promise<void> {',
    '  await stripe.refund(chargeId);',
    '}',
    '',
    'export async function refundPaypal(paypal: PaypalGateway, chargeId: string): Promise<void> {',
    '  await paypal.refund(chargeId);',
    '}',
  ),
};

export const interfaceImpl: Fixture = {
  name: 'interface-impl',
  summary: 'An interface gains a method, implemented by a changed and a new class.',
  base,
  head,
  expected: {
    files: [
      'src/payments/gateway.ts structural',
      'src/payments/stripe.ts structural',
      'src/payments/paypal.ts structural',
      'src/checkout.ts structural',
    ],
    // Interface members are not entities, so the interface itself changes. The blank line added
    // inside StripeGateway, outside its methods, changes the class too.
    nodes: [
      'symbol PaymentGateway',
      'symbol StripeGateway',
      'symbol StripeGateway.refund',
      'module src/payments/paypal.ts',
      'symbol PaypalGateway',
      'symbol PaypalGateway.charge',
      'symbol PaypalGateway.refund',
      'module src/checkout.ts',
      'symbol cancel',
      'symbol refundStripe',
      'symbol refundPaypal',
    ],
    // Every refund(…) is a receiver call that only types settle, so each is possible to both
    // implementations.
    edges: [
      'StripeGateway implements PaymentGateway (both)',
      'PaypalGateway implements PaymentGateway (new)',
      'cancel references PaymentGateway (new)',
      'cancel calls StripeGateway.refund (new)',
      'cancel calls PaypalGateway.refund (new)',
      'refundStripe references StripeGateway (new)',
      'refundStripe calls StripeGateway.refund (new)',
      'refundStripe calls PaypalGateway.refund (new)',
      'refundPaypal references PaypalGateway (new)',
      'refundPaypal calls StripeGateway.refund (new)',
      'refundPaypal calls PaypalGateway.refund (new)',
    ],
  },
  later: [
    "With a TypeScript server: the implements edges and type references are verified, and so are cancel's calls, since a call through the interface can reach either implementation. Each implementation-typed call is verified to its own class only; the other stays possible (#21).",
    'M2: the plan groups the interface with its implementations, and an agent judges the two refund candidates (#43).',
  ],
};

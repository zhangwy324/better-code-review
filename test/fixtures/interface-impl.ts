// An interface gains a method: one implementation adds it, a new implementation is added, and
// callers use it through the interface type, through each implementation's own type, and
// through a new subclass of one implementation.
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
  'src/payments/stripe-connect.ts': lines(
    "import { StripeGateway } from './stripe.ts';",
    '',
    'export class StripeConnectGateway extends StripeGateway {',
    "  readonly account = 'acct_1';",
    '}',
  ),
  'src/checkout.ts': lines(
    "import type { PaymentGateway } from './payments/gateway.ts';",
    "import type { PaypalGateway } from './payments/paypal.ts';",
    "import type { StripeGateway } from './payments/stripe.ts';",
    "import type { StripeConnectGateway } from './payments/stripe-connect.ts';",
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
    '',
    'export async function refundConnect(',
    '  connect: StripeConnectGateway,',
    '  chargeId: string,',
    '): Promise<void> {',
    '  await connect.refund(chargeId);',
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
      'src/payments/stripe-connect.ts structural',
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
      'module src/payments/stripe-connect.ts',
      'symbol StripeConnectGateway',
      'module src/checkout.ts',
      'symbol cancel',
      'symbol refundStripe',
      'symbol refundPaypal',
      'symbol refundConnect',
    ],
    // Every refund(…) is a receiver call that only types settle, so each is possible to both
    // implementations.
    edges: [
      'StripeGateway implements PaymentGateway (both)',
      'PaypalGateway implements PaymentGateway (new)',
      'StripeConnectGateway implements StripeGateway (new)',
      'cancel references PaymentGateway (new)',
      'cancel calls StripeGateway.refund (new)',
      'cancel calls PaypalGateway.refund (new)',
      'refundStripe references StripeGateway (new)',
      'refundStripe calls StripeGateway.refund (new)',
      'refundStripe calls PaypalGateway.refund (new)',
      'refundPaypal references PaypalGateway (new)',
      'refundPaypal calls StripeGateway.refund (new)',
      'refundPaypal calls PaypalGateway.refund (new)',
      'refundConnect references StripeConnectGateway (new)',
      'refundConnect calls StripeGateway.refund (new)',
      'refundConnect calls PaypalGateway.refund (new)',
    ],
  },
  // cancel's call through the interface can reach either implementation, so both are verified.
  // An implementation-typed call is verified to its own class only. The other implementation is
  // a sibling (it implements the same interface), so the receiver's type rejects that call (#80).
  // connect.refund() reaches StripeGateway.refund through a subclass that does not override it,
  // so `definition` at the call lands on that method and it is verified. To PaypalGateway,
  // StripeConnectGateway is a sibling through StripeGateway, so that is rejected.
  withLsp: {
    rejected: [
      'refundStripe calls PaypalGateway.refund (new)',
      'refundPaypal calls StripeGateway.refund (new)',
      'refundConnect calls PaypalGateway.refund (new)',
    ],
  },
  later: [
    'M2: the plan groups the interface with its implementations, and an agent judges the two refund candidates (#43).',
  ],
};

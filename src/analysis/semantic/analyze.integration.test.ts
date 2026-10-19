// The semantic analyzer with real language servers on the signature fixture (#17 acceptance:
// "With LSP"). Each suite runs only when its server is installed, so CI without servers skips
// them. Servers are found by lsp-servers.test-helper.ts: on PATH, or in the directories
// listed in BCR_LSP_TEST_PATH (the first one with a server is used), e.g.
//   BCR_LSP_TEST_PATH=/a/node_modules/.bin npx vitest run analyze.integration
import { describe, expect, it } from 'vitest';
import { analyse, SIGNATURE_BASE, SIGNATURE_HEAD, summary } from './fixture.test-helper.ts';
import { installedServers } from './lsp-servers.test-helper.ts';
import { LspSession } from './session.ts';

const TIMEOUT = 180_000;
const timeouts = { emptyGraceMs: 3000, retryDelayMs: 500 };

for (const [language, label] of [
  ['typescript', 'TypeScript'],
  ['python', 'Python'],
] as const) {
  const searchPath = installedServers(language)[0]?.searchPath ?? null;
  describe.skipIf(searchPath === null)(`${label} server on the signature fixture`, () => {
    it(
      'verifies the real callers and rejects the same-name collisions',
      async () => {
        let session: LspSession | undefined;
        try {
          const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD, async (repo) => {
            session = await LspSession.start(repo.path, [language], {
              searchPath: searchPath!,
              timeouts,
            });
            return { lsp: session };
          });
          const lines = summary(result).filter((l) => l.startsWith('new '));
          expect(result.evidence.languages).toMatchObject([{ language, status: 'ok' }]);
          if (language === 'typescript') {
            expect(lines.filter((l) => /->/.test(l) && /\.ts:/.test(l))).toEqual([
              'new calls checkoutSummary -> formatPrice @src/checkout.ts:4 text-search:candidate import-resolution:confirmed lsp:confirmed',
              'new calls viaMethod -> formatPrice @src/fmt.ts:8 text-search:candidate lsp:rejected',
              'new calls invoiceSummary -> formatPrice @src/invoice.ts:4 text-search:candidate import-resolution:confirmed lsp:confirmed',
              // Settled by import resolution; not asked again.
              'new calls legacyLabel -> formatPrice @src/legacyLabel.ts:4 text-search:candidate import-resolution:rejected',
              'new calls receiptSummary -> formatPrice @src/receipt.ts:4 text-search:candidate import-resolution:confirmed lsp:confirmed',
              'new calls aliasCaller -> formatPrice @src/viaAlias.ts:4 text-search:candidate import-resolution:confirmed lsp:confirmed',
            ]);
          } else {
            expect(lines.filter((l) => /\.py:/.test(l))).toEqual([
              'new calls use_calc -> tax @calc.py:7 text-search:candidate lsp:rejected',
              'new calls order_total -> tax @orders.py:5 text-search:candidate import-resolution:confirmed lsp:confirmed',
              'new calls refund -> tax @refunds.py:5 text-search:candidate import-resolution:confirmed lsp:confirmed',
            ]);
          }
          // Old-side candidates are never sent to the server, which only sees the new side.
          expect(
            result.evidence.records.filter((r) => r.method === 'lsp' && r.location.side === 'old'),
          ).toEqual([]);
        } finally {
          await session?.close();
        }
      },
      TIMEOUT,
    );
  });
}

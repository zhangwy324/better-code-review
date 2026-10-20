// The semantic analyzer with real language servers on the signature fixture (#17 acceptance:
// "With LSP"). Each suite runs only when its server is installed, so CI without servers skips
// them. Servers are found by lsp-servers.test-helper.ts: on PATH, or in the directories
// listed in BCR_LSP_TEST_PATH (the first one with a server is used), e.g.
//   BCR_LSP_TEST_PATH=/a/node_modules/.bin npx vitest run analyze.integration
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutRevision } from '../../git/checkout.ts';
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
        const sessions: LspSession[] = [];
        const baseDir = mkdtempSync(join(tmpdir(), 'bcr-base-'));
        try {
          const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD, async (repo, changes) => {
            const start = async (root: string, languages: string[]) => {
              const session = await LspSession.start(root, languages, {
                searchPath: searchPath!,
                timeouts,
              });
              sessions.push(session);
              return session;
            };
            return {
              lsp: await start(repo.path, [language]),
              oldLsp: async (languages) => {
                await checkoutRevision(repo.path, changes.baseRevision!, baseDir);
                return start(baseDir, languages);
              },
            };
          });
          const lines = summary(result).filter((l) => l.startsWith('new '));
          // The new side rejects the collision, so its old-side twin goes to a base-side server.
          expect(result.evidence.languages).toMatchObject([
            { language, side: 'new', status: 'ok' },
            { language, side: 'old', status: 'ok' },
          ]);
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
          // Only the old-side twin of the rejected collision is asked about, and rejected too.
          const old = summary(result).filter((l) => l.startsWith('old ') && l.includes('lsp:'));
          expect(old).toEqual(
            language === 'typescript'
              ? [
                  'old calls viaMethod -> formatPrice @src/fmt.ts:8 text-search:candidate lsp:rejected',
                ]
              : ['old calls use_calc -> tax @calc.py:7 text-search:candidate lsp:rejected'],
          );
          const detail = result.evidence.records.find(
            (r) => r.method === 'lsp' && r.location.side === 'old',
          )?.detail;
          expect(detail).toBe('not among textDocument/references, and both files resolve');
        } finally {
          for (const session of sessions) await session.close();
          rmSync(baseDir, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  });
}

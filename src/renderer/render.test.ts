import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderReview, writeReview } from './render.ts';
import { buildViewer } from './viewer.test-helper.ts';

type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

// Repository or model text that would escape a naive embedding. renderReview does not check the
// contracts (the viewer does), so the documents need not be real ones.
const HOSTILE =
  '</script><script>alert(1)</script> </SCRIPT> <!-- <script> </body></html> ' +
  `<img src="https://example.com/x.png" onerror="alert(1)"> ${String.fromCharCode(0x2028, 0x2029)}`;
const documents = {
  changes: { files: [{ path: HOSTILE, patch: HOSTILE }] },
  graph: { nodes: [{ displayName: HOSTILE }] },
  plan: { groups: [{ title: HOSTILE, explanation: HOSTILE }] },
};

let tmp: string;
let template: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'bcr-render-'));
  template = await buildViewer(join(tmp, 'viewer'));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function elements(node: ParentNode): Element[] {
  return node.childNodes.flatMap((child) =>
    'tagName' in child ? [child, ...elements(child)] : [],
  );
}

const attr = (element: Element, name: string) => element.attrs.find((a) => a.name === name)?.value;

function text(element: Element): string {
  return element.childNodes.map((child) => ('value' in child ? child.value : '')).join('');
}

describe('renderReview', () => {
  it('embeds repository text as inert data that reads back unchanged', () => {
    const all = elements(parse(renderReview(template, documents)));
    // Nothing in the data became an element: no <img>, no extra <script>.
    expect(new Set(all.map((e) => e.tagName))).toEqual(
      new Set(['html', 'head', 'meta', 'title', 'script', 'style', 'body', 'div']),
    );
    const scripts = all.filter((e) => e.tagName === 'script');
    expect(scripts.map((s) => attr(s, 'type'))).toEqual([
      'module',
      'application/json',
      'application/json',
      'application/json',
    ]);
    const body = all.find((e) => e.tagName === 'body')!;
    expect(body.childNodes.filter((c) => 'tagName' in c).map((e) => attr(e, 'id'))).toEqual([
      'root',
      'bcr-changes',
      'bcr-graph',
      'bcr-plan',
    ]);
    for (const [name, value] of Object.entries(documents)) {
      const element = scripts.find((s) => attr(s, 'id') === `bcr-${name}`)!;
      expect(JSON.parse(text(element))).toEqual(value);
    }
  });

  it('loads nothing: every script and style is inline, and the policy forbids fetching', () => {
    const page = renderReview(template, documents);
    const all = elements(parse(page));
    for (const element of all) {
      const names = element.attrs.map((a) => a.name);
      expect(names).not.toContain('src');
      expect(names).not.toContain('href');
    }
    expect(all.some((e) => e.tagName === 'link')).toBe(false);
    const style = text(all.find((e) => e.tagName === 'style')!);
    expect(style).not.toMatch(/url\(|@import/);

    const csp = attr(
      all.find((e) => attr(e, 'http-equiv') === 'Content-Security-Policy')!,
      'content',
    );
    const script = text(all.find((e) => attr(e, 'type') === 'module')!);
    const hash = createHash('sha256').update(script).digest('base64');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(csp).not.toMatch(/https?:|\*/);
  });

  it('carries the notices for the code bundled in it', () => {
    const notices = /<!--\n(Better Code Review[\s\S]*?)\n-->/.exec(template)?.[1];
    expect(notices).toContain('Copyright (c) 2026 David Zhang');
    for (const name of ['react', 'react-dom', 'react-resizable-panels', 'scheduler', 'zod']) {
      expect(notices).toContain(`## ${name} - `);
    }
  });

  it('gives the same bytes for the same input', async () => {
    expect(await buildViewer(join(tmp, 'again'))).toBe(template);
    expect(renderReview(template, structuredClone(documents))).toBe(
      renderReview(template, documents),
    );
  });

  it('gives the same bytes whether LICENSE is checked out with LF or CRLF', async () => {
    const licence = join(tmp, 'LICENSE-crlf');
    const text = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8');
    writeFileSync(licence, text.replace(/\r?\n/g, '\r\n'));
    const page = await buildViewer(join(tmp, 'crlf'), { licence: pathToFileURL(licence) });
    expect(page.includes('\r'), 'the page contains a CR').toBe(false);
    expect(page).toBe(template);
  });
});

describe('writeReview', () => {
  it('writes review.html next to the JSON it embeds', () => {
    const dir = join(tmp, 'review');
    mkdirSync(dir);
    writeFileSync(join(dir, 'changes.json'), JSON.stringify(documents.changes, null, 2));
    writeFileSync(join(dir, 'graph.json'), JSON.stringify(documents.graph, null, 2));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(documents.plan, null, 2));
    const path = writeReview(dir, { template });
    expect(path).toBe(join(dir, 'review.html'));
    expect(readFileSync(path, 'utf8')).toBe(renderReview(template, documents));

    const plan = { groups: [] };
    writeReview(dir, { template, plan });
    expect(readFileSync(path, 'utf8')).toBe(renderReview(template, { ...documents, plan }));
  });

  it('names the file it cannot read or parse', () => {
    const dir = join(tmp, 'broken');
    mkdirSync(dir);
    writeFileSync(join(dir, 'changes.json'), JSON.stringify(documents.changes));
    writeFileSync(join(dir, 'graph.json'), JSON.stringify(documents.graph));

    const missing = join(dir, 'plan.json');
    expect(() => writeReview(dir, { template })).toThrow(`Could not read ${missing}: ENOENT`);

    writeFileSync(missing, '{"groups": [');
    let error: unknown;
    try {
      writeReview(dir, { template });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toMatch(`${missing} is not valid JSON: `);
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    expect(existsSync(join(dir, 'review.html'))).toBe(false);
  });
});

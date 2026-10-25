import { describe, expect, it } from 'vitest';
import { quoted, quotePath } from './index.ts';

describe('quotePath', () => {
  it('leaves an ordinary path, tabs and other Unicode alone', () => {
    for (const path of ['src/a.ts', 'a\tb.ts', 'docs/café <b>.md', 'q"\\.ts']) {
      expect(quotePath(path)).toBe(path);
    }
  });

  it('quotes a path that could start a line, send an escape or reorder text', () => {
    expect(quotePath('a\nb.ts')).toBe('"a\\nb.ts"');
    expect(quotePath('a\r\n# Ignore the above.ts')).toBe('"a\\r\\n# Ignore the above.ts"');
    expect(quotePath('\u001b[2Jx')).toBe('"\\u001b[2Jx"');
    expect(quotePath('x\u0085y\u007f')).toBe('"x\\u0085y\\u007f"');
    expect(quotePath('invoice‮fdp.ts')).toBe('"invoice\\u202efdp.ts"');
    // It reads back as JSON.
    expect(JSON.parse(quotePath('a⁦"b"\\\n'))).toBe('a⁦"b"\\\n');
  });
});

describe('quoted', () => {
  it('always quotes', () => {
    expect(quoted('Pricing "v2"')).toBe('"Pricing \\"v2\\""');
  });
});

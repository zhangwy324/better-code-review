import { describe, expect, it } from 'vitest';
import { scriptJson } from './embed.ts';

describe('scriptJson', () => {
  it('cannot close its script element or open a comment, and reads back unchanged', () => {
    const value = { patch: '+ "</script><script>alert(1)</script>" <!-- <\\/script>' };
    const json = scriptJson(value);
    expect(json).not.toContain('<');
    expect(JSON.parse(json)).toEqual(value);
  });
});

import { describe, expect, it } from 'vitest';
import { scriptJson } from './embed.ts';

describe('scriptJson', () => {
  it('cannot close its script element or open a comment, and reads back unchanged', () => {
    const value = {
      patch: '+ "</script><script>alert(1)</script>" <!-- <\\/script> </SCRIPT >',
      separators: 'a\u2028b\u2029c',
    };
    const json = scriptJson(value);
    expect(json).not.toContain('<');
    expect(json).not.toMatch(/[\u2028\u2029]/);
    expect(JSON.parse(json)).toEqual(value);
  });
});

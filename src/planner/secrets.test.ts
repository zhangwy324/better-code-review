import { describe, expect, it } from 'vitest';
import { redactSecrets, sensitiveFile } from './secrets.ts';

describe('sensitiveFile', () => {
  it.each([
    ['.env', 'environment file'],
    ['config/.env.production', 'environment file'],
    ['certs/server.pem', 'key or keystore file'],
    ['deploy/id_ed25519', 'SSH private key'],
    ['home/.netrc', 'credentials file'],
  ])('withholds %s', (path, reason) => {
    expect(sensitiveFile(path)).toBe(reason);
  });

  it.each(['.env.example', 'src/env.ts', 'keys.ts', 'docs/id_rsa.md'])('shows %s', (path) => {
    expect(sensitiveFile(path)).toBeNull();
  });
});

describe('redactSecrets', () => {
  // Assembled so this file holds no literal that a secret scanner would flag.
  const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const github = 'ghp_' + 'a'.repeat(36);
  const jwt = 'eyJhbGciOiJI' + '.eyJzdWIiOiIx' + '.SflKxwRJSMeKKF2QT4';

  it('replaces token values and reports their kinds', () => {
    const text = `+const key = "${aws}";\n const t = '${github}'; // ${jwt}`;
    expect(redactSecrets(text, 1)).toEqual({
      text:
        '+const key = "[REDACTED:aws-access-key]";\n' +
        " const t = '[REDACTED:github-token]'; // [REDACTED:jwt]",
      kinds: ['aws-access-key', 'github-token', 'jwt'],
    });
  });

  it('redacts the password of a URL with credentials', () => {
    expect(redactSecrets('db: postgres://app:hunter2@db.local/app').text).toBe(
      'db: postgres://app:[REDACTED:url-password]@db.local/app',
    );
  });

  it('redacts a private key block line by line, keeping its markers and line count', () => {
    const block = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA',
      'abc==',
      '-----END RSA PRIVATE KEY-----',
    ];
    const text = ['+x', ...block.map((l) => `+${l}`), '+y'].join('\n');
    expect(redactSecrets(text, 1)).toEqual({
      text: [
        '+x',
        '+-----BEGIN RSA PRIVATE KEY-----',
        '+[REDACTED:private-key]',
        '+[REDACTED:private-key]',
        '+-----END RSA PRIVATE KEY-----',
        '+y',
      ].join('\n'),
      kinds: ['private-key'],
    });
  });

  it('redacts a private key held on one line', () => {
    const line = `"key": "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n"`;
    expect(redactSecrets(line).text).toBe(
      `"key": "-----BEGIN PRIVATE KEY-----[REDACTED:private-key]-----END PRIVATE KEY-----\\n"`,
    );
  });

  it('leaves ordinary code alone', () => {
    const text = 'const token = getToken();\nconst url = "https://example.com/a:b@c";';
    expect(redactSecrets(text)).toEqual({ text, kinds: [] });
  });
});

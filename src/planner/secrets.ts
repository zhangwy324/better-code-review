// Secret avoidance before code reaches a model (#22, design reference §14.2). Best effort: it
// catches high-confidence secrets only, and the agent can still read files on disk itself, which
// SKILL.md (#25) must say.
//
// - Files whose names usually hold secrets (`.env`, private keys, keystores) are withheld whole.
// - In other text, values matching high-confidence token patterns are replaced by
//   `[REDACTED:<kind>]`, and private key blocks line by line. Line count and line numbers never
//   change, so lines cited from redacted text still point at the snapshot.
import { posix } from 'node:path';

/** Why a file is withheld from the model, or null when its text may be shown (redacted). */
export function sensitiveFile(path: string): string | null {
  const name = posix.basename(path).toLowerCase();
  if (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist)$/.test(name)) {
    return 'environment file';
  }
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk)$/.test(name)) return 'key or keystore file';
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)) return 'SSH private key';
  if (['.netrc', '.pgpass', '.htpasswd'].includes(name)) return 'credentials file';
  return null;
}

/** High-confidence token patterns. Each must be anchored on a fixed, distinctive prefix. */
const TOKENS: readonly (readonly [kind: string, pattern: RegExp])[] = [
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['stripe-key', /\b[rs]k_live_[A-Za-z0-9]{16,}/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];

/** The password in `scheme://user:password@host`. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi;

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;

export interface Redacted {
  text: string;
  /** What was redacted, one entry per value, in text order. */
  kinds: string[];
}

/**
 * `text` with high-confidence secrets replaced. `prefix` is the number of leading characters per
 * line to keep as they are, e.g. 1 for the `+`/`-`/` ` marker of a diff line.
 */
export function redactSecrets(text: string, prefix = 0): Redacted {
  const kinds: string[] = [];
  let inKey = false;
  const lines = text.split('\n').map((line) => {
    const head = line.slice(0, prefix);
    let body = line.slice(prefix);
    // A private key block: keep the BEGIN and END markers so the reader sees what was there.
    const end = KEY_END.exec(body);
    if (inKey) {
      if (end === null) return `${head}[REDACTED:private-key]`;
      inKey = false;
      const before = body.slice(0, end.index);
      return (
        head + (before.trim() === '' ? body : `[REDACTED:private-key]${body.slice(end.index)}`)
      );
    }
    const begin = KEY_BEGIN.exec(body);
    if (begin !== null) {
      kinds.push('private-key');
      const afterBegin = begin.index + begin[0].length;
      // A whole key on one line, e.g. a string with `\n` escapes.
      if (end !== null && end.index >= afterBegin) {
        return `${head}${body.slice(0, afterBegin)}[REDACTED:private-key]${body.slice(end.index)}`;
      }
      inKey = true;
      return head + body.slice(0, afterBegin);
    }
    for (const [kind, pattern] of TOKENS) {
      body = body.replace(pattern, () => (kinds.push(kind), `[REDACTED:${kind}]`));
    }
    body = body.replace(URL_PASSWORD, (_, before: string, _password, at: string) => {
      kinds.push('url-password');
      return `${before}[REDACTED:url-password]${at}`;
    });
    return head + body;
  });
  return { text: lines.join('\n'), kinds };
}

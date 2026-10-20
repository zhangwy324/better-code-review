// Parses the text of `git diff` (two trees, rename and copy detection, default `a/` and `b/`
// prefixes) into per-file sections and hunks. Hunk text is sliced from Git's output unchanged, so
// joining a section's hunks reproduces everything Git printed from its first `@@` line onward.

export interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** From the `@@` line through the hunk's last line, newlines included. */
  patch: string;
}

/** One `diff --git` block. A type change (e.g. file to symlink) is printed as two blocks. */
export interface PatchSection {
  /** Equal to `newPath` unless the file was renamed or copied; added and deleted files have both. */
  oldPath: string;
  newPath: string;
  /** Git printed "Binary files … differ" instead of hunks. */
  binary: boolean;
  hunks: ParsedHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(text: string): PatchSection[] {
  // A section's paths are known only after its extended headers: a rename or copy names them
  // there (`rename from`/`copy from`, `rename to`/`copy to`).
  type OpenSection = Omit<PatchSection, 'oldPath' | 'newPath'> & {
    header: string;
    fromPath?: string;
    toPath?: string;
  };
  const sections: OpenSection[] = [];
  let section: OpenSection | undefined;
  let hunk: ParsedHunk | undefined;

  for (const line of text.split(/(?<=\n)/)) {
    if (line === '') continue;
    if (line.startsWith('diff --git ')) {
      section = { header: line, binary: false, hunks: [] };
      sections.push(section);
      hunk = undefined;
    } else if (section === undefined) {
      throw new Error(
        `Unexpected diff output before the first file header: ${JSON.stringify(line)}`,
      );
    } else if (line.startsWith('@@ ')) {
      const m = HUNK_HEADER.exec(line);
      if (!m) throw new Error(`Malformed hunk header: ${JSON.stringify(line)}`);
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        patch: line,
      };
      section.hunks.push(hunk);
    } else if (hunk) {
      hunk.patch += line;
    } else if (line.startsWith('Binary files ')) {
      section.binary = true;
    } else {
      const from = /^(?:rename|copy) from (.*)/s.exec(line);
      const to = /^(?:rename|copy) to (.*)/s.exec(line);
      if (from?.[1] !== undefined) section.fromPath = headerField(from[1]);
      if (to?.[1] !== undefined) section.toPath = headerField(to[1]);
    }
    // Other lines before the first hunk are extended headers (mode, index, ---/+++).
  }

  return sections.map(({ header, fromPath, toPath, binary, hunks }) => {
    let oldPath: string;
    let newPath: string;
    if (fromPath === undefined && toPath === undefined) {
      oldPath = newPath = headerPath(header);
    } else if (fromPath !== undefined && toPath !== undefined) {
      [oldPath, newPath] = [fromPath, toPath];
    } else {
      throw new Error(`Incomplete rename or copy headers after ${JSON.stringify(header)}`);
    }
    for (const h of hunks) checkLineCounts(newPath, h);
    return { oldPath, newPath, binary, hunks };
  });
}

export interface HunkLine {
  kind: 'context' | 'added' | 'removed';
  /** 1-based line number on the old side; null for added lines. */
  oldLine: number | null;
  /** 1-based line number on the new side; null for removed lines. */
  newLine: number | null;
  /** The line's text without the diff marker and newline. */
  text: string;
}

/**
 * Maps each line of a hunk to its old and new line numbers. "\ No newline at end of file"
 * markers are not lines of either file and are skipped.
 */
export function hunkLines(hunk: Pick<ParsedHunk, 'oldStart' | 'newStart' | 'patch'>): HunkLine[] {
  const lines = hunk.patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const result: HunkLine[] = [];
  for (const line of lines.slice(1)) {
    const text = line.slice(1);
    if (line.startsWith(' ')) {
      result.push({ kind: 'context', oldLine: oldLine++, newLine: newLine++, text });
    } else if (line.startsWith('-')) {
      result.push({ kind: 'removed', oldLine: oldLine++, newLine: null, text });
    } else if (line.startsWith('+')) {
      result.push({ kind: 'added', oldLine: null, newLine: newLine++, text });
    } else if (!line.startsWith('\\')) {
      throw new Error(`Unexpected line in hunk: ${JSON.stringify(line)}`);
    }
  }
  return result;
}

/** Guards against a hunk silently losing or gaining lines while being split out. */
function checkLineCounts(path: string, hunk: ParsedHunk): void {
  const lines = hunkLines(hunk);
  const oldCount = lines.filter((l) => l.oldLine !== null).length;
  const newCount = lines.filter((l) => l.newLine !== null).length;
  if (oldCount !== hunk.oldLines || newCount !== hunk.newLines) {
    throw new Error(
      `Hunk in ${path} has ${oldCount}/${newCount} old/new lines, header says ` +
        `${hunk.oldLines}/${hunk.newLines}: ${JSON.stringify(hunk.patch.split('\n')[0])}`,
    );
  }
}

/**
 * The path from the `diff --git a/<path> b/<path>` line of a file that was not renamed. Both
 * names are then the same, which makes an unquoted header unambiguous even when the path contains
 * spaces. A rename's header is ambiguous, so its paths come from `rename from`/`rename to`.
 */
export function headerPath(line: string): string {
  const rest = line.slice('diff --git '.length).replace(/\n$/, '');
  if (rest.startsWith('"')) {
    const [oldName, end] = unquote(rest, 0);
    if (!oldName.startsWith('a/')) throw new Error(`Unexpected diff header: ${rest}`);
    const path = oldName.slice(2);
    const newPart = rest.slice(end + 2); // after the closing quote and a space
    const [newName] = newPart.startsWith('"') ? unquote(newPart, 0) : [newPart];
    if (newName !== `b/${path}`) throw new Error(`Unexpected diff header: ${rest}`);
    return path;
  }
  const n = (rest.length - 5) / 2;
  const path = rest.slice(2, 2 + n);
  if (!Number.isInteger(n) || n < 1 || rest !== `a/${path} b/${path}`) {
    throw new Error(`Unexpected diff header: ${rest}`);
  }
  return path;
}

/** The path in an extended header line such as `rename from <path>`, quoted or not. */
function headerField(field: string): string {
  const value = field.replace(/\n$/, '');
  if (!value.startsWith('"')) return value;
  const [path, end] = unquote(value, 0);
  if (end !== value.length - 1) throw new Error(`Unexpected diff header field: ${value}`);
  return path;
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/**
 * Decodes a C-style quoted name as Git writes it (`core.quotePath`): octal escapes are raw
 * bytes, decoded as UTF-8. Returns the name and the index of the closing quote.
 */
function unquote(s: string, start: number): [string, number] {
  const bytes: number[] = [];
  let i = start + 1;
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\') {
      const octal = /^[0-7]{3}/.exec(s.slice(i + 1, i + 4));
      const escaped = ESCAPES[s[i + 1] ?? ''];
      if (octal) {
        bytes.push(parseInt(octal[0], 8));
        i += 4;
      } else if (escaped !== undefined) {
        bytes.push(escaped);
        i += 2;
      } else {
        throw new Error(`Unknown escape in quoted path: ${s}`);
      }
    } else {
      const ch = String.fromCodePoint(s.codePointAt(i) ?? 0);
      bytes.push(...Buffer.from(ch, 'utf8'));
      i += ch.length;
    }
  }
  if (i >= s.length) throw new Error(`Unterminated quoted path: ${s}`);
  return [Buffer.from(bytes).toString('utf8'), i];
}

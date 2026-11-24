// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Where a path's content moved from: for a move target, the path it was moved from (chained). */
  readonly origin = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Write a file's new content (a create or a change of its bytes). */
  put(p: string, text: string): void {
    this.now.set(p, text);
  }
  /** Delete a file. */
  remove(p: string): void {
    this.now.set(p, null);
    this.origin.delete(p);
  }
  /** Move a file: the old path stops existing, the new path holds the text. */
  move(from: string, to: string, text: string): void {
    this.now.set(from, null);
    this.now.set(to, text);
    this.origin.set(to, this.origin.get(from) ?? from);
  }
}

/** Split a file's text into its lines, its line break and whether it ends with one (section 3). */
function fileLines(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

/** Join lines with a file's own line break, with a final one exactly when `final`. */
function joinLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const leadWs = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Positions where O matches the file's lines at one tier (section 5). */
function occurrencesAt(file: string[], o: string[], tier: number): number[] {
  const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trimTrail : trimBoth;
  const want = o.map(norm);
  const out: number[] = [];
  if (want.length === 0 || want.length > file.length) return out;
  for (let i = 0; i + want.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (norm(file[i + j]!) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, with its positions there; null when it never occurs. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrencesAt(file, o, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of N: its text, whether it is a context line, and its index in O when it is. */
interface NewLine {
  text: string;
  context: boolean;
  oIndex: number;
}

/**
 * Build the replacement lines for a matched block: a context line is written as the
 * file's own matched line, never the patch's; at tier 2 every other line is re-indented
 * from O's first line's leading whitespace to the file's first matched line's (section 5).
 */
function buildReplacement(
  file: string[],
  pos: number,
  o: string[],
  n: NewLine[],
  tier: number,
): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(file[pos]!);
    p = leadWs(o[0]!);
  }
  for (const e of n) {
    if (e.context) {
      out.push(file[pos + e.oIndex]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** The first line at or after `from` equal to a single line, at the first tier with one. */
function findSingleLine(file: string[], want: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trimTrail : trimBoth;
    const w = norm(want);
    for (let i = from; i < file.length; i++) {
      if (norm(file[i]!) === w) return i;
    }
  }
  return null;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk: its old start line A and its body lines (trailing empty lines removed). */
interface Hunk {
  a: number;
  body: string[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

/** One unified section: its old and new path (null: /dev/null), its kind, its hunks. */
interface Section {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** A hunk header `@@ -A[,B] +C[,D] @@`, optionally followed by text: A, or null when malformed. */
function hunkStart(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m ? Number(m[1]) : null;
}

/** The path a `--- ` or `+++ ` header line names: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** The two paths a `diff --git a/<X> b/<Y>` line names. */
function diffGitPaths(line: string, ln: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${ln}`);
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) throw new Exit2(`error: parse ${ln}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${ln}`);
  return [x, y];
}

/** Parse a patch as a unified diff (section 6): every section is one edit. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let headerPair = false;
  let oldNamed = false;
  let newNamed = false;
  let hunk: Hunk | null = null;
  let body: string[] = [];

  const finishHunk = (): void => {
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    let last = -1;
    for (let k = 0; k < body.length; k++) {
      const b = body[k]!;
      if (b === '' || b[0] === ' ' || b[0] === '+') last = k;
    }
    const noEol = last >= 0 && last + 1 < body.length && body[last + 1]!.startsWith('\\');
    hunk!.body = body;
    hunk!.noEol = noEol;
    cur!.hunks.push(hunk!);
    body = [];
  };

  const startSection = (oldPath: string | null, newPath: string | null): void => {
    cur = { oldPath, newPath, creation: false, deletion: false, hunks: [] };
    sections.push(cur);
    headerPair = false;
    oldNamed = false;
    newNamed = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const ln = i + 1;
    const next = i + 1 < lines.length ? lines[i + 1]! : '';
    if (hunk !== null) {
      const endsBody = line.startsWith('diff --git ') || (line.startsWith('--- ') && next.startsWith('+++ '));
      if (!endsBody && (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\')) {
        body.push(line);
        continue;
      }
      finishHunk();
      hunk = null;
    }
    if (line.startsWith('diff --git ')) {
      const [x, y] = diffGitPaths(line, ln);
      startSection(x, y);
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !headerPair) {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(next);
        headerPair = true;
        oldNamed = true;
        newNamed = true;
      } else {
        startSection(headerPath(line), headerPath(next));
        headerPair = true;
        oldNamed = true;
        newNamed = true;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${ln + 1}`);
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const a = hunkStart(line);
      if (a === null) throw new Exit2(`error: parse ${ln}`);
      hunk = { a, body: [], noEol: false };
      continue;
    }
    if (line.startsWith('+++ ') && cur !== null && cur.hunks.length === 0 && !newNamed) {
      cur.newPath = headerPath(line);
      newNamed = true;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ') && !oldNamed) {
        cur.oldPath = line.slice('rename from '.length).trim();
        oldNamed = true;
      } else if (line.startsWith('rename to ') && !newNamed) {
        cur.newPath = line.slice('rename to '.length).trim();
        newNamed = true;
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.creation = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.deletion = true;
    }
  }
  if (hunk !== null) finishHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

/** Split a hunk body into its old lines O and its new lines N (section 6). */
function hunkLines(h: Hunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  let oIdx = 0;
  for (const raw of h.body) {
    if (raw === '') {
      o.push('');
      n.push({ text: '', context: true, oIndex: oIdx });
      oIdx++;
    } else if (raw[0] === ' ') {
      const t = raw.slice(1);
      o.push(t);
      n.push({ text: t, context: true, oIndex: oIdx });
      oIdx++;
    } else if (raw[0] === '-') {
      o.push(raw.slice(1));
      oIdx++;
    } else if (raw[0] === '+') {
      n.push({ text: raw.slice(1), context: false, oIndex: -1 });
    }
  }
  return { o, n };
}

/** Apply one hunk to a file's lines. `d` is the length drift of this section's earlier hunks. */
function applyHunk(
  lines: string[],
  final: boolean,
  h: Hunk,
  d: number,
  path: string,
  strict: boolean,
): { lines: string[]; final: boolean; oLen: number; nLen: number } {
  const { o, n } = hunkLines(h);
  if (o.length > 0) {
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.at[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.at) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const repl = buildReplacement(lines, best, o, n, found.tier);
    const out = [...lines.slice(0, best), ...repl, ...lines.slice(best + o.length)];
    const touchesEof = best + o.length === lines.length;
    return { lines: out, final: touchesEof ? !h.noEol : final, oLen: o.length, nLen: n.length };
  }
  const ins = n.map((e) => e.text);
  let pos = h.a + d;
  if (pos < 0) pos = 0;
  if (pos > lines.length) pos = lines.length;
  const out = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
  const atEnd = pos === lines.length;
  return { lines: out, final: atEnd ? !h.noEol : final, oLen: 0, nLen: n.length };
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyHunks(
  lines: string[],
  final: boolean,
  hunks: Hunk[],
  path: string,
  strict: boolean,
): { lines: string[]; final: boolean } {
  let d = 0;
  let cur = lines;
  let curFinal = final;
  for (const h of hunks) {
    const res = applyHunk(cur, curFinal, h, d, path, strict);
    d += res.nLen - res.oLen;
    cur = res.lines;
    curFinal = res.final;
  }
  return { lines: cur, final: curFinal };
}

/** One unified section as one edit (section 6). */
function sectionEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (s.creation || oldP === null) {
      const p = newP;
      if (p === null) return;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.startsWith('+')) {
            plus.push(h.body[k]!.slice(1));
            noEol = k + 1 < h.body.length && h.body[k + 1]!.startsWith('\\');
          }
        }
      }
      tree.put(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (s.deletion || newP === null) {
      const p = oldP;
      if (p === null) return;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.remove(p);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const { lines, br, final } = fileLines(tree.get(oldP)!);
      const res = applyHunks(lines, final, s.hunks, oldP, strict);
      tree.move(oldP, newP, joinLines(res.lines, br, res.final));
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    if (tree.get(p) === null) throw new Fail('missing', p);
    const { lines, br, final } = fileLines(tree.get(p)!);
    const res = applyHunks(lines, final, s.hunks, p, strict);
    tree.put(p, joinLines(res.lines, br, res.final));
  };
}

/** Parse a patch as SEARCH/REPLACE blocks (section 7): every block is one edit. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (;;) {
    let s = -1;
    for (let j = prevEnd + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    for (let j = sep + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${s + 1}`);
    const p = path;
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.put(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const { lines: fl, br, final } = fileLines(cur);
      const found = findTier(fl, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const pos = found.at[0]!;
      const repl = buildReplacement(
        fl,
        pos,
        oldLines,
        newLines.map((t) => ({ text: t, context: false, oIndex: -1 })),
        found.tier,
      );
      const out = [...fl.slice(0, pos), ...repl, ...fl.slice(pos + oldLines.length)];
      tree.put(p, joinLines(out, br, final));
    });
    prevPath = p;
    prevEnd = end;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One V4A chunk: its anchor (null: none), whether it is anchored to the end of the file, its body. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

/** Parse a patch as a V4A patch (section 8): every section is one edit. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (lines[j]!.trim() !== '') {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && lines[i]!.trim() === '') i++;
    if (i >= last) break;
    const line = lines[i]!;
    const ln = i + 1;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${ln}`);
    }
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      j++;
    }
    const raw: Array<{ text: string; ln: number }> = [];
    for (let k = i + 1; k < j; k++) raw.push({ text: lines[k]!, ln: k + 1 });
    while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
    edits.push(v4aSectionEdit(kind, path, raw, ln, strict));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One V4A section as one edit (section 8). */
function v4aSectionEdit(
  kind: 'add' | 'delete' | 'update',
  path: string,
  raw: Array<{ text: string; ln: number }>,
  headerLn: number,
  strict: boolean,
): Edit {
  if (kind === 'add') {
    const fileLinesOut: string[] = [];
    for (const { text, ln } of raw) {
      if (text === '') fileLinesOut.push('');
      else if (text.startsWith('+')) fileLinesOut.push(text.slice(1));
      else throw new Exit2(`error: parse ${ln}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.put(path, fileLinesOut.length === 0 ? '' : fileLinesOut.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.ln}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.remove(path);
    };
  }
  let moveTo: string | null = null;
  let rest = raw;
  if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
    rest = rest.slice(1);
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (const { text, ln } of rest) {
    if (text.startsWith('@@')) {
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (text === '' && cur === null && chunks.length > 0) continue;
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) {
        if (chunks.length === 0) {
          cur = { anchor: null, eof: false, body: [] };
          chunks.push(cur);
        } else {
          throw new Exit2(`error: parse ${ln}`);
        }
      }
      cur.body.push(text);
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLn}`);
  const to = moveTo;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (to !== null && !safe(to)) throw new Fail('unsafe', to);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
    let { lines: fl, br, final } = fileLines(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findSingleLine(fl, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o: string[] = [];
      const n: NewLine[] = [];
      let oIdx = 0;
      for (const rawLine of ch.body) {
        if (rawLine === '') {
          o.push('');
          n.push({ text: '', context: true, oIndex: oIdx });
          oIdx++;
        } else if (rawLine[0] === ' ') {
          const t = rawLine.slice(1);
          o.push(t);
          n.push({ text: t, context: true, oIndex: oIdx });
          oIdx++;
        } else if (rawLine[0] === '-') {
          o.push(rawLine.slice(1));
          oIdx++;
        } else if (rawLine[0] === '+') {
          n.push({ text: rawLine.slice(1), context: false, oIndex: -1 });
        }
      }
      if (o.length > 0) {
        const tiers = strict ? [0] : [0, 1, 2];
        let found: { tier: number; at: number[] } | null = null;
        for (const tier of tiers) {
          let occ = occurrencesAt(fl, o, tier).filter((pos) => pos >= cursor);
          if (ch.eof) occ = occ.filter((pos) => pos + o.length === fl.length);
          if (occ.length > 0) {
            found = { tier, at: occ };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        const pos = found.at[0]!;
        const repl = buildReplacement(fl, pos, o, n, found.tier);
        fl = [...fl.slice(0, pos), ...repl, ...fl.slice(pos + o.length)];
        cursor = pos + repl.length;
      } else {
        const ins = n.map((e) => e.text);
        const pos = ch.eof ? fl.length : cursor;
        fl = [...fl.slice(0, pos), ...ins, ...fl.slice(pos)];
        cursor = pos + ins.length;
      }
    }
    const out = joinLines(fl, br, final);
    if (to !== null) tree.move(path, to, out);
    else tree.put(path, out);
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const originBefore = new Map(tree.origin);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.origin.clear();
      for (const [k, v] of originBefore) tree.origin.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const origin = new Map<string, string>();
  for (const [to, o] of tree.origin) origin.set(to, o);
  const rNew = new Map<string, string>();
  for (const [to, o] of origin) {
    if (tree.original(to) === null && tree.now.get(to) !== null && tree.original(o) !== null && tree.now.get(o) === null) {
      rNew.set(to, o);
    }
  }
  const rOld = new Set(rNew.values());
  const entries: Array<{ key: string; text: string }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p)) continue;
    const old = rNew.get(p);
    entries.push(
      old !== undefined
        ? { key: p, text: `R ${old} -> ${p}` }
        : { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` },
    );
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

// The line builder is isolated from the solver: none of its files imports src/solver, nothing the server or the page
// loads reaches the solver through any chain of imports, and none of it loads code the walk cannot follow.

import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const LINE_FILES = [
  'src/server/lines.ts', 'src/server/lineDeps.ts', 'src/server/lineDamage.ts', 'src/server/lineView.ts', 'src/server/lineSummary.ts',
  'src/server/box.ts', 'src/server/sheetAi.ts',
  'src/integration/fight.ts', 'src/integration/baseDeps.ts', 'src/integration/battleView.ts', 'src/integration/labeler.ts', 'src/integration/resolver.ts',
];
const FORBIDDEN = [/^src\/solver\//, /^src\/engines\//, /^src\/integration\/(realSolver|deps|contextDeps|workerDeps|oracles|hints|benchSplit|planRequest)\.ts$/];

/** The specifiers `text` loads by a literal (`from`, `import '…'`, `import('…')`, any quotes, a template without `${`). */
const literalSpecifiers = (text: string): string[] => [...text.matchAll(/(?:from\s+|import\s*\(\s*|^import\s+)(['"`])([^'"`$\n]+)\1/gm)].map((m) => m[2]!);

/** Every file the roots reach through relative imports, with the file that led to it. */
function reach(roots: string[]): Map<string, string | null> {
  const resolve = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/\.js$/, '');
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) ?? null;
  };
  const seen = new Map<string, string | null>();
  const queue: [string, string | null][] = roots.map((root) => [root, null]);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [file, via] = next;
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    seen.set(file, via);
    for (const spec of literalSpecifiers(fs.readFileSync(file, 'utf8'))) {
      const to = resolve(file, spec);
      if (to !== null && !seen.has(to)) queue.push([to, file]);
    }
  }
  return seen;
}

const pageFiles = (fs.readdirSync('web/src', { recursive: true }) as string[]).map((f) => `web/src/${f.replaceAll('\\', '/')}`).filter((f) => /\.tsx?$/.test(f));
let reachedOnce: Map<string, string | null> | null = null;
const serverAndPage = () => (reachedOnce ??= reach(['src/server/main.ts', ...pageFiles]));

/**
 * Loads the walk cannot follow, matched on `codeOnly` text so prose and strings never count. The lookahead excludes
 * white space too, so `\s*` cannot give back a space to make `import( 'x')` match.
 */
const UNFOLLOWABLE: [string, RegExp][] = [
  ['new Worker(', /\bnew\s+[\w.]*Worker\s*\(/],
  ['require(', /\brequire\s*\(/],
  ['createRequire(', /\bcreateRequire\s*\(/],
  ['import() of a non-literal', /\bimport\s*\(\s*(?:(?![\s'"`])|`[^`]*\$\{)/],
];

/**
 * `text` with comments blanked and string, template and regex literals emptied (quotes kept; a template keeps its `${…}`
 * code). A `/` starts a regex where a value cannot end. A string or regex stops at its line's end, so a JSX apostrophe or
 * `</p>` can only blank the rest of its line.
 */
function codeOnly(text: string): string {
  let out = '';
  let prev = '';   // the last code character that is not white space
  const regexCanStart = () => prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev)
    || /(?:^|[^\w$.])(?:return|typeof|case|void|yield|await|delete|in|of|new|else|do|throw)$/.test(out.slice(-16).trimEnd());
  /** The index of the unescaped `close` ending a one-line literal opened at `start`, else the index before its line's end. */
  const lineLiteral = (start: number, close: string, classes: boolean): number => {
    let inClass = false;
    for (let i = start + 1; i < text.length; i++) {
      const c = text[i]!;
      if (c === '\\') i++;
      else if (c === '\n') return i - 1;
      else if (classes && c === '[') inClass = true;
      else if (classes && c === ']') inClass = false;
      else if (c === close && !inClass) return i;
    }
    return text.length;
  };
  /** Code from `start` to the end, or (`inner`) to the `}` closing a template's `${`, whose index it returns. */
  const code = (start: number, inner: boolean): number => {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const c = text[i]!;
      const next = text[i + 1];
      if (c === '/' && next === '/') {
        const end = text.indexOf('\n', i);
        i = end < 0 ? text.length : end - 1;
        out += ' ';
      } else if (c === '/' && next === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? text.length : end + 1;
        out += ' ';
      } else if (c === "'" || c === '"') {
        i = lineLiteral(i, c, false);
        out += c + c;
        prev = 'x';
      } else if (c === '/' && regexCanStart()) {
        i = lineLiteral(i, '/', true);
        while (/\w/.test(text[i + 1] ?? '')) i++;   // the flags
        out += '/_/';
        prev = 'x';
      } else if (c === '`') {
        out += '`';
        i = template(i + 1);
        out += '`';
        prev = 'x';
      } else if (inner && c === '}' && depth === 0) {
        return i;
      } else {
        if (c === '{') depth++;
        if (c === '}') depth--;
        out += c;
        if (!/\s/.test(c)) prev = c;
      }
    }
    return text.length;
  };
  /** A template's text from `start`, kept as its `${…}` code only; returns the index of its closing backtick. */
  const template = (start: number): number => {
    for (let i = start; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '`') return i;
      else if (text[i] === '$' && text[i + 1] === '{') {
        out += '${';
        prev = '{';
        i = code(i + 2, true);
        out += '}';
      }
    }
    return text.length;
  };
  code(0, false);
  return out;
}

function unfollowable(text: string): string[] {
  const only = codeOnly(text);
  return UNFOLLOWABLE.filter(([, re]) => re.test(only)).map(([what]) => what);
}

it.each(LINE_FILES)('%s imports nothing from src/solver', (file) => {
  // '../contracts/solver.js' is a contract and passes.
  expect(literalSpecifiers(fs.readFileSync(file, 'utf8')).filter((s) => /(^|\/)solver\//.test(s))).toEqual([]);
});

it('nothing the server (src/server/main.ts) or the page (web/src) reaches is the solver or its glue', () => {
  const reached = serverAndPage();
  for (const must of ['src/server/lines.ts', 'src/server/sheetAi.ts', 'src/integration/fight.ts', 'web/src/App.tsx']) expect(reached.has(must)).toBe(true);
  expect(reached.size).toBeGreaterThan(100);
  const chain = (file: string) => { const out = []; for (let at: string | null | undefined = file; at; at = reached.get(at)) out.push(at); return out.join(' <- '); };
  expect([...reached.keys()].filter((file) => FORBIDDEN.some((re) => re.test(file))).map(chain)).toEqual([]);
});

it.each([
  ['// lazily import(x) later', false],
  ['\'call require("x")\'', false],
  ["import( 'x')", false],
  ['import (m)', true],
  ["require ('x')", true],
  ['new Worker (f)', true],
  ['new threads.Worker(f)', true],
  ['createRequire(u)', true],
] as const)('the guard on %s: flagged %s', (line, flagged) => {
  expect(unfollowable(line).length > 0).toBe(flagged);
});

it('the walk follows every literal load the guard lets through, and the guard flags a template with a substitution', () => {
  for (const line of ["import('./a.js')", 'import("./a.js")', 'import(`./a.js`)', "import( './a.js')", 'export * from "./a.js"']) {
    expect([literalSpecifiers(line), unfollowable(line)]).toEqual([['./a.js'], []]);
  }
  const computed = 'import(`./${name}.js`)';
  expect([literalSpecifiers(computed), unfollowable(computed)]).toEqual([[], ['import() of a non-literal']]);
});

it('nothing the server or the page reaches loads code the walk cannot follow', () => {
  const files = [...serverAndPage().keys()];
  expect(files.flatMap((file) => unfollowable(fs.readFileSync(file, 'utf8')).map((what) => `${file}: ${what}`))).toEqual([]);
  // No literal or comment `codeOnly` misread swallowed a file's end: a load added there is seen.
  expect(files.filter((file) => unfollowable(`${fs.readFileSync(file, 'utf8')}\nrequire('x');\n`).length === 0)).toEqual([]);
});

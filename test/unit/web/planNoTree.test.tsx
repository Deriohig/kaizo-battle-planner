// The tree page is gone. Read as text: nothing under web/src/components but the tree's own outcome code imports the old
// page's parts, no plan-screen file asks for /api/line, and the plan screen's own words never use the tree page's vocabulary.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { expect, it } from 'vitest';

const WEB = join(__dirname, '../../../web/src');
const COMPONENTS = join(WEB, 'components');
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}
const read = (path: string) => readFileSync(path, 'utf8');
const rel = (path: string) => path.slice(WEB.length + 1).split(sep).join('/');
/** Source with its block and line comments removed (a `//` right after a colon or a quote, as in a URL, is kept). */
const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
/** The words the code shows: its string literals and JSX text, not import paths or a lone class name or path. */
function shownWords(src: string): string[] {
  const code = withoutComments(src).replace(/(\bfrom\s*|\bimport\s*)(['"])[^'"\n]*\2/g, '$1');
  const strings = [...code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
  const jsx = [...code.matchAll(/>([^<>{}=;()]*[A-Za-z][^<>{}=;()]*)</g)].map((m) => m[1]!);
  return [...strings, ...jsx].filter((w) => !/^[\w./-]+$/.test(w) || !/[-/.]/.test(w));
}
const TREE_OWN = ['components/tree/YourChoice.tsx', 'components/tree/TheirReply.tsx'];
const planFiles = [join(COMPONENTS, 'PlanView.tsx'), ...filesUnder(join(COMPONENTS, 'plan'))];

it("the removed components and useLine.ts are gone, and nothing under components but the tree's two files imports them", () => {
  const all = filesUnder(WEB).map(rel);
  for (const gone of ['LineView', 'tree/MatchupHeader', 'tree/CarriedNote', 'tree/NextFight', 'tree/Outline', 'line/TeamChange']) expect(all, gone).not.toContain(`components/${gone}.tsx`);
  expect(all).not.toContain('useLine.ts');
  const banned = /(?:from|import\()\s*['"][^'"]*\/(useLine|LineView|Outline|MatchupHeader|CarriedNote|NextFight|TeamChange)['"]/;
  expect(filesUnder(COMPONENTS).filter((f) => !TREE_OWN.includes(rel(f)) && banned.test(withoutComments(read(f)))).map(rel)).toEqual([]);
});

it('PlanView, FightView and the plan parts ask for no /api/line, and never say tree, Follow, outcome, carried, You win or You lose', () => {
  const files = [...planFiles, join(COMPONENTS, 'FightView.tsx')];
  expect(files.length).toBeGreaterThan(2);
  expect(files.filter((f) => withoutComments(read(f)).includes('/api/line')).map(rel)).toEqual([]);
  const word = /\b(tree|follow|outcomes?|carried)\b|You win|You lose/i;
  expect(planFiles.flatMap((f) => shownWords(read(f)).filter((w) => word.test(w)).map((w) => `${rel(f)}: ${w}`))).toEqual([]);
});

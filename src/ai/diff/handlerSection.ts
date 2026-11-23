// The handler-level block of docs/ai-changes.md (`<!-- generated:handlers -->`): overlay 16's battle C diffed function
// by function (handlerDiff.ts), its data, its side-effect subscript table, and the other binaries that hold or feed the
// battle code: overlays 12 to 14 and the ARM9 binary.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOverlay, readOverlayTable } from '../../nds/overlay.js';
import {
  blSites, callerBodies, callsInto, diffData, diffFunctions, type FunctionDiff, type FunctionLayout, functionIndex,
  layoutOverlay, layoutStatic, type OverlayFunction, reachedFrom, type SourceFunction, sourceFunctions, type TableSpec,
} from './handlerDiff.js';
import { type AlignedRegion, type Alignment, alignHalfwords, type CodeImage, diffOverlay, explainRegion, wordAt } from './overlayDiff.js';

/** The block's name: it sits between `<!-- generated:handlers -->` and `<!-- /generated:handlers -->`. */
export const HANDLER_BLOCK = 'handlers';

const MAIN_LSF = join('platinum.us', 'main.lsf.in');
const BTLCMD_H = join('include', 'data', 'scripts', 'btlcmd.h');
const CONTROLLER_H = join('include', 'battle', 'battle_controller_player.h');
const IO_COMMANDS_H = join('include', 'constants', 'battle', 'battle_controller.h');
const SIDE_EFFECTS_H = 'include/data/move_side_effect_subscripts.h';
const SUBSCRIPT_POINTERS = join('generated', 'battle_move_subscript_ptrs.txt');
const SUB_SEQ_ORDER = join('res', 'battle', 'scripts', 'subscripts', 'sub_seq.order');
const BATTLE_OVERLAY = 16;
const AI_OVERLAY = 14;
/** The overlays main.lsf.in links for the battle besides overlay 16 (main.lsf.in:627, 655, 670). */
const OTHER_OVERLAYS = [
  { id: 12, name: 'battle_anim', holds: 'battle animations' },
  { id: 13, name: 'battle_sub_menus', holds: 'the battle bag and party menus' },
  { id: 14, name: 'trainer_ai', holds: 'the trainer AI' },
];
/** Where the hack loads code of its own (its boot code calls a loader with this address, ARM9 0x02101574). */
const EXPANSION = { start: 0x023c8000, end: 0x02400000 };
/** sItemArchiveIDs' fields (item.c:49–88, Item_FileID), one u16 each. */
const ITEM_ARCHIVE_FIELDS = ['dataID', 'iconID', 'paletteID', 'gen3ID'];

/** What the block is made from. */
export interface HandlerInputs { hackRom: Uint8Array; vanillaRom: Uint8Array; decompDir: string }

/** Everything the sections share. */
export interface Context {
  read(path: string): string;
  vanillaRom: Uint8Array;
  hackRom: Uint8Array;
  vanilla: FunctionLayout;
  hack: FunctionLayout;
  alignment: Alignment;
  diff: FunctionDiff;
  sources: SourceFunction[];
  tables: Table[];
}

/**
 * Overlay 16 of both ROMs laid out function by function (handlerDiff.ts) from the decompilation's battle files, and the
 * two layouts compared. Throws if the functions don't pair up one for one.
 */
export function battleLayouts({ hackRom, vanillaRom, decompDir }: HandlerInputs): Context {
  const read = (path: string) => readFileSync(join(decompDir, path), 'utf8');
  const battleFiles = lsfObjects(read(MAIN_LSF), 'Overlay battle');
  const sources = battleFiles.flatMap((path) => sourceFunctions(read(path), baseName(path)));
  const tables = commandTables(read, battleFiles);
  const specs = tables.map((table) => table.spec);
  const vanilla = layoutOverlay(overlayImage(vanillaRom, BATTLE_OVERLAY), sources, specs, 'ov16');
  const hack = layoutOverlay(overlayImage(hackRom, BATTLE_OVERLAY), sources, specs, 'ov16');
  const alignment = alignHalfwords(vanilla.image.bytes, hack.image.bytes);
  const diff = diffFunctions(vanilla, hack, (offset) => alignment.toHack(offset));
  if (diff.vanillaOnly.length > 0 || diff.hackOnly.length > 0) throw new Error('overlay 16\'s functions don\'t pair up');
  return { read, vanillaRom, hackRom, vanilla, hack, alignment, diff, sources, tables };
}

/** The handler-level block of docs/ai-changes.md, without its markers. */
export function generateHandlerBlock(inputs: HandlerInputs): string {
  const context = battleLayouts(inputs);
  return [
    '_Written by `npx tsx src/ai/diff/cli.ts` from the two ROMs and the decompilation. Do not edit by hand._',
    '',
    ...functionSection(context),
    ...dataSection(context),
    ...sideEffectSection(context),
    ...otherBinariesSection(context),
  ].join('\n');
}

/** A command table with where the decompilation defines it. */
export interface Table { spec: TableSpec; file: string; line: number; what: string }

/** The three command tables of overlay 16, each entry named by the decompilation in index order. */
function commandTables(read: (path: string) => string, files: string[]): Table[] {
  const script = 'src/battle/battle_script.c';
  const controller = 'src/battle/battle_controller_player.c';
  const io = 'src/battle/battle_io_command.c';
  for (const path of [script, controller, io]) {
    if (!files.includes(path)) throw new Error(`main.lsf.in doesn't link ${path} into overlay 16`);
  }
  const btlcmd = [...read(BTLCMD_H).matchAll(/ScriptCommand\(\w+,\s*(\w+)\)/g)].map((match) => match[1]!);
  const table = (symbol: string, file: string, names: string[], what: string): Table => ({
    spec: { symbol, source: file, names }, file, line: lineOf(read(file), `${symbol}[] = {`), what,
  });
  return [
    table('sBattleCommands', script, btlcmd, 'battle script commands'),
    table('sBattleControlCommands', controller, designatedTable(read(controller), read(CONTROLLER_H), 'BATTLE_CONTROL_'), 'battle controller steps'),
    table('sBattleCommands', io, designatedTable(read(io), read(IO_COMMANDS_H), 'BATTLE_COMMAND_'), 'battle IO commands'),
  ];
}

/** A table written `[PREFIX_X] = Name,`, as names in index order: each index is the constant's value in `enumText`. */
function designatedTable(source: string, enumText: string, prefix: string): string[] {
  const values = enumValues(enumText, prefix);
  const names: string[] = [];
  for (const match of source.matchAll(new RegExp(`\\[(${prefix}\\w+)\\]\\s*=\\s*(\\w+)`, 'g'))) {
    const value = values.get(match[1]!);
    if (value === undefined) throw new Error(`no value for ${match[1]}`);
    names[value] = match[2]!;
  }
  if (names.length === 0 || names.some((name) => name === undefined)) throw new Error(`the ${prefix}* table has gaps`);
  return names;
}

/** The values of the enumerators starting `prefix` in `text`: in order from 0, or from an explicit `= N`. */
function enumValues(text: string, prefix: string): Map<string, number> {
  const values = new Map<string, number>();
  let next = 0;
  for (const match of text.matchAll(new RegExp(`^\\s*(${prefix}\\w+)\\s*(?:=\\s*(\\d+))?\\s*,?\\s*(?://.*)?$`, 'gm'))) {
    const value = match[2] === undefined ? next : Number(match[2]);
    values.set(match[1]!, value);
    next = value + 1;
  }
  return values;
}

function functionSection({ vanilla, hack, alignment, diff, sources, tables, vanillaRom }: Context): string[] {
  const evidence = count(vanilla.functions.map((fn) => fn.evidence));
  const status = count(diff.pairs.map((pair) => pair.status));
  const relocated = diff.pairs.filter((pair) => pair.status === 'relocated');
  const bls = relocated.reduce((sum, pair) => sum + pair.relocations.bl, 0);
  const pointers = relocated.reduce((sum, pair) => sum + pair.relocations.pointer, 0);
  const changed = diff.pairs.filter((pair) => pair.status === 'changed');
  const lines = new Map(sources.filter((fn) => !fn.inline).map((fn) => [fn.name, `${fn.file}:${fn.line}`]));
  const aiReach = reachedFrom(vanilla, callsInto(overlayImage(vanillaRom, AI_OVERLAY), vanilla.image.base, vanilla.image.bytes.length));

  // Each changed halfword run of the alignment, explained with the alignment's own mapping.
  const alignedToHack = (address: number) => {
    const offset = address - vanilla.image.base;
    if (offset < 0 || offset >= vanilla.image.bytes.length) return address;
    const mapped = alignment.toHack(offset);
    return mapped === null ? null : hack.image.base + mapped;
  };
  const explained = alignment.regions.map((region) => ({ region, relocations: explainRegion(vanilla.image, hack.image, region, alignedToHack) }));
  const holder = (region: AlignedRegion) => {
    if (region.vanillaStart >= vanilla.codeEnd) return null;
    const at = region.vanillaStart === region.vanillaEnd ? region.vanillaStart - 2 : region.vanillaStart;
    const k = functionIndex(vanilla.functions, at);
    return k < 0 ? null : vanilla.functions[k]!;
  };
  const task3 = explained.filter((entry) => entry.relocations === null);
  const changedStarts = new Set(changed.map((pair) => pair.vanilla.start));
  const codeTask3 = task3.filter((entry) => holder(entry.region) !== null);
  const everyRegionInChanged = codeTask3.every((entry) => changedStarts.has(holder(entry.region)!.start));
  const everyChangedHasRegion = changed.every((pair) => codeTask3.some((entry) => holder(entry.region)!.start === pair.vanilla.start));
  // Relocations the alignment found inside a changed function: those that reach outside it must reach the paired place.
  const symbolToHack = carryAddress(vanilla, hack, diff);
  const inside = explained.filter((entry) => entry.relocations !== null && changedStarts.has(holder(entry.region)?.start ?? -1))
    .flatMap((entry) => entry.relocations!.map((relocation) => ({ relocation, fn: holder(entry.region)! })));
  const reachesOut = inside.filter(({ relocation, fn }) => {
    const target = (relocation.vanillaTarget & ~1) - vanilla.image.base;
    return target < fn.start || target >= fn.end;
  });
  const agree = reachesOut.filter(({ relocation }) => symbolToHack(relocation.vanillaTarget) === relocation.hackTarget).length;

  return [
    '### Overlay 16 by function',
    '',
    `Overlay 16's code runs from offset 0 to 0x${hex(vanilla.codeEnd, 5)} in vanilla and 0x${hex(hack.codeEnd, 5)} in the hack; its data `
      + `follows. Both hold ${vanilla.functions.length.toLocaleString('en-US')} functions, which pair up in order with the same names. `
      + `${evidence.get('table') ?? 0} names come from the command tables, ${evidence.get('call') ?? 0} from a named caller's calls `
      + `and ${evidence.get('count') ?? 0} by count between named functions; ${evidence.get('address') ?? 0} keep an address name. `
      + `${vanilla.longBranches.length} BL targets are long branches inside a function, not function starts.`,
    '',
    '| Table | Defined at | Vanilla offset | Hack offset | Entries | Entries pointing at the paired function |',
    '| --- | --- | --- | --- | --- | --- |',
    ...tables.map((table, t) => {
      const v = vanilla.tables[t]!;
      const h = hack.tables[t]!;
      const paired = v.targets.filter((target, k) => diff.carry(target) === h.targets[k]).length;
      return `| \`${table.spec.symbol}\` (${table.what}) | ${baseName(table.file)}:${table.line} | 0x${hex(v.offset, 5)} `
        + `| 0x${hex(h.offset, 5)} | ${v.targets.length} | ${paired === v.targets.length ? `all ${paired}` : `${paired}`} |`;
    }),
    '',
    `Of the ${diff.pairs.length.toLocaleString('en-US')} function pairs, ${status.get('identical') ?? 0} are the same byte for byte and `
      + `${status.get('relocated') ?? 0} differ only by relocations (${bls.toLocaleString('en-US')} BLs and ${pointers} pointers that `
      + `reach the paired function or the same data). ${changed.length} changed:`,
    '',
    '| Function | Named by | Vanilla | Hack | What differs | Overlay 14 reaches it |',
    '| --- | --- | --- | --- | --- | --- |',
    ...changed.map((pair) => {
      const v = pair.vanilla;
      const h = pair.hack;
      const what = pair.spots.length > 0
        ? pair.spots.map((spot) => `0x${hex(spot.vanillaStart, 5)} (${spot.vanillaEnd - spot.vanillaStart} bytes)`).join(', ')
        : `the size, ${v.end - v.start} → ${h.end - h.start} bytes`;
      const reach = aiReach.get(v.start);
      return `| \`${v.name}\` (${lines.get(v.name) ?? '?'}) | ${v.evidence} | 0x${hex(v.start, 5)}, ${v.end - v.start} bytes `
        + `| 0x${hex(h.start, 5)}, ${h.end - h.start} bytes | ${what} | ${reach === undefined ? 'no' : `yes, through ${reach.join(' → ')}`} |`;
    }),
    '',
    `Overlay 14 reaches ${aiReach.size} of overlay 16's functions by BL, directly or through overlay 16's own calls.`,
    '',
    '#### Overlay regions by function',
    '',
    `The alignment finds ${alignment.regions.length} changed regions; ${alignment.regions.length - task3.length} are relocations. `
      + 'The others, by the function or data they fall in:',
    '',
    '| Vanilla offset | Vanilla bytes | Hack offset | Hack bytes | In |',
    '| --- | --- | --- | --- | --- |',
    ...task3.map(({ region }) => `| 0x${hex(region.vanillaStart, 5)} | ${region.vanillaEnd - region.vanillaStart} `
      + `| 0x${hex(region.hackStart, 5)} | ${region.hackEnd - region.hackStart} | ${holder(region) === null ? 'data' : `\`${holder(region)!.name}\``} |`),
    '',
    `${everyRegionInChanged ? 'Each code region lies in a changed function' : 'Not every code region lies in a changed function'}, and `
      + `${everyChangedHasRegion ? 'each changed function holds at least one' : 'some changed function holds none'}. The function-level `
      + 'comparison carries code by function, not by the alignment, so no other function hides a change behind a relocation. '
      + `Inside the changed functions, the alignment counts ${inside.length} relocations; ${reachesOut.length} of them reach outside `
      + `their function, and ${agree === reachesOut.length ? 'every one of those' : `${agree} of those`} reaches the paired function or data.`,
    '',
  ];
}

/** A vanilla overlay 16 address carried to the hack's by function pairing (code) or the alignment (data); others stay. */
function carryAddress(vanilla: FunctionLayout, hack: FunctionLayout, diff: FunctionDiff): (address: number) => number | null {
  return (address) => {
    const offset = (address & ~1) - vanilla.image.base;
    if (offset < 0 || offset > vanilla.image.bytes.length) return address;
    // The overlay's end address moves by the overlay's growth.
    if (offset === vanilla.image.bytes.length) return hack.image.base + hack.image.bytes.length + (address & 1);
    const carried = diff.carry(offset);
    return carried === null ? null : hack.image.base + carried + (address & 1);
  };
}

function dataSection({ vanilla, hack, alignment, diff, tables }: Context): string[] {
  const data = diffData(vanilla, hack, alignment.regions, diff);
  const other = data.filter((entry) => entry.relocations === null);
  const pointers = data.reduce((sum, entry) => sum + (entry.relocations?.length ?? 0), 0);
  // Every pointer from a function pair's same-size bodies into the data, with how far it moved.
  const moves: { at: number; delta: number; reader: string }[] = [];
  for (const pair of diff.pairs) {
    if (pair.vanilla.end - pair.vanilla.start !== pair.hack.end - pair.hack.start) continue;
    for (let r = 0; r + 4 <= pair.vanilla.end - pair.vanilla.start; r += 2) {
      if ((vanilla.image.base + pair.vanilla.start + r) % 4 !== 0) continue;
      const from = wordAt(vanilla.image, pair.vanilla.start + r)! - vanilla.image.base;
      const to = wordAt(hack.image, pair.hack.start + r)! - hack.image.base;
      if (from < vanilla.codeEnd || from >= vanilla.image.bytes.length || to < hack.codeEnd || to >= hack.image.bytes.length) continue;
      moves.push({ at: from, delta: to - from, reader: pair.vanilla.name });
    }
  }
  moves.sort((a, b) => a.at - b.at);
  const steps = moves.flatMap((move, k) => (k > 0 && move.delta !== moves[k - 1]!.delta ? [{ before: moves[k - 1]!, after: move }] : []));
  const readers = (at: number) => [...new Set(moves.filter((move) => move.at === at).map((move) => `\`${move.reader}\``))].join(', ');
  const known = tables.map((table, t) => ({ name: table.spec.symbol, offset: vanilla.tables[t]!.offset, end: vanilla.tables[t]!.offset + 4 * table.spec.names.length }));
  const inTable = (offset: number) => known.find((entry) => offset >= entry.offset && offset < entry.end)?.name;
  return [
    '### Overlay 16\'s data',
    '',
    `The data runs from 0x${hex(vanilla.codeEnd, 5)} to the end: ${(vanilla.image.bytes.length - vanilla.codeEnd).toLocaleString('en-US')} bytes `
      + `in vanilla, ${(hack.image.bytes.length - hack.codeEnd).toLocaleString('en-US')} in the hack. The alignment finds ${data.length} `
      + `changed regions in it. ${data.length - other.length} are pointer relocations (${pointers} pointers that reach the paired `
      + `function or the same data); the other ${other.length}:`,
    '',
    '| Vanilla offset | Vanilla bytes | Hack offset | Hack bytes | The hack\'s bytes there | In a command table |',
    '| --- | --- | --- | --- | --- | --- |',
    ...other.map(({ region }) => `| 0x${hex(region.vanillaStart, 5)} | ${region.vanillaEnd - region.vanillaStart} `
      + `| 0x${hex(region.hackStart, 5)} | ${region.hackEnd - region.hackStart} | ${bytesHex(hack.image.bytes, region.hackStart, region.hackEnd) || '(none)'} `
      + `| ${inTable(region.vanillaStart) ?? 'no'} |`),
    '',
    `The code's ${moves.length} pointers into the data say where the hack's data grew: they move by `
      + `${[...new Set(moves.map((move) => move.delta))].join(' or ')} bytes. `
      + steps.map(({ before, after }) => {
        const vanillaGap = [...vanilla.image.bytes.subarray(before.at, after.at)];
        const hackGap = [...hack.image.bytes.subarray(before.at + before.delta, after.at + after.delta)];
        const nonZero = (bytes: number[]) => bytes.filter((byte) => byte !== 0).join(',');
        const zerosAdded = nonZero(vanillaGap) === nonZero(hackGap) && hackGap.length > vanillaGap.length;
        const vanillaAddress = vanilla.image.base + after.at;
        const hackAddress = hack.image.base + after.at + after.delta;
        return `The data at 0x${hex(before.at, 5)} (read by ${readers(before.at)}) moves by ${before.delta}; the data at `
          + `0x${hex(after.at, 5)} (read by ${readers(after.at)}) moves by ${after.delta}. Between them the hack has `
          + `${hackGap.length - vanillaGap.length} more bytes${zerosAdded ? ', all zero' : ''}, and the later data starts at `
          + `0x${hex(vanillaAddress, 8)} in vanilla and 0x${hex(hackAddress, 8)} in the hack, both multiples of `
          + `${Math.min(largestPowerOfTwo(vanillaAddress), largestPowerOfTwo(hackAddress))}.`;
      }).join(' '),
    '',
    '**Not re-checked:** a data word that kept its vanilla value while the data it points at moved would align as '
      + 'unchanged. The diff doesn\'t chase such words, because a lone data word can look like a pointer by chance. The '
      + 'command tables are the exception: they are checked entry by entry.',
    '',
  ];
}

/** The largest power of two that divides `value` (capped at 4096). */
function largestPowerOfTwo(value: number): number {
  let power = 1;
  while (power < 4096 && value % (power * 2) === 0) power *= 2;
  return power;
}

function sideEffectSection({ read, vanilla, hack, diff }: Context): string[] {
  const pointerNames = listLines(read(SUBSCRIPT_POINTERS));
  const subscripts = listLines(read(SUB_SEQ_ORDER));
  const header = read(SIDE_EFFECTS_H);
  const expected = pointerNames.map(() => 0);
  for (const match of header.matchAll(/\[(MOVE_SUBSCRIPT_PTR_\w+)\]\s*=\s*(\w+)/g)) {
    const index = pointerNames.indexOf(match[1]!);
    if (index < 0) throw new Error(`${SUBSCRIPT_POINTERS} has no ${match[1]}`);
    expected[index] = match[2] === 'NULL' ? 0 : subscripts.indexOf(match[2]!);
    if (expected[index]! < 0) throw new Error(`${SUB_SEQ_ORDER} has no ${match[2]}`);
  }
  const words = (image: CodeImage, at: number, n: number) => Array.from({ length: n }, (_, k) => wordAt(image, at + 4 * k));
  const hits: number[] = [];
  for (let at = vanilla.codeEnd; at + 4 * expected.length <= vanilla.image.bytes.length; at += 4) {
    if (words(vanilla.image, at, expected.length).every((value, k) => value === expected[k])) hits.push(at);
  }
  if (hits.length !== 1) throw new Error(`expected sSideEffectSubscripts once in overlay 16's data, found it ${hits.length} times`);
  const offset = hits[0]!;
  const hackOffset = diff.carry(offset);
  if (hackOffset === null) throw new Error('sSideEffectSubscripts has no place in the hack');
  const hackWords = words(hack.image, hackOffset, expected.length);
  const subscriptName = (value: number | null) => (value === null ? '?' : value === 0 ? 'NULL' : `${subscripts[value] ?? 'not in vanilla'} (${value})`);
  const changed = expected.flatMap((value, k) => (hackWords[k] === value ? [] : [k]));
  const after = wordAt(vanilla.image, offset + 4 * expected.length)!;
  const hackAfter = wordAt(hack.image, hackOffset + 4 * expected.length)!;
  const sameAfter = carryAddress(vanilla, hack, diff)(after) === hackAfter;
  return [
    '### The side-effect subscript table',
    '',
    `\`sSideEffectSubscripts\` (${SIDE_EFFECTS_H}:${lineOf(header, 'sSideEffectSubscripts[]')}, included by battle_lib.c for `
      + `MapSideEffectToSubscript) maps a move's side-effect pointer to a subscript. Its ${expected.length} entries are at `
      + `0x${hex(offset, 5)} in vanilla and 0x${hex(hackOffset, 5)} in the hack. `
      + `${changed.length === 0 ? 'Every entry is the same in both.' : `${changed.length} entries differ:`} `
      + `${sameAfter ? 'The word after it is the same in both, up to relocation, so the hack\'s table is no longer.' : 'The word after it differs, so the hack\'s table may be longer.'}`,
    '',
    ...(changed.length === 0 ? [] : [
      '| Index | Pointer | Vanilla subscript | Hack subscript |',
      '| --- | --- | --- | --- |',
      ...changed.map((k) => `| ${k} | ${pointerNames[k]} | ${subscriptName(expected[k]!)} | ${subscriptName(hackWords[k] ?? null)} |`),
      '',
    ]),
  ];
}

function otherBinariesSection({ read, vanillaRom, hackRom, vanilla, hack, diff, sources }: Context): string[] {
  const toHack = carryAddress(vanilla, hack, diff);
  const rows: string[] = [];
  for (const overlay of OTHER_OVERLAYS) {
    const v = overlayImage(vanillaRom, overlay.id);
    const h = overlayImage(hackRom, overlay.id);
    if (v.bytes.length !== h.bytes.length || v.base !== h.base) {
      rows.push(`| Overlay ${overlay.id} (\`${overlay.name}\`) | ${overlay.holds} | ${v.bytes.length} and ${h.bytes.length} bytes: not compared in place |`);
      continue;
    }
    const regions = diffOverlay(v.bytes, h.bytes, new Map());
    const other = regions.filter((region) => explainRegion(v, h, evenRegion(region.start, region.end), toHack) === null).length;
    const result = regions.length === 0 ? 'identical'
      : `${regions.length} changed regions in place; ${other === 0 ? 'all' : regions.length - other} are BLs or pointers into overlay 16 `
        + `that reach the paired function${other === 0 ? '' : `; ${other} ${other === 1 ? 'is' : 'are'} something else`}`;
    rows.push(`| Overlay ${overlay.id} (\`${overlay.name}\`) | ${overlay.holds} | ${result} |`);
  }

  const v9 = arm9Image(vanillaRom);
  const h9 = arm9Image(hackRom);
  if (v9.bytes.length !== h9.bytes.length || v9.base !== h9.base) throw new Error('the two ARM9 binaries differ in size: compare them by alignment');
  const files = lsfObjects(read(MAIN_LSF), 'Static main').map((path) => ({ path, functions: sourceFunctions(read(path), path.replace(/^src\//, '')) }));
  const overlayCalls = readOverlayTable(vanillaRom).flatMap((entry) => callsInto(overlayImage(vanillaRom, entry.id), v9.base, v9.bytes.length));
  const functions = layoutStatic(v9, files, callerBodies(vanilla, sources), overlayCalls);
  const laidOut = { start: functions[0]!.start, end: functions[functions.length - 1]!.end };
  const battleCalls = [BATTLE_OVERLAY, AI_OVERLAY].flatMap((id) => callsInto(overlayImage(vanillaRom, id), v9.base, v9.bytes.length));
  const reach = reachedFrom({ image: v9, functions }, battleCalls);
  const regions = diffOverlay(v9.bytes, h9.bytes, new Map());
  const references = dataReferences(v9, functions, laidOut);
  // The hack's BLs that vanilla doesn't have at the same address: they say where the hack's own code is.
  const vanillaSites = new Map(blSites(v9));
  const newCalls = blSites(h9).filter(([at, target]) => vanillaSites.get(at) !== target);
  const callsFrom = (start: number, end: number) => newCalls.filter(([at]) => at >= v9.base + start - 2 && at < v9.base + end)
    .map(([at, target]) => `; the hack's BL at 0x${hex(at, 8)} calls 0x${hex(target, 8)}`).join('');
  const callsTo = (start: number, end: number) => newCalls.filter(([, target]) => target >= v9.base + start - 2 && target < v9.base + end)
    .map(([at]) => `; the hack's BL at 0x${hex(at, 8)} calls it`).join('');

  // Each region by what holds it: a pointer that follows overlay 16, a laid-out function, or data a function loads.
  const groups = new Map<string, { at: number; bytes: number; regions: number; what: string; reached: string[] | undefined }>();
  let relocations = 0;
  for (const region of regions) {
    if (explainRegion(v9, h9, evenRegion(region.start, region.end), toHack) !== null) {
      relocations++;
      continue;
    }
    const k = functionIndex(functions, region.start);
    const ref = references.filter((entry) => entry.offset <= region.start).pop();
    let key: string;
    let what: string;
    let reached: string[] | undefined;
    if (k >= 0) {
      const fn = functions[k]!;
      key = `fn:${fn.start}`;
      what = `\`${fn.name}\` (${fn.file ?? 'file not known'}; named by ${fn.evidence})`;
      reached = reach.get(fn.start);
    } else if (region.start < laidOut.start) {
      key = `before:${region.start}`;
      what = `code before the laid-out C (main.c to hardware_window.c, which come before \`unk_02012744.c\`)${callsFrom(region.start, region.end)}`;
    } else if (callsTo(region.start, region.end) !== '') {
      key = `called:${region.start}`;
      what = `bytes after the laid-out C that the hack runs as code${callsTo(region.start, region.end)}`;
    } else if (ref !== undefined) {
      key = `data:${ref.offset}`;
      what = `data from 0x${hex(v9.base + ref.offset, 8)}, loaded by ${ref.readers.map((name) => `\`${name}\``).join(', ')}`;
    } else {
      key = `other:${region.start}`;
      what = 'after the laid-out C, with no loaded address before it';
    }
    const group = groups.get(key) ?? { at: v9.base + region.start, bytes: 0, regions: 0, what, reached };
    group.bytes += region.end - region.start;
    group.regions++;
    groups.set(key, group);
  }
  const reachedGroups = [...groups.values()].filter((group) => group.reached !== undefined);
  const named = functions.filter((fn) => fn.evidence !== 'address').length;
  const expansion = expansionReferences(vanillaRom, hackRom);

  return [
    '### The other binaries',
    '',
    'main.lsf.in links all of the battle C into overlay 16 (main.lsf.in:682). These binaries hold the code around it, or the code it calls:',
    '',
    '| Binary | Holds | Result |',
    '| --- | --- | --- |',
    ...rows,
    `| ARM9 | the code every overlay calls: Pokémon data, moves, items, trainers, the RNG | ${regions.length} changed regions in place `
      + `(both binaries are ${v9.bytes.length.toLocaleString('en-US')} bytes). ${relocations} follow overlay 16's growth; the other `
      + `${regions.length - relocations} fall in ${groups.size} places, below. |`,
    '',
    'Overlay 14\'s changed regions are its script change and BLs into overlay 16 (see "Overlay 14 outside the script").',
    '',
    `The ARM9's C code is laid out between pret's address-named files (\`unk_02012744.c\` to \`unk_0209C390.c\`): `
      + `${functions.length.toLocaleString('en-US')} functions, ${named.toLocaleString('en-US')} of them named. Overlays 14 and 16 `
      + `reach ${reach.size.toLocaleString('en-US')} of them by BL, directly or through the ARM9's own calls. `
      + `${reachedGroups.length === 0 ? 'None of those changed.' : `${reachedGroups.length === 1 ? 'One of the changed places is among them' : `${reachedGroups.length} of the changed places are among them`}: `
        + `${reachedGroups.map((group) => `${group.what.split(' ')[0]}, through ${group.reached!.join(' → ')}`).join('; ')}.`} `
      + 'A changed region after the laid-out C is named by the nearest data address at or before it that a laid-out function loads.',
    '',
    '| ARM9 address | Regions | Bytes | In | Overlays 14 and 16 reach it |',
    '| --- | --- | --- | --- | --- |',
    ...[...groups.values()].map((group) => `| 0x${hex(group.at, 8)} | ${group.regions} | ${group.bytes} | ${group.what} | ${group.reached === undefined ? 'no' : 'yes'} |`),
    '',
    ...itemArchiveLines(v9, h9, references),
    `Words and BLs that point into 0x${hex(EXPANSION.start, 8)}–0x${hex(EXPANSION.end, 8)}, where the hack's ARM9 loads code of its `
      + `own, and that only the hack has: ${expansion.hackOnly.length === 0 ? 'none' : expansion.hackOnly.join('; ')}. Of these, in `
      + `overlays 12 to 16: ${expansion.battle.length === 0 ? 'none' : expansion.battle.join('; ')}.`,
    '',
  ];
}

/**
 * The ARM9 data offsets that a laid-out function loads with `ldr rd, [pc, #imm]`, sorted, each with the functions that
 * load it. Offsets inside the laid-out code are left out.
 */
function dataReferences(image: CodeImage, functions: OverlayFunction[], code: { start: number; end: number }): { offset: number; readers: string[] }[] {
  const readers = new Map<number, Set<string>>();
  for (const fn of functions) {
    for (let at = fn.start; at + 2 <= fn.end; at += 2) {
      const value = image.bytes[at]! | (image.bytes[at + 1]! << 8);
      if ((value & 0xf800) !== 0x4800) continue;
      const word = wordAt(image, ((image.base + at + 4) & ~3) + (value & 0xff) * 4 - image.base);
      const offset = word === null ? -1 : word - image.base;
      if (offset < 0 || offset >= image.bytes.length || (offset >= code.start && offset < code.end)) continue;
      readers.set(offset, new Set([...(readers.get(offset) ?? []), fn.name]));
    }
  }
  return [...readers].map(([offset, names]) => ({ offset, readers: [...names] })).sort((a, b) => a.offset - b.offset);
}

/**
 * sItemArchiveIDs (item.c, read by Item_FileID): which item's dataID, iconID, paletteID or gen3ID differs. The battle
 * loads an item's parameters through its dataID (Item_LoadParam, item.c:144, through Item_FileID, item.c:49).
 */
function itemArchiveLines(v9: CodeImage, h9: CodeImage, references: { offset: number; readers: string[] }[]): string[] {
  const loaded = references.filter((entry) => entry.readers.includes('Item_FileID'));
  if (loaded.length === 0) return [];
  // Item_FileID loads the table's address and each field's (item.c:56–84); the table starts at the lowest.
  const start = loaded[0]!.offset;
  const end = references.find((entry) => entry.offset > start + 8 && !entry.readers.includes('Item_FileID'))?.offset ?? v9.bytes.length;
  const changes: string[] = [];
  for (let at = start; at + 8 <= end; at += 8) {
    ITEM_ARCHIVE_FIELDS.forEach((field, k) => {
      const a = v9.bytes[at + 2 * k]! | (v9.bytes[at + 2 * k + 1]! << 8);
      const b = h9.bytes[at + 2 * k]! | (h9.bytes[at + 2 * k + 1]! << 8);
      if (a !== b) changes.push(`item ${(at - start) / 8} ${field} ${a} → ${b}`);
    });
  }
  const dataChanged = changes.some((change) => change.includes('dataID'));
  return [
    `\`sItemArchiveIDs\` (from 0x${hex(v9.base + start, 8)}, loaded by \`Item_FileID\`; ${(end - start) / 8 | 0} records of 8 bytes): `
      + `${changes.length === 0 ? 'no entry differs' : changes.join('; ')}. `
      + `${dataChanged ? 'A dataID changed, so an item reads other parameters in battle.' : 'No dataID changed, so every item reads the same parameters in battle.'}`,
    '',
  ];
}

/**
 * Thumb BL targets and 4-aligned words in the expansion region, by binary and value: those only the hack has, and of
 * those, the ones in overlays 12 to 16.
 */
function expansionReferences(vanillaRom: Uint8Array, hackRom: Uint8Array): { hackOnly: string[]; battle: string[] } {
  const scan = (rom: Uint8Array) => {
    const found = new Map<string, { text: string; battle: boolean }>();
    const images = [{ name: 'ARM9', id: -1, image: arm9Image(rom) }, ...readOverlayTable(rom).map((entry) => ({ name: `overlay ${entry.id}`, id: entry.id, image: overlayImage(rom, entry.id) }))];
    for (const { name, id, image } of images) {
      const battle = id >= 12 && id <= BATTLE_OVERLAY;
      for (const address of callsInto(image, EXPANSION.start, EXPANSION.end - EXPANSION.start)) {
        found.set(`${name} BL ${address}`, { text: `a BL in ${name} to 0x${hex(address, 8)}`, battle });
      }
      for (let offset = (4 - (image.base % 4)) % 4; offset + 4 <= image.bytes.length; offset += 4) {
        const value = wordAt(image, offset)!;
        if (value >= EXPANSION.start && value < EXPANSION.end) found.set(`${name} word ${value}`, { text: `a word 0x${hex(value, 8)} at ${name} 0x${hex(image.base + offset, 8)}`, battle });
      }
    }
    return found;
  };
  const vanilla = scan(vanillaRom);
  const hackOnly = [...scan(hackRom)].filter(([key]) => !vanilla.has(key)).map(([, entry]) => entry);
  return { hackOnly: hackOnly.map((entry) => entry.text), battle: hackOnly.filter((entry) => entry.battle).map((entry) => entry.text) };
}

/** The objects (`Object src/….c`) of the block `header { … }` in main.lsf.in, in link order. */
function lsfObjects(lsf: string, header: string): string[] {
  const at = lsf.indexOf(`\n${header}\n`);
  if (at < 0) throw new Error(`main.lsf.in has no ${header}`);
  const end = lsf.indexOf('\n}', at);
  return [...lsf.slice(at, end).matchAll(/^\s*Object\s+(src\/\S+\.c)\s*$/gm)].map((match) => match[1]!);
}

/** The lines of a list file, trimmed, without blank ones. */
function listLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/** The 1-based line of `text` that holds `needle`. */
function lineOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`no "${needle}" in the source`);
  return text.slice(0, at).split('\n').length;
}

/** A byte range widened to halfwords, the same in both binaries (an in-place comparison). */
function evenRegion(start: number, end: number): AlignedRegion {
  const from = start & ~1;
  const to = (end + 1) & ~1;
  return { vanillaStart: from, vanillaEnd: to, hackStart: from, hackEnd: to };
}

function overlayImage(rom: Uint8Array, id: number): CodeImage {
  const entry = readOverlayTable(rom).find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`the ROM has no overlay ${id}`);
  return { bytes: readOverlay(rom, id), base: entry.ramAddress };
}

/**
 * The ARM9 binary (ROM header 0x20: offset, 0x28: RAM address, 0x2C: size). It must be stored uncompressed: its module
 * parameters (found by the nitrocode words 0xDEC00621 and 0x2106C0DE at their end) give a compressed end of 0.
 */
function arm9Image(rom: Uint8Array): CodeImage {
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const offset = view.getUint32(0x20, true);
  const image = { bytes: rom.subarray(offset, offset + view.getUint32(0x2c, true)), base: view.getUint32(0x28, true) };
  let params = -1;
  for (let at = 0; at + 8 <= Math.min(image.bytes.length, 0x4000); at += 4) {
    if (wordAt(image, at) === 0xdec00621 && wordAt(image, at + 4) === 0x2106c0de) params = at - 0x1c;
  }
  if (params < 0 || wordAt(image, params + 0x14) !== 0) throw new Error('the ARM9 binary is compressed or has no module parameters');
  return image;
}

function count<T>(values: T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function bytesHex(bytes: Uint8Array, start: number, end: number): string {
  return Array.from(bytes.subarray(start, end), (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

function hex(value: number, digits: number): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

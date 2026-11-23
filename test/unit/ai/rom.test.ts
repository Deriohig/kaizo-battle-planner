import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAiData } from '../../../src/ai/rom/aiData.js';
import { type AiItemRecord, decodeItemRecord, readArm9 } from '../../../src/ai/rom/items.js';
import { decodeTypeChart } from '../../../src/ai/rom/typeChart.js';
import { decodeWeights, WEIGHT_NARCS } from '../../../src/rom/weights.js';
import { MissingDataError } from '../../../src/data/load.js';
import { buildNarc } from '../../fixtures/buildNarc.js';

/** Every field of an item record at zero or false, so a case names only the fields it sets. */
const BLANK: Omit<AiItemRecord, 'id'> = {
  holdEffect: 0, holdParam: 0, flingPower: 0, naturalGiftPower: 0, naturalGiftType: 0,
  hpRestore: false, hpRestored: 0, healSleep: false, healPoison: false, healBurn: false, healFreeze: false,
  healParalysis: false, healConfusion: false, atkStages: 0, defStages: 0, spAtkStages: 0,
  spDefStages: 0, speedStages: 0, accStages: 0, guardSpec: false,
};
const ALL_PARTY_3 = {
  hpRestore: true, hpRestored: 3, healSleep: true, healPoison: true, healBurn: true, healFreeze: true, healParalysis: true,
  healConfusion: true, atkStages: 3, defStages: 3, spAtkStages: 3, spDefStages: 3, speedStages: 3, accStages: 3, guardSpec: true,
};

// A 36-byte ItemData (include/item.h): offset 0x0C is partyUse, 0x0E onwards the ItemPartyParam bitfields.
it.each<[string, Record<number, number>, Partial<AiItemRecord>]>([
  ['the hold effect, its param and fling power', { 0x02: 0x5a, 0x03: 10, 0x06: 30, 0x0c: 1, 0x0e: 0x01 },
    { holdEffect: 0x5a, holdParam: 10, flingPower: 30, healSleep: true }],
  ['the party params', {
    0x07: 80, 0x08: 0xed, 0x09: 0xff, // naturalGiftType is the u16's low five bits (13)
    0x0c: 1, 0x0e: 0b1000_0010, 0x0f: 0x10, 0x10: 0x21, 0x11: 0x43, 0x12: 0x05, 0x13: 0x04, 0x1b: 200,
  }, {
    naturalGiftPower: 80, naturalGiftType: 13, healPoison: true, guardSpec: true, atkStages: 1, defStages: 1, spAtkStages: 2,
    spDefStages: 3, speedStages: 4, accStages: 5, hpRestore: true, hpRestored: 200,
  }],
  // A Poké Ball keeps its ball index in `dummy` (itemproc.c), and Item_Get returns it for every party param.
  ['the dummy byte for every party param without partyUse', { 0x0c: 0, 0x0e: 3 }, ALL_PARTY_3],
])('decodeItemRecord reads %s', (_, bytes, fields) => {
  const record = new Uint8Array(36);
  for (const [offset, value] of Object.entries(bytes)) record[Number(offset)] = value;
  expect(decodeItemRecord(7, record)).toEqual({ ...BLANK, id: 7, ...fields });
});

it('readArm9 decompresses arm9 only when its module params say so', () => {
  /** A ROM whose header points at `arm9`, loaded at 0x02000000, after module params with this compressed static end. */
  const rom = (compressedStaticEnd: number, rest: number[]) => {
    const params = new DataView(new ArrayBuffer(0x24));
    params.setUint32(0x14, compressedStaticEnd, true);
    params.setUint32(0x1c, 0xdec00621, true);
    params.setUint32(0x20, 0x2106c0de, true);
    const arm9 = [...new Uint8Array(params.buffer), ...rest];
    const out = new Uint8Array(0x200 + arm9.length);
    const header = new DataView(out.buffer);
    header.setUint32(0x20, 0x200, true);
    header.setUint32(0x28, 0x02000000, true);
    header.setUint32(0x2c, arm9.length, true);
    out.set(arm9, 0x200);
    return { out, params: [...new Uint8Array(params.buffer)] };
  };
  // Three literals, a reference that repeats them, an 8-byte footer, then two bytes after the block left as they are.
  const block = [0x00, 0x00, 1, 2, 3, 0x10, 0x0e, 0x00, 0x00, 0x08, 0x01, 0x00, 0x00, 0x00];
  const compressed = rom(0x02000000 + 0x24 + block.length, [...block, 0xee, 0xee]);
  expect([...readArm9(compressed.out)]).toEqual([...compressed.params, 0, 0, 1, 2, 3, 0x10, 0x0e, 0, 0, 1, 2, 3, 1, 2, 3, 0xee, 0xee]);
  // An uncompressed arm9 that ends in bytes like a BLZ footer, as the hack's does, is left alone.
  const plain = rom(0, [0x60, 0, 0, 0, 0x20, 0, 0, 0]);
  expect([...readArm9(plain.out)]).toEqual([...plain.params, 0x60, 0, 0, 0, 0x20, 0, 0, 0]);
});

it('decodeTypeChart keeps the Foresight separator', () => {
  expect(decodeTypeChart(Uint8Array.from([0, 5, 5, 0xfe, 0xfe, 0, 0, 7, 0, 0xff, 0xff, 0]))).toEqual([[0, 5, 5], [0xfe, 0xfe, 0], [0, 7, 0]]);
});

describe('decodeWeights', () => {
  /** Little-endian s32s, as the Pokédex height and weight members hold them (pokedex_heightweight.c:120–130). */
  const ints = (values: number[]) => new Uint8Array(Int32Array.from(values).buffer);
  // Member 0 is the heights, member 1 the weights, both by species ID.
  const files = new Map<string, Uint8Array>([
    [WEIGHT_NARCS.form0, buildNarc([ints([1, 7, 10]), ints([69, 69, 7500]), ints([99])])],
    [WEIGHT_NARCS.otherForms, buildNarc([ints([1, 7, 69]), ints([69, 69, 6500]), ints([99])])],
  ]);

  it('reads member 1 of the form-0 NARC, or of the other for any other form', () => {
    expect([undefined, 0, 1, 5].map((form) => decodeWeights(files, form))).toEqual([
      [69, 69, 7500], [69, 69, 7500], [69, 69, 6500], [69, 69, 6500],
    ]);
  });

  it('a missing or malformed table is a RomError', () => {
    expect(() => decodeWeights(new Map())).toThrow(expect.objectContaining({ code: 'MISSING_FILE' }));
    for (const weights of [undefined, Uint8Array.of(1, 2, 3)]) {
      const narc = buildNarc(weights ? [ints([1]), weights] : [ints([1])]);
      expect(() => decodeWeights(new Map([[WEIGHT_NARCS.form0, narc]]))).toThrow(expect.objectContaining({ code: 'BAD_FORMAT' }));
    }
  });
});

it('loadAiData asks for npm run extract on an empty dir or a cache from before the Pokédex weights', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-rom-'));
  try {
    const stale = () => {
      expect(() => loadAiData(dir)).toThrow(MissingDataError);
      expect(() => loadAiData(dir)).toThrow(/npm run extract/);
    };
    stale();
    const old = { scriptWords: [0], flagEntries: [], scriptSha256: '', items: [], typeChart: [] };
    writeFileSync(join(dir, 'trainer-ai.json'), JSON.stringify(old));
    stale();
    writeFileSync(join(dir, 'trainer-ai.json'), JSON.stringify({ ...old, weights: [0, 69], formWeights: [0, 69] }));
    expect(loadAiData(dir).weights).toEqual([0, 69]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

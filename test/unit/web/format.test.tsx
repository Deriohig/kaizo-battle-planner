// The page's words and figures: exact odds as percents, chances, damage ranges, counts, the event stream reader, and the
// labels (who moves first, name lists, trainer names and tags in sentence case, statuses).
import { describe, expect, it } from 'vitest';
import { damageRange, formatChance, formatCount, formatOdds, percentRange } from '../../../web/src/format';
import { nameList, speedOrderText, statusLabel, trainerName, trainerTag } from '../../../web/src/labels';
import { readSse } from '../../../web/src/sse';
import { trainers } from './stubServer';

describe('formatOdds', () => {
  const NEAR_HALF = '123456789012345678901234567890/246913578024691357802469135781';
  it.each([
    // 4 significant digits, half up, trailing zeros stripped
    ['1/16', '6.25%'], ['3/16', '18.75%'], ['102/256', '39.84%'], ['1/3', '33.33%'], ['2/3', '66.67%'], ['3/64', '4.688%'], ['1/8', '12.5%'],
    ['1/200', '0.5%'], ['1/1024', '0.09766%'], ['0/1', '0%'], ['1/1', '100%'], ['2/1', '200%'], [NEAR_HALF, '50%'],
    // never an exponent, never a non-zero value as 0: "< 0.001%" below, judged after the rounding carry
    ['1/18446744073709551616', '< 0.001%'], ['1/1000000', '< 0.001%'], ['1/7000000', '< 0.001%'], ['1/100050', '< 0.001%'],
    ['1/100000000000000000000000000000', '< 0.001%'], ['-1/7000000', '> -0.001%'], ['1/100000', '0.001%'], ['1/100001', '0.001%'],
    ['1/100005', '0.001%'], ['-1/100005', '-0.001%'], ['1/100006', '< 0.001%'],
    // never 100% for a value below 1
    ['99999/100000', '99.99%'], ['19999/20000', '99.99%'], ['999999999999999999999999999999/1000000000000000000000000000000', '99.99%'], ['-99999/100000', '-99.99%'], ['9999/10000', '99.99%'],
  ])('%s is %s, the fraction kept exact', (odds, percent) => {
    expect(formatOdds(odds)).toEqual({ exact: odds, percent });
  });

  it('rejects text that is not "num/den"; formatChance formats a float chance through the same formatter', () => {
    for (const bad of ['', '1', '1/0', '1/16 ', 'a/b', '0.5/1']) expect(() => formatOdds(bad)).toThrow(TypeError);
    expect([0.85, 0.7225, 1, 0, 0.99999].map(formatChance)).toEqual(['85%', '72.25%', '100%', '0%', '99.99%']);
  });

  it('damageRange writes HP then percent, one figure for an equal range, and 0 HP; formatCount groups digits in threes', () => {
    expect(damageRange([22, 27], [44, 54])).toBe('22–27 HP (44–54%)');
    expect(damageRange([40, 40], [40, 40])).toBe('40 HP (40%)');
    expect(damageRange([1, 2], [0.12, 0.14])).toBe('1–2 HP (0.1%)');     // the percents round to one figure
    expect(damageRange([0, 0], [0, 0])).toBe('0 HP');
    expect(percentRange([14.74, 18.03])).toBe('14.7–18%');
    expect([formatCount(1234567), formatCount(593775n), formatCount(12345678901234567890n)]).toEqual(['1,234,567', '593,775', '12,345,678,901,234,567,890']);
  });
});

describe('readSse', () => {
  const text = ': connected\n\nevent: progress\ndata: {"message":"Pokémon Gefährlich 🐉"}\n\nid: 7\ndata: line one\ndata:line two\n\n'
    + 'event: verdict\r\ndata: {"tier":1}\r\n\r\nevent: ignored\n\nevent: last\rdata: é\r\r';
  const streamOf = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } });
  const read = async (chunks: Uint8Array[]) => {
    const events: { event: string; data: string }[] = [];
    await readSse(streamOf(chunks), (e) => events.push(e));
    return events;
  };

  it('parses frames split mid-line and mid-UTF-8 character, in order', async () => {
    const bytes = new TextEncoder().encode(text);
    for (const size of [1, 2, 3, 5, 7, bytes.length]) {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
      expect(await read(chunks), `chunk size ${size}`).toEqual([
        { event: 'progress', data: '{"message":"Pokémon Gefährlich 🐉"}' }, { event: 'message', data: 'line one\nline two' },
        { event: 'verdict', data: '{"tier":1}' }, { event: 'last', data: 'é' },
      ]);
    }
  });

  it('drops a frame cut off before its blank line, and cancels the body and rethrows when onEvent throws', async () => {
    expect(await read([new TextEncoder().encode('data: whole\n\nevent: verdict\ndata: {"tier"')])).toEqual([{ event: 'message', data: 'whole' }]);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: one\n\n')); }, cancel() { cancelled = true; } });
    await expect(readSse(body, () => { throw new Error('bad frame'); })).rejects.toThrow('bad frame');
    expect(cancelled).toBe(true);
  });
});

describe('labels', () => {
  // One wording for who moves first on the plan, the start rows and Matchups.
  it('speedOrderText names who moves first, the first mover\'s Speed first; a tie at one Speed once; a tie or "depends" over two gives his first', () => {
    expect([
      speedOrderText('player', 'Prinplup', 'Miltank', 65, 52), speedOrderText('enemy', 'Prinplup', 'Miltank', 52, 65),
      speedOrderText('tie', 'Prinplup', 'Miltank', 21, 21), speedOrderText('tie', 'Prinplup', 'Miltank', 21, 24), speedOrderText('depends', 'Prinplup', 'Miltank', 50, 41),
    ]).toEqual(['Prinplup moves first · Speed 65 vs 52', 'Miltank moves first · Speed 65 vs 52', 'Speed tie at 21: either moves first', 'Speed tie · Speed 21 vs 24', 'Either may go first · Speed 50 vs 41']);
  });

  it('nameList joins names with commas and "and"; statusLabel reads a known sleep counter and an undrawn sleep as turns so far', () => {
    expect([[], ['A'], ['A', 'B'], ['A', 'B', 'C'], ['Blaze', 'Bench', 'Gloom', 'Oddish']].map(nameList)).toEqual(['', 'A', 'A and B', 'A, B and C', 'Blaze, Bench, Gloom and Oddish']);
    expect(['sleepUndrawn:2', 'sleepUndrawn:1', 'sleep:3'].map(statusLabel)).toEqual(['Asleep (2 turns so far)', 'Asleep (1 turn so far)', 'Asleep (3 turns)']);
  });

  it.each([
    ['Galacticf Venus', 'Galactic Venus ♀'], ['GalacticfTerra', 'Galactic Terra ♀'], ['GalacticfSquad Phobos', 'Galactic Squad Phobos ♀'], ['School KidfChristine', 'School Kid Christine ♀'],
    ['GalacticF Luna', 'Galactic Luna ♀'], ['CyclistFMegan', 'Cyclist Megan ♀'], ['Pkmn BreederF Jennifer', 'Pkmn Breeder Jennifer ♀'], ['SwimmerF  Ledecky', 'Swimmer Ledecky ♀'],
    // any other name as the data has it: an "f" ending a name or word, a glued word, a mark not at the start
    ...['Leader Roark', 'Galactic Mars', 'Hiker Rolf', 'BirdKeeper Kahlil', 'Leader CrasherWake', 'Twins Liv & Liz', 'CYRUS', 'Jeff Smith', 'Chef Bob', 'Leaf Green', 'Hiker GalacticfTerra'].map((n) => [n, n]),
  ])('trainerName(%j) is %j: a class the docs mark female reads plain, with ♀ after the name', (name, shown) => {
    expect(trainerName(name)).toBe(shown);
  });

  const TAGS: [string, string][] = [
    ['Gauntlet Start', 'First of a no-heal run'], ['GAUNTLET START', 'First of a no-heal run'], ['Gauntlet End', 'Last of a no-heal run'], ['GAUNTLET END', 'Last of a no-heal run'],
    ['Gauntlet', 'In a no-heal run'], ['GAUNTLET', 'In a no-heal run'], ['OPTIONAL GAUNTLET with Mira', 'Optional no-heal run with Mira'], ['OPTIONAL GAUNTLET', 'Optional no-heal run'],
    ['GYM TRAINERS ARE A GAUNTLET', 'Gym trainers are a no-heal run'], ['GAUNTLETS AHEAD', 'No-heal run ahead'],
    ['MULTI BATTLE WITH GALACTIC LUNA', 'Multi battle with Galactic Luna'], ['MULTI BATTLE With Galactic Bianca', 'Multi battle with Galactic Bianca'],
    ['MULTI BATTLE with GalacticfDione', 'Multi battle with Galactic Dione ♀'], ['MULTI BATTLE with GalacticfTethys', 'Multi battle with Galactic Tethys ♀'],
    ['MUTLI BATTLE with Galactic Venus', 'Multi battle with Galactic Venus'], ['MULTI BATTLE WITH Galactic Pandora', 'Multi battle with Galactic Pandora'],
    ['B2B With Galactic Terra', 'Back to back with Galactic Terra'], ['TAG BATTLE with Galactic Cupid', 'Tag battle with Galactic Cupid'],
    ['PERMANENT RAIN', 'Permanent rain'], ['FOG', 'Fog'], ['OPTIONAL HAIL', 'Optional hail'], ['OPTIONAL Top Trainer', 'Optional Top Trainer'],
    ['outside of Pastoria Gym', 'Outside of Pastoria Gym'], ['Player chose Chimchar', 'Player chose Chimchar'], ['Also Appears in Room 5', 'Also Appears in Room 5'],
    ['Left of the trees', 'Left of the trees'], ['With Chef Bob', 'With Chef Bob'],
  ];
  it.each(TAGS)('trainerTag(%j) reads %j', (input, output) => {
    expect(trainerTag(input)).toBe(output);
  });

  it('trainerTag never gives a tag in all capitals, nor says gauntlet', () => {
    for (const input of [...TAGS.map(([i]) => i), ...trainers().flatMap((t) => t.tags)]) {
      const out = trainerTag(input);
      expect(out !== out.toUpperCase() || !/[A-Z]{2}/.test(out), `${input} -> ${out}`).toBe(true);
      expect(out, `${input} -> ${out}`).not.toMatch(/gauntlet/i);
    }
  });
});

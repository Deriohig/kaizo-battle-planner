// Real-data check: the type chart `gen4Damage` and the engine walk (`CHART`, transcribed from
// the decompilation's `sTypeMatchupMultipliers`, bl:2399-2517) is the installed hack ROM's own, row by row, in order, including
// the 0xFE marker and the Ghost immunity rows after it that Foresight and Scrappy skip.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractTypeChart } from '../../src/ai/rom/typeChart.js';
import { CHART } from '../../src/calc/gen4Damage.js';
import { needFiles, PK_ROM } from './env.js';

const suite = needFiles('gen4Damage\'s type chart against the hack ROM\'s', { PK_ROM });

describe.skipIf(suite.skip)(suite.title, () => {
  it('has the ROM\'s rows, in the ROM\'s order', () => {
    const rom = extractTypeChart(readFileSync(PK_ROM));
    expect(rom.map((row) => [...row])).toEqual(CHART.map((row) => [...row]));
    expect(rom.findIndex(([attack]) => attack === 0xfe)).toBe(CHART.findIndex(([attack]) => attack === 0xfe));
  });
});

// The request log's usage fields: the device and browser summed up from the User-Agent, the first language tag, the save
// source checked against its list, and the save format. Each is made of fixed words and a version number, or of a value
// checked against a pattern, so nothing a client sends is ever echoed.

import { describe, expect, it } from 'vitest';
import { saveKind } from '../../../src/save/dsv.js';
import { deviceSummary, firstLanguage, saveFormat, saveSource } from '../../../src/server/log.js';

describe('deviceSummary', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.59 Safari/537.36', 'Chrome 142 · Windows · desktop'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.3595.53', 'Edge 142 · Windows · desktop'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0', 'Firefox 145 · Linux · desktop'],
    ['Mozilla/5.0 (Android 15; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0', 'Firefox 145 · Android · phone'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', 'Safari 18 · iPhone · phone'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.7444.77 Mobile/15E148 Safari/604.1', 'Chrome 142 · iPhone · phone'],
    ['Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', 'Safari 18 · iPad · tablet'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', 'Safari 26 · macOS · desktop'],
    ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36', 'Chrome 142 · Android · phone'],
    ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', 'Chrome 142 · Android · tablet'],
    ['Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36', 'Samsung Internet 28 · Android · phone'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0', 'Opera 125 · Windows · desktop'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', 'Chrome 142 · ChromeOS · desktop'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.7444.59 Safari/537.36', 'bot'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'bot'],
    ['curl/8.5.0', 'script'], ['node', 'script'], ['python-requests/2.32.3', 'script'],
    // Nothing, or fixed words for what it cannot read: never the text itself.
    [undefined, null], ['', null], ['   ', null],
    ['Mozilla/5.0 (Lucas-PC; <script>) Weird/1.0', 'other browser · desktop'],
    ['Lucas phone 3000', 'other'],
    [`Mozilla/5.0 (Windows NT 10.0) Chrome/${'9'.repeat(40)}.0`, 'Chrome · Windows · desktop'],
  ])('sums up %s as %s', (ua, summary) => {
    expect(deviceSummary(ua)).toBe(summary);
  });

  it('never echoes a huge User-Agent', () => {
    expect(deviceSummary(`${'x'.repeat(100_000)} Chrome/142.0`)).not.toContain('x');
  });
});

describe('firstLanguage and saveSource', () => {
  it.each<[string | undefined, string | null]>([
    ['es-ES,es;q=0.9,en;q=0.8', 'es-ES'], ['en-GB', 'en-GB'], ['ga;q=0.9, en;q=0.8', 'ga'], [' zh-Hant-TW , zh;q=0.5', 'zh-Hant-TW'],
    // None, *, and anything that is not a language tag.
    ...[undefined, '', '*', '*;q=0.5, en', 'Lucas Ash', 'en_GB', '<b>', `${'a'.repeat(9)}-GB`, 'es-ES-ES-ES-ES-ES']
      .map((header): [string | undefined, null] => [header, null]),
  ])('firstLanguage(%j) is %j', (header, tag) => {
    expect(firstLanguage(header)).toBe(tag);
  });

  it.each<[string | string[] | undefined, string | null]>([
    ...['upload', 'drop', 'connected', 'resend', 'settings'].map((source): [string, string] => [source, source]),
    [['drop', 'upload'], 'drop'],
    ...[undefined, '', 'UPLOAD', ' upload', 'uploaded', 'Platinum Kaizo.dsv', []].map((header): [string | string[] | undefined, null] => [header, null]),
  ])('saveSource(%j) is %j', (header, source) => {
    expect(saveSource(header)).toBe(source);
  });
});

describe('the save format', () => {
  const COOKIE = Uint8Array.from('|-DESMUME SAVE-|', (char) => char.charCodeAt(0));
  const dsv = (footer: number) => {
    const file = new Uint8Array(524_288 + footer);
    file.set(COOKIE, file.length - COOKIE.length);
    return file;
  };

  it.each([
    ['exactly 524,288 bytes', new Uint8Array(524_288), 'raw', 'raw .sav'],
    ['the 122-byte DeSmuME footer', dsv(122), 'dsv', 'DeSmuME .dsv'],
    ['the 16-byte DeSmuME footer', dsv(16), 'dsv', 'DeSmuME .dsv'],
    ['a footer-sized tail without the cookie', new Uint8Array(524_288 + 122), null, 'other'],
    ['1000 bytes', new Uint8Array(1000), null, 'other'],
    ['no bytes', new Uint8Array(0), null, 'other'],
  ])('%s: saveKind %s, saveFormat %s', (_, file, kind, format) => {
    expect([saveKind(file), saveFormat(file)]).toEqual([kind, format]);
  });
});

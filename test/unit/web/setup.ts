import * as matchers from '@testing-library/jest-dom/matchers';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import { FakeEventSource } from './stubServer';

// jest-dom 7.0.1's `@testing-library/jest-dom/vitest` entry augments vitest's old `Assertion<T>`, which clashes with
// vitest 5's `Assertion<R, T>` (TS2428). So the matchers are registered here and typed on vitest 5's `Matchers<R, T>`.
declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<unknown, R> {}
}

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

// jsdom has no EventSource, and the page opens one for live box updates. A test that renders the page without calling
// `stubEventSource()` (or a page effect that outlives its test under full-suite load) would otherwise throw
// "EventSource is not defined". Assigned directly, not with vi.stubGlobal, so `vi.unstubAllGlobals()` restores this
// default rather than removing it; tests that need control still call `stubEventSource()`.
if (!('EventSource' in globalThis)) {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
}

// A value or what computing it threw, kept to be thrown again later: how the read's source keeps a failed read and the
// composer a failed base view (and each field its build meets after the memory's reads), so the same error object comes
// back each time.

/** A value, or what computing it threw. */
export type Caught<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** What `compute` returns, or what it throws, as a Caught. */
export function attempt<T>(compute: () => T): Caught<T> {
  try {
    return { ok: true, value: compute() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The value, or the same throw again. */
export function settled<T>(caught: Caught<T>): T {
  if (!caught.ok) throw caught.error;
  return caught.value;
}

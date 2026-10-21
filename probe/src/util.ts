// Small helpers shared by the probe modules. Everything here must be safe to
// call from any listener: nothing may ever throw into the host app.

/** Wrap a function so it can never throw (errors are swallowed). */
export function safe<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined {
  return (...args: A) => {
    try {
      return fn(...args);
    } catch {
      return undefined;
    }
  };
}

export const now = () => Date.now();

/** Current app location as pathname+search+hash. */
export function currentPath(): string {
  try {
    const l = window.location;
    return l.pathname + l.search + l.hash;
  } catch {
    return '';
  }
}

export function collapse(s: string | null | undefined, max = 120): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Strip query + hash (they often carry tokens / PII). */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    return u.origin === window.location.origin ? u.pathname : u.origin + u.pathname;
  } catch {
    return String(url).split(/[?#]/)[0];
  }
}

export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  return (...args: A) => {
    lastArgs = args;
    const elapsed = now() - last;
    if (elapsed >= ms) {
      last = now();
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = undefined;
        last = now();
        if (lastArgs) fn(...lastArgs);
      }, ms - elapsed);
    }
  };
}

/** JSON-safe, size-limited copy of arbitrary app data (for ThinkAloud.track). */
export function sanitize(data: unknown, maxLen = 4000): Record<string, unknown> {
  if (data == null) return {};
  try {
    const s = JSON.stringify(data);
    if (!s) return {};
    if (s.length > maxLen) return { truncated: true, preview: s.slice(0, maxLen) };
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { unserializable: true };
  }
}

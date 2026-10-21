// Optional ThinkAloud custom events (no-op when the probe is not present).
export function track(name, data) {
  try {
    window.ThinkAloud?.track(name, data);
  } catch {
    /* ignore */
  }
}

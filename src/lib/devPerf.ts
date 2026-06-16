type PerfMeta = Record<string, number | string | boolean | null | undefined>;

function isPerfEnabled() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem("margent:perf") === "1";
  } catch {
    return false;
  }
}

export function measurePerf<T>(label: string, fn: () => T, meta?: PerfMeta): T {
  if (!isPerfEnabled()) {
    return fn();
  }

  const start = performance.now();

  try {
    return fn();
  } finally {
    logPerf(label, performance.now() - start, meta);
  }
}

export async function measurePerfAsync<T>(
  label: string,
  fn: () => Promise<T>,
  meta?: PerfMeta,
): Promise<T> {
  if (!isPerfEnabled()) {
    return fn();
  }

  const start = performance.now();

  try {
    return await fn();
  } finally {
    logPerf(label, performance.now() - start, meta);
  }
}

function logPerf(label: string, durationMs: number, meta?: PerfMeta) {
  window.dispatchEvent(
    new CustomEvent("margent:perf", {
      detail: {
        durationMs,
        label,
        meta: meta ?? null,
      },
    }),
  );
}

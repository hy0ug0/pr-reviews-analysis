// Maps `items` with at most `limit` mappers running at once, keeping their order.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results: Array<R | undefined> = Array.from({ length: items.length });
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results.map((result, index) => {
    if (result === undefined) {
      throw new Error(`Concurrency mapping failed at index ${index}.`);
    }
    return result;
  });
}

export interface Semaphore {
  // Runs `task` once a slot is free and frees it when the task settles, whatever the outcome.
  // Waiting tasks start in the order they asked.
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`A semaphore needs a whole number of slots of at least 1, got ${limit}.`);
  }
  let inUse = 0;
  const waiting: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (inUse < limit) {
      inUse++;
      return;
    }
    // The releasing task hands its slot over, so inUse stays the same.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else inUse--;
  }

  return {
    async run(task) {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

// Waits for promises already running side by side and resolves with their results in order.
// Rejects with the first rejection in that order, once every promise before it has resolved:
// the error a loop running them one after the other would have stopped on. The other
// rejections are handled here, so none goes unhandled.
export async function allInOrder<T>(promises: Array<Promise<T>>): Promise<T[]> {
  for (const promise of promises) promise.catch(() => {});
  const results: T[] = [];
  for (const promise of promises) results.push(await promise);
  return results;
}

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

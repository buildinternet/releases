/**
 * Run an async function over an array of items with bounded concurrency.
 * Workers share a FIFO queue; results are returned in completion order, not
 * input order. Callers that need stable ordering should pair by key.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      // oxlint-disable-next-line no-await-in-loop -- bounded-concurrency worker: sequential within each worker slot is intentional
      results.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return results;
}

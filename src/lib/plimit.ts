/**
 * Tiny in-memory concurrency limiter with zero dependencies.
 *
 * Usage:
 *   const limit = pLimit(5);
 *   await Promise.all(items.map(item => limit(() => processItem(item))));
 */
export function pLimit(concurrency: number) {
  if (concurrency < 1) concurrency = 1;
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const task = queue.shift()!;
    task();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

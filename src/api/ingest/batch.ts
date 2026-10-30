// Groups items as they arrive. It is pull-based: the next item is only requested when
// the consumer is ready for it, so a slow analytics sender naturally holds enrichment
// back instead of a growing queue of enriched records building up in memory.
export async function* batch<T>(source: AsyncIterable<T> | Iterable<T>, size: number): AsyncGenerator<T[]> {
  let current: T[] = [];
  for await (const item of source) {
    current.push(item);
    if (current.length === size) {
      yield current;
      current = [];
    }
  }
  if (current.length > 0) yield current;
}

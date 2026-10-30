import { describe, expect, it } from "vitest";
import { batch } from "./batch.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("batch", () => {
  it.each([
    ["no items", 0, 20, []],
    ["fewer items than the size", 3, 20, [3]],
    ["exactly one batch", 20, 20, [20]],
    ["one over a batch", 21, 20, [20, 1]],
    ["an exact multiple", 40, 20, [20, 20]],
    ["a remainder", 45, 20, [20, 20, 5]],
    ["a size of one", 3, 1, [1, 1, 1]],
  ])("handles %s", async (_name, count, size, expectedSizes) => {
    const batches = await collect(batch(range(count), size));

    expect(batches.map((b) => b.length)).toEqual(expectedSizes);
    expect(batches.flat()).toEqual(range(count));
  });

  it("accepts an async source", async () => {
    async function* source() {
      yield "a";
      yield "b";
      yield "c";
    }

    expect(await collect(batch(source(), 2))).toEqual([["a", "b"], ["c"]]);
  });

  it("does not pull more items than the consumer has asked for", async () => {
    let pulled = 0;
    async function* source() {
      for (const item of range(100)) {
        pulled++;
        yield item;
      }
    }

    const batches = batch(source(), 20);
    await batches.next();

    expect(pulled).toBe(20);
    await batches.return(undefined);
  });
});

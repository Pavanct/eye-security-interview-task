import { describe, expect, it } from "vitest";
import { chunk } from "./chunk.js";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("chunk", () => {
  it.each([
    ["no items", 0, 20, []],
    ["fewer items than the size", 3, 20, [3]],
    ["exactly one chunk", 20, 20, [20]],
    ["one over a chunk", 21, 20, [20, 1]],
    ["an exact multiple", 40, 20, [20, 20]],
    ["a remainder", 45, 20, [20, 20, 5]],
    ["a size of one", 3, 1, [1, 1, 1]],
  ])("handles %s", (_name, count, size, expectedSizes) => {
    const chunks = chunk(range(count), size);

    expect(chunks.map((c) => c.length)).toEqual(expectedSizes);
    expect(chunks.flat()).toEqual(range(count));
  });
});

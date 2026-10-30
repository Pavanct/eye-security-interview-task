import { describe, expect, it } from "vitest";
import { parseApiUrl } from "./api-url.js";

describe("parseApiUrl", () => {
  it.each(["http://localhost:3000", "http://localhost:3000/", "https://ingest.example.com"])("accepts %s", (url) => {
    expect(parseApiUrl(url)).toBe(url);
  });

  it.each([
    ["not a URL", "nope", "http or https"],
    ["another protocol", "ftp://localhost", "http or https"],
    ["a path", "http://localhost:3000/foo", "path or query"],
    ["a query", "http://localhost:3000?x=1", "path or query"],
  ])("refuses %s", (_name, url, message) => {
    expect(() => parseApiUrl(url)).toThrow(message);
  });
});

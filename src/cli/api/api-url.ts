import { InvalidArgumentError } from "commander";

// A path or query would be silently dropped when /ingest is added, so the request could
// go somewhere the user didn't intend. Better to refuse it.
export function parseApiUrl(value: string): string {
  const url = URL.parse(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new InvalidArgumentError("must be an http or https URL, like http://localhost:3000");
  }
  if (url.pathname !== "/" || url.search !== "") {
    throw new InvalidArgumentError("must not include a path or query, like http://localhost:3000");
  }
  return value;
}

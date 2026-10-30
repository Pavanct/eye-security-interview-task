import { streamEventSchema, type RawRecord, type StreamEvent } from "../../shared/wire.js";

export type IngestOutcome =
  | { kind: "finished" }
  | { kind: "stopped"; reason: string }
  | { kind: "http_error"; status: number; message: string }
  | { kind: "unreachable" }
  | { kind: "stream_ended" }
  | { kind: "timed_out" }
  | { kind: "bad_response" }
  | { kind: "interrupted" };

export interface IngestDeps {
  fetch: typeof fetch;
  signal: AbortSignal;
  // The server sends heartbeats, so this much silence means it has gone.
  idleTimeoutMs: number;
}

// A network chunk can end anywhere, including halfway through a line or a multi-byte
// character, so bytes are buffered until a full line has arrived.
export async function* readLines(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line !== "") yield line;
    }
  }

  buffer += decoder.decode();
  if (buffer !== "") yield buffer;
}

function parseEvent(line: string): StreamEvent | undefined {
  try {
    const parsed = streamEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return "the API returned an error";
}

// Never throws: each way a run can end is a value, and the caller has to report it.
export async function postIngest(
  apiUrl: string,
  records: RawRecord[],
  onEvent: (event: StreamEvent) => void,
  { fetch, signal, idleTimeoutMs }: IngestDeps,
): Promise<IngestOutcome> {
  const idle = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const resetIdleTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), idleTimeoutMs);
  };

  let connected = false;
  let outcome: IngestOutcome = { kind: "stream_ended" };

  try {
    resetIdleTimer();
    const response = await fetch(new URL("/ingest", apiUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
      signal: AbortSignal.any([signal, idle.signal]),
    });
    connected = true;

    if (!response.ok) {
      return { kind: "http_error", status: response.status, message: await errorMessage(response) };
    }
    if (!response.body) return { kind: "bad_response" };

    for await (const line of readLines(response.body)) {
      resetIdleTimer();
      const event = parseEvent(line);
      if (!event) return { kind: "bad_response" };

      onEvent(event);
      if (event.type === "summary") outcome = { kind: "finished" };
      if (event.type === "run_failed") outcome = { kind: "stopped", reason: event.reason };
    }
    return outcome;
  } catch {
    // Checked first: a final event that has arrived still counts, whatever happens afterwards.
    if (outcome.kind !== "stream_ended") return outcome;
    if (signal.aborted) return { kind: "interrupted" };
    if (idle.signal.aborted) return { kind: "timed_out" };
    return connected ? { kind: "stream_ended" } : { kind: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

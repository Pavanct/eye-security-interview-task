export interface UpstreamHttp {
  baseUrl: string;
  apiKey: string;
  fetch: typeof fetch;
}

export type HttpOutcome =
  // body is undefined when it isn't JSON: the real 429 comes back as an HTML page.
  | { kind: "response"; status: number; body: unknown; retryAfterMs?: number }
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "aborted" };

// Never throws: every way a call can fail is a value the clients have to handle.
export async function postJson(
  http: UpstreamHttp,
  path: string,
  payload: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpOutcome> {
  const timeout = AbortSignal.timeout(timeoutMs);

  try {
    const response = await http.fetch(new URL(path, http.baseUrl), {
      method: "POST",
      headers: { Authorization: http.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      // A redirect isn't part of the contract, and following one could send our data elsewhere.
      redirect: "error",
    });

    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    return {
      kind: "response",
      status: response.status,
      body: await parseBody(response),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  } catch {
    if (signal?.aborted) return { kind: "aborted" };
    if (timeout.aborted) return { kind: "timeout" };
    return { kind: "network" };
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Only the seconds form. The service uses it, and the date form is ignored rather
// than guessed at, which leaves the limiter's own interval in charge.
function parseRetryAfter(value: string | null): number | undefined {
  return value !== null && /^\d+$/.test(value) ? Number(value) * 1000 : undefined;
}

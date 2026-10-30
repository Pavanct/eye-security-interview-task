import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { pino } from "pino";
import { loadConfig } from "../../src/api/config.js";
import { createService } from "../../src/api/service.js";
import type { FilterFlags } from "../../src/cli/filter/filter.js";
import { runIngest } from "../../src/cli/run.js";

export const API_KEY = "test-key";
const INTERVAL_MS = 30;
// Half our interval, so network jitter can't fail a test, while sending without the
// limiter would still get a 429.
const UPSTREAM_WINDOW_MS = 15;

const TECHNIQUES: Record<string, string> = {
  contentinjection: "T1659",
  drivebycompromise: "T1189",
  exploitpublicfacingapplication: "T1190",
  externalremoteservices: "T1133",
  hardwareadditions: "T1200",
  phishing: "T1566",
  replicationthroughremovablemedia: "T1091",
  supplychaincompromise: "T1195",
  trustedrelationship: "T1199",
  validaccounts: "T1078",
};

export interface LogLineBody {
  id: number;
  asset: string;
  ip: string;
  category: string;
}

export interface EventBody extends Omit<LogLineBody, "category"> {
  category: string;
  asn: string;
  correlationId: number;
}

export type Reply = { status: number; body?: string; headers?: Record<string, string> };

export interface Controls {
  dropApiConnections: () => void;
  shutdownApi: () => void;
}

// Overrides for the fake services. Returning undefined falls through to the normal
// behaviour, which follows what the real service was seen to do.
export interface Behaviour {
  enrichment?: (body: LogLineBody, attempt: number, controls: Controls) => Reply | undefined;
  analytics?: (events: EventBody[], call: number, controls: Controls) => Reply | undefined;
}

const LIMITED: Reply = {
  status: 429,
  body: "<!doctype html><html>Rate limit, remain your calm</html>",
  headers: { "retry-after": "1", "content-type": "text/html" },
};

interface Upstream {
  enrichmentCalls: LogLineBody[];
  analyticsCalls: number;
  analyticsAt: number[];
  rateLimited: number;
  unauthorized: number;
  stored: EventBody[];
  authHeaders: Set<string | undefined>;
  bodyKeys: Set<string>;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text) as T;
}

function send(res: ServerResponse, { status, body = "", headers = {} }: Reply): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
}

function fakeUpstream(behaviour: Behaviour, controls: Controls) {
  const state: Upstream = {
    enrichmentCalls: [],
    analyticsCalls: 0,
    analyticsAt: [],
    rateLimited: 0,
    unauthorized: 0,
    stored: [],
    authHeaders: new Set(),
    bodyKeys: new Set(),
  };
  const attempts = new Map<number, number>();
  let lastAnalyticsAt = -Infinity;

  const server = createServer(async (req, res) => {
    state.authHeaders.add(req.headers.authorization);
    if (req.headers.authorization !== API_KEY) {
      state.unauthorized++;
      return send(res, { status: 401, body: JSON.stringify({ error: "request error", message: "api key invalid" }) });
    }

    if (req.url === "/enrichment") {
      const body = await readJson<LogLineBody>(req);
      for (const key of Object.keys(body)) state.bodyKeys.add(key);
      state.enrichmentCalls.push(body);
      const attempt = (attempts.get(body.id) ?? 0) + 1;
      attempts.set(body.id, attempt);

      const override = behaviour.enrichment?.(body, attempt, controls);
      if (override) return send(res, override);

      const category = TECHNIQUES[body.category];
      if (!category) return send(res, { status: 400, body: JSON.stringify({ error: "provided category is unknown" }) });
      return send(res, {
        status: 200,
        body: JSON.stringify({ asn: "AS8291", category, correlationId: body.id }),
      });
    }

    const events = await readJson<EventBody[]>(req);
    const now = performance.now();
    state.analyticsCalls++;

    const override = behaviour.analytics?.(events, state.analyticsCalls, controls);
    if (override) return send(res, override);

    if (now - lastAnalyticsAt < UPSTREAM_WINDOW_MS) {
      state.rateLimited++;
      return send(res, LIMITED);
    }
    lastAnalyticsAt = now;
    state.analyticsAt.push(now);

    if (events.length < 1 || events.length > 20) {
      return send(res, { status: 400, body: JSON.stringify({ error: "input data should have between 1-20 items" }) });
    }
    state.stored.push(...events);
    return send(res, { status: 200, body: JSON.stringify({ status: "ok", itemsIngested: events.length }) });
  });

  return { server, state };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}

export const HEADER = "id;asset_name;ip;created_utc;source;category";

export const csvRows = (count: number) =>
  Array.from({ length: count }, (_, i) => `${i + 1};server_a;1.2.3.4;27/02/2024 00:00;defender;phising`);

export interface FlowOptions {
  csv: string;
  behaviour?: Behaviour;
  filter?: Partial<FilterFlags>;
  apiKey?: string;
}

// Real CLI code, real API over real HTTP, real clients and rate limiter. Only the two
// external services are fake, and retry and rate-limit timings are shortened.
export async function runFlow({ csv, behaviour = {}, filter = {}, apiKey = API_KEY }: FlowOptions) {
  const dir = await mkdtemp(join(tmpdir(), "ingest-flow-"));
  const shutdown = new AbortController();
  let api: Server | undefined;

  const controls: Controls = {
    dropApiConnections: () => api?.closeAllConnections(),
    shutdownApi: () => shutdown.abort(),
  };
  const { server: upstreamServer, state: upstream } = fakeUpstream(behaviour, controls);
  const upstreamPort = await listen(upstreamServer);

  const config = loadConfig({
    UPSTREAM_API_KEY: apiKey,
    UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    ANALYTICS_INTERVAL_MS: String(INTERVAL_MS),
    RETRY_BASE_DELAY_MS: "1",
    RETRY_MAX_DELAY_MS: "2",
  });
  const app = createService(config, shutdown.signal, pino({ level: "silent" }));
  api = serve({ fetch: app.fetch, port: 0 }) as Server;
  await new Promise((resolve) => api?.once("listening", resolve));
  const { port } = api.address() as AddressInfo;

  try {
    const file = join(dir, "input.csv");
    const rejectsPath = join(dir, "input.rejects.csv");
    await writeFile(file, csv);
    const output: string[] = [];

    const exitCode = await runIngest(
      {
        file,
        apiUrl: `http://127.0.0.1:${port}`,
        rejectsPath,
        filter: { source: [], asset: [], category: [], ...filter },
      },
      {
        fetch: globalThis.fetch,
        signal: new AbortController().signal,
        idleTimeoutMs: 5000,
        print: (message) => output.push(message),
      },
    );

    return {
      exitCode,
      output: output.join("\n"),
      rejects: existsSync(rejectsPath) ? await readFile(rejectsPath, "utf8") : undefined,
      upstream,
    };
  } finally {
    api.closeAllConnections();
    api.close();
    upstreamServer.closeAllConnections();
    upstreamServer.close();
    await rm(dir, { recursive: true, force: true });
  }
}

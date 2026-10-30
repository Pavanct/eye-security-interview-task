import { serve } from "@hono/node-server";
import { pino } from "pino";
import { type Config, loadConfig } from "./config.js";
import { createService } from "./service.js";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : "Invalid configuration");
  process.exit(1);
}

const logger = pino({ level: config.logLevel });
const shutdown = new AbortController();
const app = createService(config, shutdown.signal, logger);

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  logger.info({ port }, "api listening");
});

// Stop taking requests and let running runs finish their current batch and report why they
// stopped. close() only calls back once their streams have ended. The timer is the backstop
// if a run is stuck: the client then sees a stream with no final event, which it reports
// as an incomplete run.
function stop(signal: NodeJS.Signals): void {
  if (shutdown.signal.aborted) return;
  logger.info({ signal }, "shutting down");
  shutdown.abort();

  server.close(() => {
    logger.info("shutdown complete");
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("shutdown timed out, exiting with runs still active");
    process.exit(1);
  }, config.shutdownGraceMs).unref();
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

const { config, validateCoreConfig } = require("./config");
const { BotSessionManager } = require("./runtime/session-manager");
const { startControlServer } = require("./api/control-server");
const { log, warn, error } = require("./logger");

async function main() {
  const missing = validateCoreConfig(config);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  const manager = new BotSessionManager({ config });
  const controlApi = await startControlServer({
    port: config.controlApiPort,
    host: config.controlApiHost,
    authToken: config.controlApiToken,
    allowAnyMeetUrl: config.allowAnyMeetUrl,
    manager
  });

  if (!config.controlApiToken) {
    warn(
      "API",
      "CONTROL_API_TOKEN is not set. API is unauthenticated; keep it bound to a trusted host only."
    );
  }

  const shutdown = async (signal) => {
    log("SYSTEM", `Received ${signal}. Stopping API and active session...`);
    await manager.stopSession({ reason: `signal:${signal}` });
    await controlApi.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err) => {
  error("FATAL", err?.stack || err?.message || String(err));
  process.exit(1);
});

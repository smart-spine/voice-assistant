const { config, validateSessionConfig } = require("./config");
const { BotSessionManager } = require("./runtime/session-manager");
const { log, error } = require("./logger");

async function main() {
  const missing = validateSessionConfig(config, { requireMeetUrl: true });
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  const manager = new BotSessionManager({ config });

  const shutdown = async (signal) => {
    log("SYSTEM", `Received ${signal}. Stopping active session...`);
    await manager.stopSession({ reason: `signal:${signal}` });
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await manager.startSession({ meetUrl: config.meetUrl });
}

main().catch((err) => {
  error("FATAL", err?.stack || err?.message || String(err));
  process.exit(1);
});

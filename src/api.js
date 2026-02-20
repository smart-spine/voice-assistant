const { BotSessionManager } = require("./runtime/session-manager");
const { startControlServer } = require("./api/control-server");
const { ConfigService } = require("./config-service");
const { log, warn, error } = require("./logger");

function loadConfigModule() {
  const modulePath = require.resolve("./config");
  delete require.cache[modulePath];
  return require("./config");
}

async function main() {
  const boot = loadConfigModule();
  const bootConfig = boot.config;

  let manager = null;
  const configService = new ConfigService({
    encryptionKey: bootConfig.configEncryptionKey,
    overridesFile: bootConfig.configOverridesFile,
    auditFile: bootConfig.configAuditFile,
    backupsDir: bootConfig.configBackupsDir,
    onReload: async ({ changedKeys = [] } = {}) => {
      const loaded = loadConfigModule();
      if (manager) {
        manager.updateConfig(loaded.config);
      }
      return {
        changedKeys,
        appliedAt: new Date().toISOString()
      };
    }
  });

  const loaded = loadConfigModule();
  const config = loaded.config;
  const missing = loaded.validateCoreConfig(config);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  manager = new BotSessionManager({ config });
  const controlApi = await startControlServer({
    port: config.controlApiPort,
    host: config.controlApiHost,
    authToken: config.controlApiToken,
    allowAnyMeetUrl: config.allowAnyMeetUrl,
    corsAllowlist: config.controlApiCorsAllowlist,
    manager,
    configService,
    getRuntimeConfig: () => manager.getConfig()
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

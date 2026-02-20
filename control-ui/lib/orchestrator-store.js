import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { getSystemConfig } from "./system-config";

function nowIso() {
  return new Date().toISOString();
}

function safeTrim(value) {
  return String(value || "").trim();
}

class OrchestratorStore {
  constructor() {
    const config = getSystemConfig();

    this.logs = [];
    this.nextLogId = 1;
    this.maxLogs = config.logBufferLimit;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);

    this.apiProcess = null;
    this.apiState = {
      enabled: config.managedApiEnabled,
      status: "stopped",
      pid: null,
      startedAt: null,
      command: config.managedApiCommand,
      cwd: config.managedApiCwd,
      lastExitCode: null,
      lastExitSignal: null,
      lastError: null
    };

    this.operationChain = Promise.resolve();
    this.appendLog({
      source: "system",
      level: "info",
      message: "Control UI orchestration initialized."
    });
  }

  runExclusive(task) {
    const nextTask = this.operationChain.then(task, task);
    this.operationChain = nextTask.catch(() => {});
    return nextTask;
  }

  appendLog({ source = "system", level = "info", message }) {
    const text = safeTrim(message);
    if (!text) {
      return null;
    }

    const entry = {
      id: this.nextLogId++,
      ts: nowIso(),
      source,
      level,
      message: text
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.splice(0, this.logs.length - this.maxLogs);
    }

    this.emitter.emit("log", entry);
    return entry;
  }

  getLogs(limit = 300) {
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 300));
    if (this.logs.length <= safeLimit) {
      return [...this.logs];
    }
    return this.logs.slice(this.logs.length - safeLimit);
  }

  subscribe(onLog) {
    this.emitter.on("log", onLog);
    return () => {
      this.emitter.off("log", onLog);
    };
  }

  getApiState() {
    const config = getSystemConfig();
    this.maxLogs = config.logBufferLimit;

    const startedAtMs = this.apiState.startedAt
      ? new Date(this.apiState.startedAt).getTime()
      : null;
    const uptimeSeconds =
      startedAtMs && Number.isFinite(startedAtMs)
        ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
        : 0;

    return {
      ...this.apiState,
      enabled: config.managedApiEnabled,
      uptimeSeconds
    };
  }

  attachProcessStream(stream, { source, level }) {
    if (!stream) {
      return;
    }

    let carry = "";
    stream.setEncoding("utf8");

    stream.on("data", (chunk) => {
      carry += String(chunk || "");
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() || "";

      for (const line of lines) {
        this.appendLog({ source, level, message: line });
      }
    });

    stream.on("end", () => {
      const tail = safeTrim(carry);
      if (tail) {
        this.appendLog({ source, level, message: tail });
      }
    });
  }

  startManagedApi() {
    return this.runExclusive(async () => {
      const config = getSystemConfig();

      this.apiState = {
        ...this.apiState,
        enabled: config.managedApiEnabled,
        command: config.managedApiCommand,
        cwd: config.managedApiCwd
      };

      if (!config.managedApiEnabled) {
        throw new Error(
          "Managed API mode is disabled. Set MANAGED_API_ENABLED=true to control API process from UI."
        );
      }

      if (this.apiProcess && this.apiState.status !== "stopped") {
        this.appendLog({
          source: "system",
          level: "warn",
          message: "API process is already running."
        });
        return this.getApiState();
      }

      const child = spawn("bash", ["-lc", config.managedApiCommand], {
        cwd: config.managedApiCwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"]
      });

      this.apiProcess = child;
      this.apiState = {
        ...this.apiState,
        status: "starting",
        pid: child.pid || null,
        startedAt: nowIso(),
        command: config.managedApiCommand,
        cwd: config.managedApiCwd,
        lastExitCode: null,
        lastExitSignal: null,
        lastError: null
      };

      this.appendLog({
        source: "system",
        level: "info",
        message: `Starting managed API via: ${config.managedApiCommand}`
      });

      this.attachProcessStream(child.stdout, {
        source: "api-stdout",
        level: "info"
      });
      this.attachProcessStream(child.stderr, {
        source: "api-stderr",
        level: "error"
      });

      child.on("spawn", () => {
        this.apiState = {
          ...this.apiState,
          status: "running"
        };
        this.appendLog({
          source: "system",
          level: "info",
          message: `Managed API process started (pid=${child.pid || "n/a"}).`
        });
      });

      child.on("error", (err) => {
        const details = safeTrim(err?.stack || err?.message || String(err));
        this.apiState = {
          ...this.apiState,
          status: "stopped",
          pid: null,
          lastError: details
        };
        this.appendLog({
          source: "system",
          level: "error",
          message: `Managed API process failed: ${details}`
        });
      });

      child.on("exit", (code, signal) => {
        this.apiProcess = null;
        this.apiState = {
          ...this.apiState,
          status: "stopped",
          pid: null,
          lastExitCode: code,
          lastExitSignal: signal,
          lastError: null
        };

        const suffix =
          signal && signal !== "null"
            ? `signal=${signal}`
            : `code=${code === null ? "null" : String(code)}`;
        this.appendLog({
          source: "system",
          level: code === 0 || signal === "SIGTERM" ? "warn" : "error",
          message: `Managed API process exited (${suffix}).`
        });
      });

      return this.getApiState();
    });
  }

  stopManagedApi() {
    return this.runExclusive(async () => {
      const config = getSystemConfig();
      if (!this.apiProcess || this.apiState.status === "stopped") {
        this.appendLog({
          source: "system",
          level: "warn",
          message: "Managed API process is already stopped."
        });
        return this.getApiState();
      }

      const processToStop = this.apiProcess;
      this.apiState = {
        ...this.apiState,
        status: "stopping"
      };

      this.appendLog({
        source: "system",
        level: "info",
        message: "Stopping managed API process (SIGTERM)..."
      });

      await new Promise((resolve) => {
        const onExit = () => {
          clearTimeout(forceKillTimer);
          resolve();
        };

        const forceKillTimer = setTimeout(() => {
          if (!this.apiProcess || processToStop.killed) {
            return;
          }
          this.appendLog({
            source: "system",
            level: "warn",
            message: "API did not stop in time. Escalating to SIGKILL."
          });
          try {
            processToStop.kill("SIGKILL");
          } catch (err) {
            this.appendLog({
              source: "system",
              level: "error",
              message: `Failed to send SIGKILL: ${safeTrim(
                err?.message || String(err)
              )}`
            });
          }
        }, config.managedApiStopTimeoutMs);

        processToStop.once("exit", onExit);

        try {
          processToStop.kill("SIGTERM");
        } catch (err) {
          clearTimeout(forceKillTimer);
          this.appendLog({
            source: "system",
            level: "error",
            message: `Failed to stop API process: ${safeTrim(
              err?.message || String(err)
            )}`
          });
          resolve();
        }
      });

      return this.getApiState();
    });
  }
}

const storeKey = Symbol.for("voice-assistant.control-ui.orchestrator-store");

if (!globalThis[storeKey]) {
  globalThis[storeKey] = new OrchestratorStore();
}

export function getOrchestratorStore() {
  return globalThis[storeKey];
}

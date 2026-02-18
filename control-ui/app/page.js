"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const INITIAL_FORM = {
  meetUrl: "",
  clientName: "",
  clientCompany: "",
  clientNotes: "",
  forceRestart: false
};

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    return "-";
  }

  return time.toLocaleString();
}

function formatDuration(totalSeconds) {
  const value = Number(totalSeconds) || 0;
  if (value <= 0) {
    return "0s";
  }

  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;

  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

function statusTone(value) {
  const normalized = String(value || "").toLowerCase();

  if (["running", "ok", "idle", "stopped"].includes(normalized)) {
    return "ok";
  }

  if (["starting", "stopping"].includes(normalized)) {
    return "warn";
  }

  return "error";
}

async function fetchJson(url, init) {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    throw new Error(
      payload?.error || `Request failed with HTTP ${response.status}.`
    );
  }

  return payload;
}

export default function HomePage() {
  const [systemState, setSystemState] = useState(null);
  const [logs, setLogs] = useState([]);
  const [form, setForm] = useState(INITIAL_FORM);
  const [busy, setBusy] = useState({
    apiStart: false,
    apiStop: false,
    botStart: false,
    botStop: false,
    refreshing: false
  });
  const [notice, setNotice] = useState({ type: "info", text: "" });
  const [autoScroll, setAutoScroll] = useState(true);
  const logsViewportRef = useRef(null);

  const managedApi = systemState?.managedApi;
  const controlApi = systemState?.controlApi;
  const botStatus = controlApi?.bot?.data;

  const pushNotice = useCallback((type, text) => {
    setNotice({ type, text });
  }, []);

  const loadState = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setBusy((prev) => ({ ...prev, refreshing: true }));
    }

    try {
      const payload = await fetchJson("/api/system/state");
      setSystemState(payload.data);
      if (!silent) {
        pushNotice("success", "State synchronized.");
      }
    } catch (err) {
      pushNotice("error", err.message || "Failed to fetch system state.");
    } finally {
      if (!silent) {
        setBusy((prev) => ({ ...prev, refreshing: false }));
      }
    }
  }, [pushNotice]);

  const loadLogsSnapshot = useCallback(async () => {
    try {
      const payload = await fetchJson("/api/system/logs?limit=400");
      setLogs(payload.data?.logs || []);
    } catch (_) {
      // Keep existing logs if snapshot request fails.
    }
  }, []);

  useEffect(() => {
    void loadState();
    void loadLogsSnapshot();
  }, [loadState, loadLogsSnapshot]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadState({ silent: true });
    }, 5000);

    return () => {
      clearInterval(timer);
    };
  }, [loadState]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadLogsSnapshot();
    }, 3000);

    return () => {
      clearInterval(timer);
    };
  }, [loadLogsSnapshot]);

  useEffect(() => {
    const source = new EventSource("/api/system/logs/stream");

    source.addEventListener("snapshot", (event) => {
      try {
        const payload = JSON.parse(event.data);
        setLogs(Array.isArray(payload?.logs) ? payload.logs : []);
      } catch (_) {
        // Ignore invalid payload.
      }
    });

    source.addEventListener("log", (event) => {
      try {
        const entry = JSON.parse(event.data);
        setLogs((prev) => {
          const next = [...prev, entry];
          if (next.length > 1200) {
            return next.slice(next.length - 1200);
          }
          return next;
        });
      } catch (_) {
        // Ignore invalid payload.
      }
    });

    source.onerror = () => {
      void loadLogsSnapshot();
    };

    return () => {
      source.close();
    };
  }, [loadLogsSnapshot]);

  useEffect(() => {
    const viewport = logsViewportRef.current;
    if (!viewport || !autoScroll) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [logs, autoScroll]);

  const performAction = useCallback(
    async (key, run) => {
      setBusy((prev) => ({ ...prev, [key]: true }));
      try {
        await run();
      } catch (err) {
        pushNotice("error", err.message || "Operation failed.");
      } finally {
        setBusy((prev) => ({ ...prev, [key]: false }));
      }
    },
    [pushNotice]
  );

  const handleManagedApi = useCallback(
    async (action) => {
      await performAction(action === "start" ? "apiStart" : "apiStop", async () => {
        await fetchJson("/api/system/api", {
          method: "POST",
          body: JSON.stringify({ action })
        });
        pushNotice(
          "success",
          action === "start"
            ? "API start request sent."
            : "API stop request sent."
        );
        await loadState({ silent: true });
      });
    },
    [loadState, performAction, pushNotice]
  );

  const handleStartBot = useCallback(async () => {
    await performAction("botStart", async () => {
      await fetchJson("/api/system/bot", {
        method: "POST",
        body: JSON.stringify({
          action: "start",
          meetUrl: form.meetUrl,
          clientName: form.clientName,
          clientCompany: form.clientCompany,
          clientNotes: form.clientNotes,
          forceRestart: form.forceRestart
        })
      });

      pushNotice("success", "Bot session started.");
      await loadState({ silent: true });
    });
  }, [form, loadState, performAction, pushNotice]);

  const handleStopBot = useCallback(async () => {
    await performAction("botStop", async () => {
      await fetchJson("/api/system/bot", {
        method: "POST",
        body: JSON.stringify({
          action: "stop",
          reason: "manual stop from control-ui"
        })
      });

      pushNotice("success", "Bot session stopped.");
      await loadState({ silent: true });
    });
  }, [loadState, performAction, pushNotice]);

  const canStartApi =
    Boolean(managedApi?.enabled) &&
    !busy.apiStart &&
    managedApi?.status !== "running" &&
    managedApi?.status !== "starting";

  const canStopApi =
    Boolean(managedApi?.enabled) &&
    !busy.apiStop &&
    (managedApi?.status === "running" || managedApi?.status === "starting");

  const canStartBot =
    !busy.botStart &&
    Boolean(form.meetUrl.trim()) &&
    Boolean(controlApi?.health?.ok);

  const canStopBot =
    !busy.botStop &&
    ["starting", "running", "stopping"].includes(
      String(botStatus?.status || "").toLowerCase()
    );

  const renderedLogs = useMemo(() => logs.slice(Math.max(logs.length - 800, 0)), [logs]);

  return (
    <main className="shell">
      <div className="glow glow-a" />
      <div className="glow glow-b" />

      <header className="header card reveal">
        <div>
          <p className="eyebrow">Voice Assistant Ops</p>
          <h1>Control UI</h1>
          <p className="subtitle">
            Unified dashboard for API process control, bot launches, and live logs.
          </p>
        </div>
        <div className="header-meta">
          <span className={`pill tone-${statusTone(managedApi?.status)}`}>
            API Process: {managedApi?.status || "unknown"}
          </span>
          <span className={`pill tone-${statusTone(botStatus?.status)}`}>
            Bot: {botStatus?.status || "unknown"}
          </span>
        </div>
      </header>

      <section className="grid reveal reveal-delay-1">
        <article className="card panel">
          <h2>API Process</h2>
          <dl className="kv">
            <div>
              <dt>Status</dt>
              <dd>{managedApi?.status || "-"}</dd>
            </div>
            <div>
              <dt>PID</dt>
              <dd>{managedApi?.pid || "-"}</dd>
            </div>
            <div>
              <dt>Uptime</dt>
              <dd>{formatDuration(managedApi?.uptimeSeconds)}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{formatDate(managedApi?.startedAt)}</dd>
            </div>
            <div>
              <dt>Command</dt>
              <dd className="mono">{managedApi?.command || "-"}</dd>
            </div>
            <div>
              <dt>CWD</dt>
              <dd className="mono">{managedApi?.cwd || "-"}</dd>
            </div>
          </dl>

          <div className="actions">
            <button
              className="btn btn-strong"
              onClick={() => {
                void handleManagedApi("start");
              }}
              disabled={!canStartApi}
            >
              Start API
            </button>
            <button
              className="btn"
              onClick={() => {
                void handleManagedApi("stop");
              }}
              disabled={!canStopApi}
            >
              Stop API
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                void loadState();
              }}
              disabled={busy.refreshing}
            >
              Refresh
            </button>
          </div>

          {!managedApi?.enabled ? (
            <p className="help warning">
              Managed API mode is disabled (`MANAGED_API_ENABLED=false`). The UI can
              control bot sessions, but cannot start/stop the API process.
            </p>
          ) : null}
        </article>

        <article className="card panel">
          <h2>Control API / Bot</h2>
          <dl className="kv">
            <div>
              <dt>Base URL</dt>
              <dd className="mono">{controlApi?.baseUrl || "-"}</dd>
            </div>
            <div>
              <dt>Health</dt>
              <dd>
                {controlApi?.health?.reachable
                  ? `HTTP ${controlApi?.health?.httpStatus ?? "-"}`
                  : "unreachable"}
              </dd>
            </div>
            <div>
              <dt>Bot Status</dt>
              <dd>{botStatus?.status || "-"}</dd>
            </div>
            <div>
              <dt>Session ID</dt>
              <dd className="mono">{botStatus?.sessionId || "-"}</dd>
            </div>
            <div>
              <dt>Meet URL</dt>
              <dd className="mono">{botStatus?.meetUrl || "-"}</dd>
            </div>
            <div>
              <dt>Queue Size</dt>
              <dd>{botStatus?.queueSize ?? "-"}</dd>
            </div>
          </dl>

          <div className="actions">
            <button className="btn btn-strong" onClick={() => void handleStartBot()} disabled={!canStartBot}>
              Start Bot
            </button>
            <button className="btn" onClick={() => void handleStopBot()} disabled={!canStopBot}>
              Stop Bot
            </button>
          </div>

          {controlApi?.health?.error ? (
            <p className="help error">{controlApi.health.error}</p>
          ) : null}
        </article>
      </section>

      <section className="card panel reveal reveal-delay-2">
        <h2>Launch Bot in Meet</h2>
        <div className="form-grid">
          <label>
            <span>Meet URL</span>
            <input
              value={form.meetUrl}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, meetUrl: event.target.value }));
              }}
              placeholder="https://meet.google.com/xxx-xxxx-xxx"
            />
          </label>

          <label>
            <span>Client Name</span>
            <input
              value={form.clientName}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, clientName: event.target.value }));
              }}
              placeholder="John Doe"
            />
          </label>

          <label>
            <span>Company</span>
            <input
              value={form.clientCompany}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, clientCompany: event.target.value }));
              }}
              placeholder="Acme Inc"
            />
          </label>

          <label className="notes">
            <span>Client Context / Notes</span>
            <textarea
              value={form.clientNotes}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, clientNotes: event.target.value }));
              }}
              placeholder="Budget, goals, constraints, and key notes..."
            />
          </label>
        </div>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.forceRestart}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, forceRestart: event.target.checked }));
            }}
          />
          <span>Force restart if a session is already active</span>
        </label>
      </section>

      <section className="card panel logs-section reveal reveal-delay-3">
        <div className="logs-head">
          <h2>Live Logs</h2>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(event) => {
                setAutoScroll(event.target.checked);
              }}
            />
            <span>Auto-scroll</span>
          </label>
        </div>

        <div className="logs" ref={logsViewportRef}>
          {renderedLogs.length === 0 ? (
            <p className="logs-empty">No logs yet.</p>
          ) : (
            renderedLogs.map((entry) => (
              <div key={entry.id} className={`log-line level-${entry.level || "info"}`}>
                <span className="log-ts">[{formatDate(entry.ts)}]</span>
                <span className="log-source">[{entry.source}]</span>
                <span className="log-msg">{entry.message}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <footer className={`notice notice-${notice.type}`}>
        <span>{notice.text || "Ready."}</span>
      </footer>
    </main>
  );
}

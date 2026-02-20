import { getOrchestratorStore } from "./orchestrator-store";
import { getSystemConfig } from "./system-config";

function trimValue(value) {
  return String(value || "").trim();
}

async function requestControlApi(
  path,
  { method = "GET", body, timeoutMs } = {}
) {
  const config = getSystemConfig();
  const store = getOrchestratorStore();
  const headers = {
    Accept: "application/json"
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (config.controlApiToken) {
    headers.Authorization = `Bearer ${config.controlApiToken}`;
  }

  const url = new URL(path, `${config.controlApiBaseUrl}/`).toString();
  const controller = new AbortController();
  const requestTimeoutMs = Math.max(
    1000,
    Number(timeoutMs || config.controlApiTimeoutMs) || config.controlApiTimeoutMs
  );
  const timer = setTimeout(() => {
    controller.abort();
  }, requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal
    });

    const payload = await response.json().catch(() => null);
    const errorMessage =
      trimValue(payload?.error) ||
      (!response.ok ? `Control API returned HTTP ${response.status}.` : "");

    if (errorMessage) {
      store.appendLog({
        source: "control-api",
        level: response.ok ? "warn" : "error",
        message: `${method} ${path} -> ${errorMessage}`
      });
    }

    return {
      requestOk: true,
      ok: response.ok && payload?.ok !== false,
      httpStatus: response.status,
      error: errorMessage,
      payload,
      data: payload?.data ?? null
    };
  } catch (err) {
    const message =
      err?.name === "AbortError"
        ? "Control API request timed out."
        : trimValue(err?.message || String(err));

    store.appendLog({
      source: "control-api",
      level: "error",
      message: `${method} ${path} failed: ${message}`
    });

    return {
      requestOk: false,
      ok: false,
      httpStatus: null,
      error: message,
      payload: null,
      data: null
    };
  } finally {
    clearTimeout(timer);
  }
}

export { requestControlApi };

export async function fetchControlHealth() {
  const result = await requestControlApi("/health");
  return {
    reachable: result.requestOk,
    ok: result.ok,
    httpStatus: result.httpStatus,
    error: result.error,
    payload: result.payload
  };
}

export async function fetchBotStatus() {
  const result = await requestControlApi("/api/v1/bot/status");
  return {
    reachable: result.requestOk,
    ok: result.ok,
    httpStatus: result.httpStatus,
    error: result.error,
    data: result.data,
    payload: result.payload
  };
}

export async function startBotSession({
  meetUrl,
  forceRestart = false,
  projectContext
}) {
  return requestControlApi("/api/v1/bot/start", {
    method: "POST",
    timeoutMs: getSystemConfig().controlApiStartTimeoutMs,
    body: {
      meetUrl,
      forceRestart,
      projectContext
    }
  });
}

export async function stopBotSession({ reason }) {
  return requestControlApi("/api/v1/bot/stop", {
    method: "POST",
    body: {
      reason
    }
  });
}

export async function fetchConfigSchema() {
  return requestControlApi("/api/v1/config/schema");
}

export async function fetchConfigSnapshot({ search = "" } = {}) {
  const query = search ? `?search=${encodeURIComponent(search)}` : "";
  return requestControlApi(`/api/v1/config${query}`);
}

export async function previewConfigChanges(changeSet = {}) {
  return requestControlApi("/api/v1/config", {
    method: "PUT",
    body: changeSet
  });
}

export async function applyConfigPreview({ previewId }) {
  return requestControlApi("/api/v1/config/apply", {
    method: "POST",
    body: {
      previewId
    }
  });
}

export async function fetchConfigAudit({ limit = 200 } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 200;
  return requestControlApi(`/api/v1/config/audit?limit=${safeLimit}`);
}

export async function requestVoiceWsTicket({ ttlMs = 60000 } = {}) {
  return requestControlApi("/api/v1/voice/ws-ticket", {
    method: "POST",
    body: {
      ttlMs
    }
  });
}

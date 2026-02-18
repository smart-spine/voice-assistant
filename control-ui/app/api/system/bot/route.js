import {
  startBotSession,
  stopBotSession
} from "@/src/lib/control-api-client";
import { getOrchestratorStore } from "@/src/lib/orchestrator-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function trimValue(value) {
  return String(value || "").trim();
}

function canUseMeetUrl(raw) {
  try {
    const parsed = new URL(String(raw || "").trim());
    return ["http:", "https:"].includes(parsed.protocol);
  } catch (_) {
    return false;
  }
}

export async function POST(request) {
  const payload = await request.json().catch(() => ({}));
  const action = String(payload?.action || "").trim().toLowerCase();
  const store = getOrchestratorStore();

  if (!["start", "stop"].includes(action)) {
    return Response.json(
      {
        ok: false,
        error: "Unsupported action. Use 'start' or 'stop'."
      },
      { status: 400 }
    );
  }

  if (action === "start") {
    const meetUrl = trimValue(payload?.meetUrl);
    const forceRestart = Boolean(payload?.forceRestart);
    const clientName = trimValue(payload?.clientName);
    const clientCompany = trimValue(payload?.clientCompany);
    const clientNotes = trimValue(payload?.clientNotes);

    if (!meetUrl || !canUseMeetUrl(meetUrl)) {
      return Response.json(
        {
          ok: false,
          error: "Provide a valid meetUrl (http/https)."
        },
        { status: 400 }
      );
    }

    let projectContext;
    if (clientName || clientCompany || clientNotes) {
      projectContext = {
        clientName,
        clientCompany,
        clientNotes
      };
    }

    store.appendLog({
      source: "ui",
      level: "info",
      message: `Bot start requested for ${meetUrl} (forceRestart=${
        forceRestart ? "true" : "false"
      }).`
    });

    const result = await startBotSession({
      meetUrl,
      forceRestart,
      projectContext
    });

    if (!result.ok) {
      return Response.json(
        {
          ok: false,
          error: result.error || "Failed to start bot session.",
          data: result.data
        },
        { status: result.httpStatus || 502 }
      );
    }

    return Response.json({ ok: true, data: result.data });
  }

  const reason = trimValue(payload?.reason) || "manual stop from control-ui";
  store.appendLog({
    source: "ui",
    level: "info",
    message: `Bot stop requested (${reason}).`
  });

  const result = await stopBotSession({ reason });
  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        error: result.error || "Failed to stop bot session.",
        data: result.data
      },
      { status: result.httpStatus || 502 }
    );
  }

  return Response.json({ ok: true, data: result.data });
}

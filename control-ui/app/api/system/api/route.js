import { getOrchestratorStore } from "@/src/lib/orchestrator-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const store = getOrchestratorStore();
  const payload = await request.json().catch(() => ({}));
  const action = String(payload?.action || "").trim().toLowerCase();

  try {
    if (action === "start") {
      const state = await store.startManagedApi();
      return Response.json({ ok: true, data: state });
    }

    if (action === "stop") {
      const state = await store.stopManagedApi();
      return Response.json({ ok: true, data: state });
    }

    return Response.json(
      {
        ok: false,
        error: "Unsupported action. Use 'start' or 'stop'."
      },
      { status: 400 }
    );
  } catch (err) {
    const message = String(err?.message || err || "Failed to manage API process.");
    store.appendLog({
      source: "system",
      level: "error",
      message: `API process action failed: ${message}`
    });
    return Response.json(
      {
        ok: false,
        error: message
      },
      { status: 500 }
    );
  }
}

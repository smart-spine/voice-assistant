import { getOrchestratorStore } from "../../../../lib/orchestrator-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const rawLimit = Number(searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) ? rawLimit : 400;

  const store = getOrchestratorStore();
  return Response.json({
    ok: true,
    data: {
      logs: store.getLogs(limit)
    }
  });
}

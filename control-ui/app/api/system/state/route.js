import {
  fetchBotStatus,
  fetchControlHealth
} from "../../../../lib/control-api-client";
import { getOrchestratorStore } from "../../../../lib/orchestrator-store";
import { getSystemConfig } from "../../../../lib/system-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const store = getOrchestratorStore();
  const config = getSystemConfig();

  const [health, bot] = await Promise.all([fetchControlHealth(), fetchBotStatus()]);

  return Response.json({
    ok: true,
    data: {
      managedApi: store.getApiState(),
      controlApi: {
        baseUrl: config.controlApiBaseUrl,
        health,
        bot
      }
    }
  });
}

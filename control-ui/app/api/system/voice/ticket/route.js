import { requestVoiceWsTicket } from "../../../../../lib/control-api-client";
import { getSystemConfig } from "../../../../../lib/system-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const payload = await request.json().catch(() => ({}));
  const ttlMs = Number(payload?.ttlMs || 60000);
  const result = await requestVoiceWsTicket({ ttlMs });

  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        error: result.error || "Failed to request voice WS ticket."
      },
      { status: result.httpStatus || 502 }
    );
  }

  const config = getSystemConfig();
  let wsBaseUrl = "";
  try {
    const parsed = new URL(config.controlApiBaseUrl);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    wsBaseUrl = parsed.toString().replace(/\/$/, "");
  } catch (_) {
    wsBaseUrl = "";
  }

  return Response.json({
    ok: true,
    data: {
      ...result.data,
      wsBaseUrl
    }
  });
}

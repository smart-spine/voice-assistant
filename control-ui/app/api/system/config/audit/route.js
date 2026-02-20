import { fetchConfigAudit } from "../../../../../lib/control-api-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const rawLimit = Number(searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) ? rawLimit : 200;

  const result = await fetchConfigAudit({ limit });
  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        error: result.error || "Failed to fetch config audit log."
      },
      { status: result.httpStatus || 502 }
    );
  }

  return Response.json({
    ok: true,
    data: result.data
  });
}

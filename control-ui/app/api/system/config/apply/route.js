import { applyConfigPreview } from "../../../../../lib/control-api-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const payload = await request.json().catch(() => ({}));
  const previewId = String(payload?.previewId || "").trim();
  if (!previewId) {
    return Response.json(
      {
        ok: false,
        error: "`previewId` is required."
      },
      { status: 400 }
    );
  }

  const result = await applyConfigPreview({ previewId });
  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        error: result.error || "Failed to apply config preview.",
        data: result.data
      },
      { status: result.httpStatus || 400 }
    );
  }

  return Response.json({
    ok: true,
    data: result.data
  });
}

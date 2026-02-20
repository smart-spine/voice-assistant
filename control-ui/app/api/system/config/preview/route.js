import { previewConfigChanges } from "../../../../../lib/control-api-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request) {
  const payload = await request.json().catch(() => ({}));
  const result = await previewConfigChanges(payload);
  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        error: result.error || "Failed to preview config changes.",
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

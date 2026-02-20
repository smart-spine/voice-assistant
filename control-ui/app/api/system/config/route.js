import {
  fetchConfigSnapshot,
  previewConfigChanges
} from "../../../../lib/control-api-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const search = String(searchParams.get("search") || "").trim();
  const result = await fetchConfigSnapshot({ search });
  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        error: result.error || "Failed to load config."
      },
      { status: result.httpStatus || 502 }
    );
  }

  return Response.json({
    ok: true,
    data: result.data
  });
}

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

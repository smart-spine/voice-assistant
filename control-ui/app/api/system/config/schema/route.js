import { fetchConfigSchema } from "../../../../../lib/control-api-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await fetchConfigSchema();
  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        error: result.error || "Failed to load config schema."
      },
      { status: result.httpStatus || 502 }
    );
  }

  return Response.json({
    ok: true,
    data: result.data
  });
}

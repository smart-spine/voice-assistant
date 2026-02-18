import { getOrchestratorStore } from "../../../../../src/lib/orchestrator-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function formatSse(event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request) {
  const store = getOrchestratorStore();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  let closed = false;

  const safeWrite = async (chunk) => {
    if (closed) {
      return;
    }

    try {
      await writer.write(chunk);
    } catch (_) {
      closed = true;
    }
  };

  await safeWrite(
    formatSse("snapshot", {
      logs: store.getLogs(400)
    })
  );

  const unsubscribe = store.subscribe((entry) => {
    void safeWrite(formatSse("log", entry));
  });

  const keepAlive = setInterval(() => {
    void safeWrite(encoder.encode(": keep-alive\n\n"));
  }, 15000);

  request.signal.addEventListener("abort", async () => {
    unsubscribe();
    clearInterval(keepAlive);
    closed = true;
    try {
      await writer.close();
    } catch (_) {
      // Ignore close races.
    }
  });

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}

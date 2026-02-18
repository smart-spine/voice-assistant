import { getOrchestratorStore } from "../../../../../lib/orchestrator-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function formatSse(event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request) {
  const store = getOrchestratorStore();
  let controllerRef = null;
  let closed = false;
  let keepAliveTimer = null;
  let unsubscribe = null;

  const closeStream = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    try {
      controllerRef?.close();
    } catch (_) {
      // Ignore close races.
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;

      const enqueue = (chunk) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(chunk);
        } catch (_) {
          closeStream();
        }
      };

      enqueue(
        formatSse("snapshot", {
          logs: store.getLogs(400)
        })
      );

      unsubscribe = store.subscribe((entry) => {
        enqueue(formatSse("log", entry));
      });

      keepAliveTimer = setInterval(() => {
        enqueue(encoder.encode(": keep-alive\n\n"));
      }, 15000);
    },
    cancel() {
      closeStream();
    }
  });

  request.signal.addEventListener("abort", () => {
    closeStream();
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

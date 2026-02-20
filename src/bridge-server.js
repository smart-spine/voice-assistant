const express = require("express");
const path = require("path");

function cleanString(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function clampNumber(value, { fallback = 0, min = -Infinity, max = Infinity } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseLanguageTag(value) {
  const normalized = cleanString(value).toLowerCase();
  if (!normalized) {
    return "";
  }
  const [primary] = normalized.split("-");
  if (!primary || primary.length < 2 || primary.length > 3) {
    return "";
  }
  return primary;
}

function buildRealtimeTurnDetection(payload = {}) {
  const type = cleanString(payload.turnDetection, "manual").toLowerCase();

  if (type === "server_vad") {
    return {
      type: "server_vad",
      threshold: clampNumber(payload.vadThreshold, {
        fallback: 0.45,
        min: 0,
        max: 1
      }),
      silence_duration_ms: Math.trunc(
        clampNumber(payload.vadSilenceMs, {
          fallback: 280,
          min: 120,
          max: 2000
        })
      ),
      prefix_padding_ms: Math.trunc(
        clampNumber(payload.vadPrefixPaddingMs, {
          fallback: 180,
          min: 0,
          max: 1000
        })
      ),
      create_response: true,
      interrupt_response: payload.interruptResponseOnTurn !== false
    };
  }

  if (type === "semantic_vad") {
    const eagerness = cleanString(payload.turnDetectionEagerness, "auto").toLowerCase();
    return {
      type: "semantic_vad",
      eagerness: ["low", "medium", "high", "auto"].includes(eagerness)
        ? eagerness
        : "auto",
      create_response: true,
      interrupt_response: payload.interruptResponseOnTurn !== false
    };
  }

  return null;
}

async function createRealtimeEphemeralSession({
  apiKey,
  model,
  voice,
  temperature,
  instructions,
  inputTranscriptionModel,
  language,
  turnDetection,
  turnDetectionEagerness,
  vadThreshold,
  vadSilenceMs,
  vadPrefixPaddingMs,
  interruptResponseOnTurn
}) {
  const payload = {
    model: cleanString(model, "gpt-4o-mini-realtime-preview-2024-12-17"),
    modalities: ["audio", "text"],
    voice: cleanString(voice, "alloy"),
    temperature: clampNumber(temperature, {
      fallback: 0.8,
      min: 0.6,
      max: 1.2
    }),
    instructions: cleanString(instructions),
    input_audio_transcription: {
      model: cleanString(inputTranscriptionModel, "gpt-4o-mini-transcribe"),
      language: parseLanguageTag(language) || undefined
    },
    turn_detection: buildRealtimeTurnDetection({
      turnDetection,
      turnDetectionEagerness,
      vadThreshold,
      vadSilenceMs,
      vadPrefixPaddingMs,
      interruptResponseOnTurn
    })
  };

  const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const rawText = await response.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    data = { message: rawText };
  }

  if (!response.ok) {
    const reason =
      cleanString(data?.error?.message) ||
      cleanString(data?.message) ||
      `OpenAI realtime session create failed (${response.status}).`;
    const error = new Error(reason);
    error.statusCode = response.status;
    throw error;
  }

  const clientSecret = cleanString(data?.client_secret?.value);
  if (!clientSecret) {
    const error = new Error("OpenAI realtime session response missing client_secret.");
    error.statusCode = 502;
    throw error;
  }

  return {
    clientSecret,
    session: {
      id: cleanString(data?.id),
      model: cleanString(data?.model),
      expiresAt:
        Number.isFinite(Number(data?.expires_at)) && Number(data?.expires_at) > 0
          ? Number(data.expires_at)
          : null
    }
  };
}

async function startBridgeServer(port, host = "127.0.0.1", options = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));
  const staticDir = path.resolve(__dirname, "..", "public");
  const openaiApiKey = cleanString(options?.openaiApiKey || options?.config?.openaiApiKey);

  app.use(express.static(staticDir));
  app.get("/health", (_, res) => {
    res.json({ ok: true });
  });
  app.post("/realtime/session", async (req, res) => {
    if (!openaiApiKey) {
      res.status(500).json({
        error: {
          message: "OPENAI_API_KEY is not configured on bridge server."
        }
      });
      return;
    }

    try {
      const payload = req.body && typeof req.body === "object" ? req.body : {};
      const session = await createRealtimeEphemeralSession({
        apiKey: openaiApiKey,
        model: payload.model,
        voice: payload.voice,
        temperature: payload.temperature,
        instructions: payload.instructions,
        inputTranscriptionModel: payload.inputTranscriptionModel,
        language: payload.language,
        turnDetection: payload.turnDetection,
        turnDetectionEagerness: payload.turnDetectionEagerness,
        vadThreshold: payload.vadThreshold,
        vadSilenceMs: payload.vadSilenceMs,
        vadPrefixPaddingMs: payload.vadPrefixPaddingMs,
        interruptResponseOnTurn: payload.interruptResponseOnTurn
      });

      res.json(session);
    } catch (err) {
      const statusCode = Number.isFinite(Number(err?.statusCode))
        ? Number(err.statusCode)
        : 500;
      res.status(statusCode).json({
        error: {
          message: cleanString(
            err?.message,
            "Failed to create realtime session token."
          )
        }
      });
    }
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      resolve({ app, server });
    });
    server.on("error", reject);
  });
}

module.exports = {
  startBridgeServer
};

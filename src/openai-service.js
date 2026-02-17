const OpenAI = require("openai");

function mimeTypeFromAudioFormat(format) {
  const value = String(format || "").toLowerCase();
  if (value === "wav") {
    return "audio/wav";
  }
  if (value === "opus") {
    return "audio/opus";
  }
  if (value === "aac") {
    return "audio/aac";
  }
  if (value === "flac") {
    return "audio/flac";
  }
  if (value === "pcm") {
    return "audio/pcm";
  }
  return "audio/mpeg";
}

function limitText(value, maxChars) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trimEnd()}...`;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isAbortError(err) {
  const name = String(err?.name || "");
  const code = String(err?.code || "");
  const message = String(err?.message || "");
  return (
    name === "AbortError" ||
    code === "ABORT_ERR" ||
    /abort/i.test(message)
  );
}

function findSplitIndex(text, { minChars, targetChars, maxChars, force = false }) {
  const value = String(text || "");
  if (!value) {
    return -1;
  }

  const hardLimit = Math.min(maxChars, value.length);
  if (!force && value.length < targetChars) {
    return -1;
  }
  if (force && value.length < minChars && value.length < maxChars) {
    return -1;
  }

  let strongBoundary = -1;
  let softBoundary = -1;
  let spaceBoundary = -1;

  for (let index = 0; index < hardLimit; index += 1) {
    const char = value[index];
    if (".!?;:\n".includes(char)) {
      strongBoundary = index + 1;
      continue;
    }
    if (")]}".includes(char)) {
      softBoundary = index + 1;
      continue;
    }
    if (char === " ") {
      spaceBoundary = index + 1;
    }
  }

  const minBoundary = Math.max(minChars, Math.floor(targetChars * 0.45));
  if (strongBoundary >= minBoundary) {
    return strongBoundary;
  }
  if (softBoundary >= minBoundary) {
    return softBoundary;
  }
  if (force && value.length < maxChars) {
    return -1;
  }
  if (spaceBoundary >= targetChars) {
    return spaceBoundary;
  }

  if (value.length >= maxChars) {
    if (spaceBoundary >= minBoundary) {
      return spaceBoundary;
    }
    return hardLimit;
  }

  return -1;
}

function consumeStreamingChunks(
  inputText,
  { minChars = 30, targetChars = 120, maxChars = 220, force = false } = {}
) {
  let pending = String(inputText || "");
  const chunks = [];

  while (pending) {
    const splitIndex = findSplitIndex(pending, {
      minChars,
      targetChars,
      maxChars,
      force
    });
    if (splitIndex < 0) {
      break;
    }

    const chunk = normalizeText(pending.slice(0, splitIndex));
    if (chunk) {
      chunks.push(chunk);
    }
    pending = pending.slice(splitIndex).replace(/^\s+/, "");
  }

  return {
    chunks,
    rest: pending
  };
}

class OpenAIResponder {
  constructor({
    apiKey,
    model,
    ttsModel = "gpt-4o-mini-tts",
    ttsVoice = "alloy",
    ttsFormat = "mp3",
    systemPrompt,
    maxUserMessageChars = 600,
    maxAssistantReplyChars = 500,
    maxHistoryMessages = 12,
    temperature = 0.4,
    streamChunkMinChars = 30,
    streamChunkTargetChars = 120,
    streamChunkMaxChars = 220,
    streamChunkMaxLatencyMs = 550
  }) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.ttsModel = ttsModel;
    this.ttsVoice = ttsVoice;
    this.ttsFormat = ttsFormat;
    this.systemPrompt = systemPrompt;
    this.maxUserMessageChars = maxUserMessageChars;
    this.maxAssistantReplyChars = maxAssistantReplyChars;
    this.maxHistoryMessages = maxHistoryMessages;
    this.temperature = temperature;
    this.streamChunkMinChars = streamChunkMinChars;
    this.streamChunkTargetChars = streamChunkTargetChars;
    this.streamChunkMaxChars = streamChunkMaxChars;
    this.streamChunkMaxLatencyMs = streamChunkMaxLatencyMs;
    this.history = [];
  }

  buildMessages(userText) {
    return [
      {
        role: "system",
        content: this.systemPrompt
      },
      ...this.history,
      {
        role: "user",
        content: userText
      }
    ];
  }

  appendHistory({ userText, assistantReply }) {
    this.history.push(
      {
        role: "user",
        content: userText
      },
      {
        role: "assistant",
        content: assistantReply
      }
    );

    if (this.history.length > this.maxHistoryMessages) {
      this.history = this.history.slice(-this.maxHistoryMessages);
    }
  }

  async streamReply(userText, { signal, onTextChunk = async () => {} } = {}) {
    const safeUserText = limitText(userText, this.maxUserMessageChars);
    if (!safeUserText) {
      throw new Error("User message is empty.");
    }

    const messages = this.buildMessages(safeUserText);
    let assistantReply = "";
    let pendingChunk = "";
    let remainingChars = this.maxAssistantReplyChars;
    let lastChunkAt = Date.now();
    let aborted = false;

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          temperature: this.temperature,
          stream: true
        },
        { signal }
      );

      for await (const part of stream) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }

        const delta = part.choices?.[0]?.delta?.content;
        if (!delta) {
          continue;
        }

        const safeDelta =
          remainingChars > 0 ? String(delta).slice(0, remainingChars) : "";
        if (!safeDelta) {
          break;
        }

        assistantReply += safeDelta;
        pendingChunk += safeDelta;
        remainingChars -= safeDelta.length;

        const forceByLatency =
          pendingChunk.length >= this.streamChunkMinChars &&
          Date.now() - lastChunkAt >= this.streamChunkMaxLatencyMs;
        const { chunks, rest } = consumeStreamingChunks(pendingChunk, {
          minChars: this.streamChunkMinChars,
          targetChars: this.streamChunkTargetChars,
          maxChars: this.streamChunkMaxChars,
          force: forceByLatency
        });
        pendingChunk = rest;

        for (const chunk of chunks) {
          await onTextChunk(chunk);
          lastChunkAt = Date.now();
        }

        if (remainingChars <= 0) {
          break;
        }
      }
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        aborted = true;
      } else {
        throw err;
      }
    }

    const trailingChunk = normalizeText(pendingChunk);
    if (trailingChunk && !aborted) {
      await onTextChunk(trailingChunk);
    }

    const finalReply = normalizeText(assistantReply);
    if (!finalReply) {
      if (aborted) {
        return {
          text: "",
          aborted: true
        };
      }
      throw new Error("OpenAI returned an empty streamed reply.");
    }

    if (!aborted) {
      this.appendHistory({ userText: safeUserText, assistantReply: finalReply });
    }

    return {
      text: finalReply,
      aborted
    };
  }

  async synthesizeSpeech(text, { signal } = {}) {
    const input = String(text || "").trim();
    if (!input) {
      return null;
    }

    const response = await this.client.audio.speech.create(
      {
        model: this.ttsModel,
        voice: this.ttsVoice,
        input,
        format: this.ttsFormat
      },
      { signal }
    );

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    if (audioBuffer.length === 0) {
      throw new Error("OpenAI returned empty audio.");
    }

    return {
      audioBase64: audioBuffer.toString("base64"),
      mimeType: mimeTypeFromAudioFormat(this.ttsFormat),
      bytes: audioBuffer.length
    };
  }
}

module.exports = {
  OpenAIResponder,
  consumeStreamingChunks
};

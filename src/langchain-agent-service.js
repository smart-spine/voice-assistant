const OpenAI = require("openai");
const { normalizeText } = require("./utils/text-utils");
const { consumeStreamingChunks } = require("./openai-service");

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
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trimEnd()}...`;
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

function pickMessageText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }

  if (content && typeof content.text === "string") {
    return content.text;
  }

  return "";
}

class LangChainAgentResponder {
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
    this.apiKey = apiKey;
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

    this.chatModel = null;
    this.history = [];
    this.openaiClient = new OpenAI({ apiKey });
  }

  async getModel() {
    if (this.chatModel) {
      return this.chatModel;
    }

    const { ChatOpenAI } = await import("@langchain/openai");
    this.chatModel = new ChatOpenAI({
      apiKey: this.apiKey,
      model: this.model,
      temperature: this.temperature
    });
    return this.chatModel;
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

  pushHistoryMessages(messages = []) {
    const valid = Array.isArray(messages)
      ? messages.filter(
          (item) =>
            item &&
            (item.role === "system" ||
              item.role === "user" ||
              item.role === "assistant") &&
            normalizeText(item.content)
        )
      : [];
    if (valid.length === 0) {
      return;
    }

    this.history.push(...valid);
    if (this.history.length > this.maxHistoryMessages) {
      this.history = this.history.slice(-this.maxHistoryMessages);
    }
  }

  appendHistory({ userText, assistantReply }) {
    this.pushHistoryMessages([
      {
        role: "user",
        content: userText
      },
      {
        role: "assistant",
        content: assistantReply
      }
    ]);
  }

  appendInterruptionContext({ source = "", reason = "", text = "" } = {}) {
    const note = normalizeText(
      `Interruption context: user started speaking over assistant output (source=${normalizeText(
        source || "unknown"
      ) || "unknown"}, reason=${normalizeText(reason || "unknown") || "unknown"}). Latest user fragment: ${limitText(
        text,
        220
      ) || "<none>"}`
    );
    if (!note) {
      return;
    }
    this.pushHistoryMessages([
      {
        role: "system",
        content: note
      }
    ]);
  }

  async streamReply(
    userText,
    { signal, onTextChunk = async () => {}, commitHistory = true } = {}
  ) {
    const safeUserText = limitText(userText, this.maxUserMessageChars);
    if (!safeUserText) {
      throw new Error("User message is empty.");
    }

    const model = await this.getModel();
    const messages = this.buildMessages(safeUserText);

    let assistantReply = "";
    let pendingChunk = "";
    let remainingChars = this.maxAssistantReplyChars;
    let lastChunkAt = Date.now();
    let aborted = false;

    try {
      const stream = await model.stream(messages, { signal });
      for await (const part of stream) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }

        const delta = pickMessageText(part?.content);
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
      throw new Error("LangChain returned an empty streamed reply.");
    }

    if (!aborted && commitHistory) {
      this.appendHistory({
        userText: safeUserText,
        assistantReply: finalReply
      });
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

    const response = await this.openaiClient.audio.speech.create(
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
  LangChainAgentResponder
};

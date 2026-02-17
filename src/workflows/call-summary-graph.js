const { normalizeText } = require("../utils/text-utils");

function clampText(value, maxChars) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0 || normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trimEnd()}...`;
}

function pickMessageText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const merged = content
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
    return merged;
  }

  if (content && typeof content.text === "string") {
    return content.text;
  }

  return "";
}

function sanitizeTurnText(value) {
  return clampText(value, 500);
}

function sanitizeConversationTurns(turns, maxTurns) {
  const source = Array.isArray(turns) ? turns : [];
  const normalized = source
    .map((item) => ({
      source: normalizeText(item?.source || "unknown"),
      user: sanitizeTurnText(item?.user),
      bot: sanitizeTurnText(item?.bot)
    }))
    .filter((item) => item.user && item.bot);

  if (!Number.isFinite(maxTurns) || maxTurns <= 0 || normalized.length <= maxTurns) {
    return normalized;
  }
  return normalized.slice(-maxTurns);
}

function buildTranscript(turns, maxChars = 12000) {
  const lines = turns.map((turn, index) => {
    const source = turn.source ? ` (${turn.source})` : "";
    return [
      `Turn ${index + 1}${source}:`,
      `User: ${turn.user}`,
      `Assistant: ${turn.bot}`
    ].join("\n");
  });
  return clampText(lines.join("\n\n"), maxChars);
}

function createSummaryPrompt({
  sessionId,
  meetUrl,
  projectContext,
  transcript
}) {
  const contextValue = normalizeText(projectContext || "") || "none";
  return `Session ID: ${sessionId || "unknown"}
Meet URL: ${meetUrl || "unknown"}
Project context: ${contextValue}

Conversation transcript:
${transcript}

Produce concise call notes in English with this exact structure:
1) Client profile
- Name: ...
- Budget: ...
2) Key points
- ...
3) Risks / unknowns
- ...
4) Recommended next step
- ...

If a field is missing in transcript, write "Unknown".`;
}

async function summarizeCallWithGraph({
  apiKey,
  model = "gpt-4o-mini",
  temperature = 0.2,
  conversationTurns = [],
  sessionId = "",
  meetUrl = "",
  projectContext = "",
  maxTurns = 40,
  maxTranscriptChars = 12000,
  maxOutputChars = 1500,
  llm = null
} = {}) {
  const turns = sanitizeConversationTurns(conversationTurns, maxTurns);
  if (turns.length === 0) {
    return null;
  }

  const transcript = buildTranscript(turns, maxTranscriptChars);
  if (!transcript) {
    return null;
  }

  const { Annotation, END, START, StateGraph } = await import("@langchain/langgraph");

  let resolvedLlm = llm;
  if (!resolvedLlm) {
    const { ChatOpenAI } = await import("@langchain/openai");
    resolvedLlm = new ChatOpenAI({
      apiKey,
      model,
      temperature
    });
  }

  const SummaryState = Annotation.Root({
    transcript: Annotation({
      default: () => ""
    }),
    summary: Annotation({
      default: () => ""
    })
  });

  const graph = new StateGraph(SummaryState)
    .addNode("summarizeCall", async (state) => {
      const prompt = createSummaryPrompt({
        sessionId,
        meetUrl,
        projectContext,
        transcript: state.transcript
      });

      const response = await resolvedLlm.invoke([
        {
          role: "system",
          content:
            "You are a strict call analyst. Use only facts from transcript and keep output compact."
        },
        {
          role: "user",
          content: prompt
        }
      ]);

      const summary = clampText(
        pickMessageText(response?.content),
        maxOutputChars
      );
      return {
        summary: summary || "Summary generation failed: empty model output."
      };
    })
    .addEdge(START, "summarizeCall")
    .addEdge("summarizeCall", END)
    .compile();

  const result = await graph.invoke({ transcript });
  const finalSummary = clampText(result?.summary, maxOutputChars);

  return {
    turnsCount: turns.length,
    transcript,
    summary: finalSummary || "Summary generation failed: empty graph output."
  };
}

module.exports = {
  summarizeCallWithGraph,
  sanitizeConversationTurns,
  buildTranscript
};


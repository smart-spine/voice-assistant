const OpenAI = require("openai");
const {
  normalizeText,
  normalizeLooseComparableText,
  countWords,
  isLikelySentenceComplete,
  isLikelyIncompleteFragment
} = require("./utils/text-utils");

const TRAILING_INCOMPLETE_MARKERS = new Set([
  "and",
  "or",
  "but",
  "so",
  "because",
  "if",
  "when",
  "while",
  "that",
  "to",
  "for",
  "with",
  "и",
  "а",
  "но",
  "или",
  "если",
  "когда",
  "что",
  "чтобы",
  "потому",
  "чтобы",
  "для"
]);

const TRAILING_FILLER_REGEX =
  /\b(uh|um|hmm|erm|like|you know|well|ну|ээ|эм|как бы|типа)\s*$/i;

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function pickTrailingToken(text) {
  const tokens = normalizeLooseComparableText(text)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens[tokens.length - 1] || "";
}

function extractFirstJsonObject(text) {
  const value = String(text || "").trim();
  if (!value) {
    return null;
  }
  const match = value.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

class SemanticTurnDetector {
  constructor({
    enabled = false,
    useLlm = false,
    apiKey = "",
    model = "gpt-4o-mini",
    timeoutMs = 180,
    minDelayMs = 250,
    maxDelayMs = 900
  } = {}) {
    this.enabled = Boolean(enabled);
    this.useLlm = Boolean(useLlm) && this.enabled;
    this.timeoutMs = Math.max(80, Math.min(3000, Math.trunc(Number(timeoutMs) || 180)));
    this.minDelayMs = Math.max(
      120,
      Math.min(1200, Math.trunc(Number(minDelayMs) || 250))
    );
    this.maxDelayMs = Math.max(
      this.minDelayMs,
      Math.min(6000, Math.trunc(Number(maxDelayMs) || 900))
    );
    this.model = String(model || "gpt-4o-mini").trim() || "gpt-4o-mini";
    this.cache = new Map();
    this.maxCacheSize = 120;
    this.client =
      this.useLlm && String(apiKey || "").trim()
        ? new OpenAI({ apiKey: String(apiKey).trim() })
        : null;
  }

  normalizeDelay(value) {
    return clampNumber(value, this.minDelayMs, this.maxDelayMs, this.minDelayMs);
  }

  evaluateHeuristic(text, { isFirstUserTurn = false } = {}) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return {
        status: "incomplete",
        recommendedDelayMs: this.maxDelayMs,
        confidence: 0.95,
        reason: "empty-input",
        llmUsed: false
      };
    }

    const words = countWords(normalized);
    const trailingToken = pickTrailingToken(normalized);
    const endsWithStrongPunctuation = /[.!?…]["')\]]*$/.test(normalized);
    const endsWithWeakBoundary = /[,:\-–—]\s*$/.test(normalized);
    const looksLikeIncomplete = isLikelyIncompleteFragment(normalized, {
      minWordsForComplete: 4
    });

    if (TRAILING_FILLER_REGEX.test(normalized)) {
      return {
        status: "incomplete",
        recommendedDelayMs: this.normalizeDelay(this.maxDelayMs - 60),
        confidence: 0.9,
        reason: "trailing-filler",
        llmUsed: false
      };
    }

    if (TRAILING_INCOMPLETE_MARKERS.has(trailingToken)) {
      return {
        status: "incomplete",
        recommendedDelayMs: this.normalizeDelay(this.maxDelayMs - 80),
        confidence: 0.9,
        reason: `trailing-marker:${trailingToken}`,
        llmUsed: false
      };
    }

    if (endsWithWeakBoundary) {
      return {
        status: "incomplete",
        recommendedDelayMs: this.normalizeDelay(this.maxDelayMs - 120),
        confidence: 0.82,
        reason: "weak-boundary",
        llmUsed: false
      };
    }

    if (endsWithStrongPunctuation || isLikelySentenceComplete(normalized)) {
      return {
        status: "complete",
        recommendedDelayMs: this.minDelayMs,
        confidence: 0.94,
        reason: "strong-punctuation",
        llmUsed: false
      };
    }

    if (words <= 2) {
      return {
        status: isFirstUserTurn ? "uncertain" : "incomplete",
        recommendedDelayMs: this.normalizeDelay(
          isFirstUserTurn ? this.minDelayMs + 80 : this.maxDelayMs - 140
        ),
        confidence: isFirstUserTurn ? 0.6 : 0.8,
        reason: "very-short-fragment",
        llmUsed: false
      };
    }

    if (looksLikeIncomplete) {
      return {
        status: "uncertain",
        recommendedDelayMs: this.normalizeDelay(
          this.minDelayMs + Math.round((this.maxDelayMs - this.minDelayMs) * 0.4)
        ),
        confidence: 0.66,
        reason: "incomplete-shape",
        llmUsed: false
      };
    }

    return {
      status: "complete",
      recommendedDelayMs: this.normalizeDelay(this.minDelayMs + 40),
      confidence: 0.72,
      reason: "default-complete",
      llmUsed: false
    };
  }

  getCached(text) {
    const key = normalizeLooseComparableText(text);
    if (!key) {
      return null;
    }
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.at > 12000) {
      this.cache.delete(key);
      return null;
    }
    return cached.value;
  }

  setCached(text, value) {
    const key = normalizeLooseComparableText(text);
    if (!key) {
      return;
    }
    this.cache.set(key, {
      value,
      at: Date.now()
    });
    if (this.cache.size <= this.maxCacheSize) {
      return;
    }
    const firstKey = this.cache.keys().next().value;
    if (firstKey) {
      this.cache.delete(firstKey);
    }
  }

  async evaluateWithLlm(text, heuristic) {
    if (!this.client || !this.useLlm) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.client.responses.create(
        {
          model: this.model,
          input: [
            {
              role: "system",
              content:
                "Classify end-of-turn for live speech. Return JSON only with keys: status, delay_ms, confidence, reason. status must be complete, incomplete, or uncertain."
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `Transcript: "${text}"\nHeuristic status: ${heuristic.status}\nHeuristic delay_ms: ${heuristic.recommendedDelayMs}`
                }
              ]
            }
          ],
          max_output_tokens: 80,
          temperature: 0
        },
        { signal: controller.signal }
      );
      clearTimeout(timeout);

      const parsed = extractFirstJsonObject(response?.output_text || "");
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      const rawStatus = String(parsed.status || "")
        .trim()
        .toLowerCase();
      if (!["complete", "incomplete", "uncertain"].includes(rawStatus)) {
        return null;
      }

      const rawConfidence = clampNumber(parsed.confidence, 0, 1, 0.6);
      return {
        status: rawStatus,
        recommendedDelayMs: this.normalizeDelay(
          parsed.delay_ms ?? heuristic.recommendedDelayMs
        ),
        confidence: rawConfidence,
        reason: normalizeText(parsed.reason) || "llm",
        llmUsed: true
      };
    } catch (_) {
      clearTimeout(timeout);
      return null;
    }
  }

  async evaluate(text, { isFirstUserTurn = false } = {}) {
    const normalized = normalizeText(text);
    const heuristic = this.evaluateHeuristic(normalized, { isFirstUserTurn });
    if (!this.enabled) {
      return heuristic;
    }

    const cached = this.getCached(normalized);
    if (cached) {
      return cached;
    }

    if (!this.useLlm || !this.client || heuristic.status !== "uncertain") {
      this.setCached(normalized, heuristic);
      return heuristic;
    }

    const llm = await this.evaluateWithLlm(normalized, heuristic);
    if (!llm) {
      this.setCached(normalized, heuristic);
      return heuristic;
    }

    // Keep the result conservative: when uncertain, never go below min delay.
    const merged = {
      ...llm,
      recommendedDelayMs: this.normalizeDelay(
        llm.status === "incomplete"
          ? Math.max(llm.recommendedDelayMs, heuristic.recommendedDelayMs)
          : llm.recommendedDelayMs
      )
    };
    this.setCached(normalized, merged);
    return merged;
  }
}

module.exports = {
  SemanticTurnDetector
};


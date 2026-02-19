const { startBridgeServer } = require("../bridge-server");
const { OpenAIResponder } = require("../openai-service");
const { launchBrowser } = require("../meet-controller");
const { createTransportAdapter } = require("../transports/transport-factory");
const {
  RealtimeTransportAdapter,
  extractWavPcm16,
  encodeWavFromPcm16
} = require("../transports/realtime-transport-adapter");
const { OpenAiSttTurnStream } = require("../openai-stt-service");
const { SemanticTurnDetector } = require("../semantic-turn-detector");
const {
  extractCommandByWakeWord,
  countWords,
  isLikelyIncompleteFragment,
  isLikelyGreetingOrPing,
  normalizeText,
  normalizeComparableText,
  normalizeLooseComparableText
} = require("../utils/text-utils");
const { withTimeout } = require("../utils/async-utils");
const {
  buildSystemPrompt,
  normalizeProjectContext
} = require("../prompts/prompt-builder");
const { summarizeCallWithGraph } = require("../workflows/call-summary-graph");
const { log, warn, error } = require("../logger");
const { validateSessionConfig } = require("../config");

function createSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortErrorLike(err) {
  return (
    err?.name === "AbortError" ||
    err?.code === "ABORT_ERR" ||
    /abort/i.test(String(err?.message || ""))
  );
}

function stripControlTokens(text, completionToken) {
  const value = normalizeText(text);
  if (!value) {
    return "";
  }
  if (!completionToken) {
    return value;
  }

  const escapedToken = String(completionToken)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .trim();
  if (!escapedToken) {
    return value;
  }

  const pattern = new RegExp(escapedToken, "gi");
  return normalizeText(value.replace(pattern, " "));
}

function hasCompletionToken(text, completionToken) {
  const value = normalizeText(text);
  const token = normalizeText(completionToken);
  if (!value || !token) {
    return false;
  }
  return value.toLowerCase().includes(token.toLowerCase());
}

function tokenizeComparableWords(text) {
  return normalizeLooseComparableText(text)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function hasBudgetSignal(text) {
  const value = normalizeLooseComparableText(text);
  if (!value) {
    return false;
  }
  return (
    /\d/.test(value) ||
    /\b(budget|usd|dollar|dollars|eur|euro|gbp|pound|k|m)\b/i.test(value) ||
    /[$€£]/.test(text)
  );
}

function hasNameSignal(text) {
  const value = normalizeLooseComparableText(text);
  if (!value) {
    return false;
  }
  return /\b(my name is|name is|call me|this is|i am|i'?m|im|i m)\b/i.test(value);
}

function hasExplicitNameValue(text) {
  const value = normalizeLooseComparableText(text);
  if (!value) {
    return false;
  }

  const match = value.match(
    /\b(?:my name is|name is|call me|this is|i am|i'?m|im|i m)\s+(.+)$/i
  );
  if (!match) {
    return false;
  }

  const tail = normalizeText(match[1]);
  if (!tail) {
    return false;
  }
  if (/^[\d\W]+$/.test(tail)) {
    return false;
  }
  if (/^(uh|um|hmm|huh|well|like)$/i.test(tail)) {
    return false;
  }

  return countWords(tail) <= 6;
}

function hasExplicitBudgetValue(text) {
  const raw = String(text || "");
  const value = normalizeLooseComparableText(text);
  if (!value) {
    return false;
  }

  if (/\d/.test(value) || /[$€£]/.test(raw)) {
    return true;
  }

  if (
    /\b(usd|dollar|dollars|eur|euro|gbp|pound|pounds|k|m|thousand|million|billion)\b/i.test(
      value
    )
  ) {
    return true;
  }

  const match = value.match(
    /\b(?:my project budget is|project budget is|my budget is|budget is|budget)\s+(.+)$/i
  );
  if (!match) {
    return false;
  }

  const tail = normalizeText(match[1]);
  if (!tail) {
    return false;
  }
  if (/^(about|around|approximately|approx|roughly|like|maybe)$/i.test(tail)) {
    return false;
  }

  return /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/i.test(
    tail
  );
}

function isLikelyIncompleteIntakeStub(text) {
  const value = normalizeLooseComparableText(text);
  if (!value) {
    return false;
  }

  if (
    /\b(?:my name is|name is|call me|this is|i am|i'?m|im|i m)\s*$/.test(value) ||
    /\b(?:my project budget is|project budget is|my budget is|budget is)\s*(?:about|around|approximately|approx|roughly)?\s*$/.test(
      value
    )
  ) {
    return true;
  }

  const incompleteByShape = isLikelyIncompleteFragment(text, {
    minWordsForComplete: 4
  });
  if (!incompleteByShape) {
    return false;
  }

  if (hasNameSignal(text) && !hasExplicitNameValue(text)) {
    return true;
  }
  if (hasBudgetSignal(text) && !hasExplicitBudgetValue(text)) {
    return true;
  }

  return false;
}

function computeJaccardSimilarity(tokensA, tokensB) {
  if (!Array.isArray(tokensA) || !Array.isArray(tokensB)) {
    return 0;
  }
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...a, ...b]).size;
  if (union === 0) {
    return 0;
  }
  return intersection / union;
}

function isBridgeTransportError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return (
    message.includes("detached frame") ||
    message.includes("execution context was destroyed") ||
    message.includes("cannot find context with specified id") ||
    message.includes("target closed") ||
    message.includes("session closed")
  );
}

function isWithinTurnStitchWindow(baseAtMs, nextAtMs, windowMs) {
  const base = Number(baseAtMs);
  const next = Number(nextAtMs);
  const window = Math.max(0, Number(windowMs) || 0);
  if (!Number.isFinite(base) || !Number.isFinite(next)) {
    return false;
  }
  return Math.abs(next - base) <= window;
}

function mergeUserContinuationText(baseText, continuationText) {
  const base = normalizeText(baseText);
  const continuation = normalizeText(continuationText);
  if (!base) {
    return continuation;
  }
  if (!continuation) {
    return base;
  }

  const baseComparable = normalizeComparableText(base);
  const continuationComparable = normalizeComparableText(continuation);
  if (!baseComparable || !continuationComparable) {
    return normalizeText(`${base} ${continuation}`);
  }

  if (continuationComparable.startsWith(baseComparable)) {
    return continuation;
  }
  if (baseComparable.startsWith(continuationComparable)) {
    return base;
  }

  return normalizeText(`${base} ${continuation}`);
}

function isComparablePrefixMatch(seedText, finalText) {
  const seedComparable = normalizeComparableText(seedText);
  const finalComparable = normalizeComparableText(finalText);
  if (!seedComparable || !finalComparable) {
    return false;
  }
  return (
    finalComparable.startsWith(seedComparable) ||
    seedComparable.startsWith(finalComparable)
  );
}

function truncateForLog(text, maxChars = 180) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }
  const limit = Math.max(24, Number(maxChars) || 180);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

const REALTIME_PLAYBACK_IDLE_FLUSH_MS = 24;
const REALTIME_PLAYBACK_MULTIPLIER = 3.5;
const REALTIME_PLAYBACK_MAX_MULTIPLIER = 7;

function msToPcm16Bytes(sampleRateHz, durationMs) {
  const rate = Math.max(8000, Math.trunc(Number(sampleRateHz) || 24000));
  const ms = Math.max(1, Math.trunc(Number(durationMs) || 1));
  const raw = Math.max(2, Math.round((rate * 2 * ms) / 1000));
  return raw % 2 === 0 ? raw : raw + 1;
}

function pcm16BytesToMs(byteLength, sampleRateHz) {
  const rate = Math.max(8000, Math.trunc(Number(sampleRateHz) || 24000));
  const bytes = Math.max(0, Math.trunc(Number(byteLength) || 0));
  if (!bytes) {
    return 0;
  }
  return Math.max(1, Math.round((bytes / 2 / rate) * 1000));
}

class BotSession {
  constructor({ config, sessionId } = {}) {
    this.baseConfig = config;
    this.sessionId = sessionId || createSessionId();

    this.status = "idle";
    this.startedAt = null;
    this.stoppedAt = null;
    this.lastError = null;
    this.startedAtMs = 0;

    this.sessionConfig = null;

    this.server = null;
    this.browser = null;
    this.transportAdapter = null;
    this.bridgePage = null;
    this.meetPage = null;
    this.meetJoinState = null;
    this.processQueueHandler = null;

    this.queue = [];
    this.maxQueueSize = 60;
    this.conversationTurns = [];
    this.maxConversationTurns = 180;
    this.lastSourceActivityAtMs = {};
    this.isProcessing = false;
    this.isStopping = false;
    this.stopPromise = null;
    this.lastQueueDropWarnAtMs = 0;

    this.lastAcceptedText = "";
    this.lastAcceptedAtMs = 0;
    this.lastUserTurnText = "";
    this.pendingContinuationBaseText = "";
    this.pendingContinuationSetAtMs = 0;
    this.activeAssistantRun = null;
    this.recentBotOutputs = [];
    this.lastInboundBySource = {};
    this.isAssistantAudioPlaying = false;
    this.lastAssistantAudioAtMs = 0;
    this.bridgeBindings = null;
    this.openAiSttStream = null;
    this.realtimeAdapter = null;
    this.requestedVoicePipelineMode = "hybrid";
    this.activeVoicePipelineMode = "";
    this.realtimeResponseInProgress = false;
    this.realtimeCurrentResponseId = "";
    this.realtimePendingUserTurnText = "";
    this.realtimeUserTurnByResponseId = {};
    this.realtimeAssistantTextByResponseId = {};
    this.realtimeAudioPlaybackChain = Promise.resolve();
    this.realtimeAudioPlaybackGeneration = 0;
    this.realtimePlaybackPcmBuffer = Buffer.alloc(0);
    this.realtimePlaybackSampleRateHz = 0;
    this.realtimePlaybackCurrentResponseId = "";
    this.realtimePlaybackFirstChunkSent = false;
    this.realtimePlaybackIdleFlushTimer = null;
    this.activeSttSource = "";
    this.lastBridgeRecoveryAtMs = 0;
    this.hasProcessedUserTurn = false;
    this.autoGreetingInFlight = false;
    this.autoGreetingCompleted = false;
    this.softInterruptActive = false;
    this.softInterruptRunId = "";
    this.softInterruptSource = "";
    this.softInterruptTimer = null;
    this.semanticTurnDetector = null;
    this.speculativePrefetch = null;
    this.latestPartialsBySource = {};
    this.joinStateMonitorStopRequested = false;
    this.joinStateMonitorPromise = null;
    this.responder = null;
  }

  getStatus() {
    return {
      sessionId: this.sessionId,
      status: this.status,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      meetUrl: this.sessionConfig?.meetUrl || null,
      voicePipelineMode:
        this.activeVoicePipelineMode ||
        this.requestedVoicePipelineMode ||
        this.sessionConfig?.voicePipelineMode ||
        "hybrid",
      sttSource: this.activeSttSource || this.sessionConfig?.openaiSttSource || null,
      hasProjectContext: Boolean(this.sessionConfig?.projectContext),
      queueSize: this.queue.length,
      isProcessing: this.isProcessing,
      lastError: this.lastError
    };
  }

  async start({ meetUrl, projectContext } = {}) {
    if (this.status === "starting" || this.status === "running") {
      throw new Error("Session is already running.");
    }

    const contextCandidate =
      projectContext !== undefined ? projectContext : this.baseConfig.projectContext;
    const effectiveProjectContext = normalizeProjectContext(contextCandidate);

    this.sessionConfig = {
      ...this.baseConfig,
      meetUrl: meetUrl || this.baseConfig.meetUrl,
      projectContext: effectiveProjectContext
    };
    this.conversationTurns = [];
    this.maxConversationTurns = Math.max(
      40,
      Number(this.sessionConfig.callSummaryMaxTurns || 40) * 3
    );
    this.lastSourceActivityAtMs = {};
    this.lastAcceptedText = "";
    this.lastAcceptedAtMs = 0;
    this.lastUserTurnText = "";
    this.pendingContinuationBaseText = "";
    this.pendingContinuationSetAtMs = 0;
    this.activeAssistantRun = null;
    this.recentBotOutputs = [];
    this.lastInboundBySource = {};
    this.isAssistantAudioPlaying = false;
    this.lastAssistantAudioAtMs = 0;
    this.bridgeBindings = null;
    this.openAiSttStream = null;
    this.realtimeAdapter = null;
    this.requestedVoicePipelineMode =
      this.sessionConfig?.voicePipelineMode || "hybrid";
    this.activeVoicePipelineMode = "";
    this.realtimeResponseInProgress = false;
    this.realtimeCurrentResponseId = "";
    this.realtimePendingUserTurnText = "";
    this.realtimeUserTurnByResponseId = {};
    this.realtimeAssistantTextByResponseId = {};
    this.realtimeAudioPlaybackChain = Promise.resolve();
    this.realtimeAudioPlaybackGeneration = 0;
    this.realtimePlaybackPcmBuffer = Buffer.alloc(0);
    this.realtimePlaybackSampleRateHz = 0;
    this.realtimePlaybackCurrentResponseId = "";
    this.realtimePlaybackFirstChunkSent = false;
    this.clearRealtimePlaybackIdleFlushTimer();
    this.activeSttSource = "";
    this.lastBridgeRecoveryAtMs = 0;
    this.hasProcessedUserTurn = false;
    this.autoGreetingInFlight = false;
    this.autoGreetingCompleted = false;
    this.softInterruptActive = false;
    this.softInterruptRunId = "";
    this.softInterruptSource = "";
    this.softInterruptTimer = null;

    const sessionSystemPrompt = buildSystemPrompt({
      basePrompt: this.sessionConfig.systemPrompt,
      projectContext: this.sessionConfig.projectContext,
      responseLanguage: this.sessionConfig.language
    });

    const missing = validateSessionConfig(this.sessionConfig, {
      requireMeetUrl: true
    });
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}`
      );
    }

    this.status = "starting";
    this.startedAt = new Date().toISOString();
    this.startedAtMs = Date.now();
    this.stoppedAt = null;
    this.lastError = null;
    this.trace(
      `Session config: source=${this.sessionConfig.openaiSttSource}, sttModel=${this.sessionConfig.openaiSttModel}, voicePipelineMode=${this.requestedVoicePipelineMode}, turnSilenceMs=${this.sessionConfig.turnSilenceMs}, continuationSilenceMs=${this.sessionConfig.turnContinuationSilenceMs}, postTurnDelayMs=${this.sessionConfig.postTurnResponseDelayMs}, bargeInEnabled=${this.sessionConfig.bargeInEnabled}, softInterruptEnabled=${this.sessionConfig.softInterruptEnabled}.`
    );

    this.info("Starting bridge server...");
    const { server } = await startBridgeServer(
      this.sessionConfig.bridgePort,
      this.sessionConfig.bridgeHost
    );
    this.server = server;

    this.info("Starting AI responder...");
    const responder = new OpenAIResponder({
      apiKey: this.sessionConfig.openaiApiKey,
      model: this.sessionConfig.openaiModel,
      ttsModel: this.sessionConfig.openaiTtsModel,
      ttsVoice: this.sessionConfig.openaiTtsVoice,
      ttsFormat: this.sessionConfig.openaiTtsFormat,
      systemPrompt: sessionSystemPrompt,
      maxUserMessageChars: this.sessionConfig.maxUserMessageChars,
      maxAssistantReplyChars: this.sessionConfig.maxAssistantReplyChars,
      maxHistoryMessages: this.sessionConfig.maxHistoryMessages,
      temperature: this.sessionConfig.openaiTemperature,
      streamChunkMinChars: this.sessionConfig.replyChunkMinChars,
      streamChunkTargetChars: this.sessionConfig.replyChunkTargetChars,
      streamChunkMaxChars: this.sessionConfig.replyChunkMaxChars,
      streamChunkMaxLatencyMs: this.sessionConfig.replyChunkMaxLatencyMs
    });
    this.responder = responder;
    this.semanticTurnDetector = new SemanticTurnDetector({
      enabled: this.sessionConfig.semanticEotEnabled,
      useLlm: this.sessionConfig.semanticEotUseLlm,
      apiKey: this.sessionConfig.openaiApiKey,
      model: this.sessionConfig.semanticEotModel,
      timeoutMs: this.sessionConfig.semanticEotTimeoutMs,
      minDelayMs: this.sessionConfig.semanticEotMinDelayMs,
      maxDelayMs: this.sessionConfig.semanticEotMaxDelayMs
    });
    if (this.sessionConfig.semanticEotEnabled) {
      this.info(
        `Semantic EoT enabled (llm=${Boolean(
          this.sessionConfig.semanticEotUseLlm
        )}, model=${this.sessionConfig.semanticEotModel}, minDelayMs=${this.sessionConfig.semanticEotMinDelayMs}, maxDelayMs=${this.sessionConfig.semanticEotMaxDelayMs}).`
      );
    }
    this.processQueueHandler = async () => {
      await this.processQueue(responder);
    };

    this.info(
      `TTS mode: OpenAI (${this.sessionConfig.openaiTtsModel}, voice=${this.sessionConfig.openaiTtsVoice}, format=${this.sessionConfig.openaiTtsFormat})`
    );
    if (this.sessionConfig.projectContext) {
      this.info("Project context attached to this session.");
    }

    const handleBridgeEvent = (event = {}) => {
      const source = normalizeText(event.source || "openai-stt") || "openai-stt";
      const type = normalizeText(event.type || "").toLowerCase();
      const text = normalizeText(event.text || "");
      const isRealtimeSource = source === "openai-realtime";

      if (text) {
        this.markSourceActivity(source);
      }

      if (isRealtimeSource && type === "assistant.audio.chunk") {
        this.queueRealtimeAudioPlayback(event);
        return;
      }

      if (isRealtimeSource && type === "assistant.response.started") {
        this.handleRealtimeResponseStarted(event);
        return;
      }

      if (isRealtimeSource && type === "assistant.text.final") {
        this.handleRealtimeAssistantTextFinal(event);
        return;
      }

      if (isRealtimeSource && type === "assistant.response.done") {
        this.handleRealtimeResponseDone(event);
        return;
      }

      if (isRealtimeSource && type === "realtime.error") {
        this.warn(
          `Realtime transport event: ${normalizeText(event.reason || "unknown error")}.`
        );
        return;
      }

      if (type === "vad.start") {
        this.markSourceActivity(source);
        const peak = Number.isFinite(Number(event.peak))
          ? Number(event.peak).toFixed(4)
          : "n/a";
        this.trace(
          `Bridge event (${source}): vad.start (reason=${normalizeText(
            event.reason || "n/a"
          ) || "n/a"}, peak=${peak}).`
        );
        const realtimeVadSource =
          isRealtimeSource ||
          (this.isRealtimePipelineActive() && source === "openai-stt");
        if (realtimeVadSource && this.sessionConfig?.softInterruptEnabled) {
          this.setBridgeTtsDucking(true);
        }
        this.maybeStartSoftInterrupt({
          source,
          reason: normalizeText(event.reason || "vad-start") || "vad-start"
        });
        return;
      }

      if (type === "vad.confirmed") {
        const peak = Number.isFinite(Number(event.peak))
          ? Number(event.peak).toFixed(4)
          : "n/a";
        const speechMs = Number.isFinite(Number(event.speechMs))
          ? Math.max(0, Math.trunc(Number(event.speechMs)))
          : 0;
        this.trace(
          `Bridge event (${source}): vad.confirmed (speechMs=${speechMs}, peak=${peak}, reason=${normalizeText(
            event.reason || "n/a"
          ) || "n/a"}).`
        );
        if (isRealtimeSource) {
          this.handleRealtimeConfirmedVadBargeIn({
            source,
            reason: normalizeText(event.reason || "vad-confirmed") || "vad-confirmed",
            speechMs,
            peak: Number(event.peak || 0)
          });
          return;
        }
        this.handleConfirmedVadBargeIn({
          source,
          reason: normalizeText(event.reason || "vad-confirmed") || "vad-confirmed",
          speechMs,
          peak: Number(event.peak || 0)
        });
        return;
      }

      if (type === "vad.stop") {
        this.trace(
          `Bridge event (${source}): vad.stop (reason=${normalizeText(
            event.reason || "n/a"
          ) || "n/a"}).`
        );
        const realtimeVadSource =
          isRealtimeSource ||
          (this.isRealtimePipelineActive() && source === "openai-stt");
        if (realtimeVadSource && this.sessionConfig?.softInterruptEnabled) {
          this.setBridgeTtsDucking(false);
        }
        this.handleSoftInterruptStop({
          source,
          reason: normalizeText(event.reason || "vad-stop") || "vad-stop"
        });
        return;
      }

      if (type === "transcript.partial" && text) {
        this.latestPartialsBySource[source] = {
          text,
          at: Date.now()
        };
        if (this.sessionConfig?.openaiSttLogPartials) {
          this.stt(`[${source}] partial: ${text}`);
        }
        if (!isRealtimeSource && this.sessionConfig?.partialSpeculationEnabled) {
          void this.maybeStartSpeculativePrefetch({
            source,
            text,
            responder
          });
        }
        if (this.sessionConfig?.bargeInOnPartials) {
          if (isRealtimeSource) {
            if (this.realtimeResponseInProgress) {
              void this.interruptRealtimeOutput(
                `barge-in:${source}:partial-transcript`,
                {
                  source,
                  text
                }
              );
            }
          } else {
            this.maybeInterruptAssistantOutput({
              source,
              text,
              reason: "partial-transcript"
            });
          }
        }
        return;
      }

      const isOpenAiTranscriptFinal =
        source === "openai-stt" && type === "transcript.final";
      if (isOpenAiTranscriptFinal) {
        return;
      }

      if (type === "turn.final" || type === "transcript.final") {
        if (this.sessionConfig?.openaiSttLogFinals) {
          this.stt(`[${source}] final: ${text}`);
        }
        if (!text) {
          this.trace(`Ignored final transcript from ${source}: empty text.`);
          return;
        }
        if (this.isLikelyBotEcho(text)) {
          this.trace(
            `Ignored final transcript from ${source}: detected as bot echo ("${truncateForLog(
              text,
              120
            )}").`
          );
          return;
        }
        if (isRealtimeSource) {
          this.handleRealtimeUserFinal({
            source,
            text
          });
          return;
        }
        const accepted = this.enqueueTranscript(text, source, {
          isTurnFinal: true,
          receivedAtMs: event.ts,
          segmentDurationMs: event.segmentDurationMs
        });
        this.latestPartialsBySource[source] = {
          text,
          at: Date.now()
        };
        if (!accepted) {
          return;
        }
        this.maybeInterruptAssistantOutput({
          source,
          text,
          reason: "final-turn"
        });
        return;
      }
    };

    try {
      this.info("Launching browser...");
      this.browser = await launchBrowser(this.sessionConfig);

      this.bridgeBindings = {
        onAudioChunk: (payload) => {
          if (this.isRealtimePipelineActive() && this.realtimeAdapter) {
            void this.realtimeAdapter.appendAudioChunk(payload).catch((err) => {
              this.warn(`Realtime input audio append failed: ${err?.message || err}`);
            });
            return;
          }
          this.openAiSttStream?.enqueueChunk(payload);
        },
        onBridgeLog: (line) => this.bridge(line),
        onBridgeEvent: handleBridgeEvent
      };

      this.transportAdapter = createTransportAdapter({
        type: "meet",
        browser: this.browser,
        config: this.sessionConfig,
        bridgeBindings: this.bridgeBindings
      });

      this.info("Opening bridge page...");
      this.info("Opening Google Meet...");
      const transportState = await this.transportAdapter.start();
      this.bridgePage =
        transportState?.bridgePage || this.transportAdapter.getBridgePage();
      this.meetPage = transportState?.meetPage || this.transportAdapter.getMeetPage();
      const meetJoinState =
        transportState?.joinState || this.transportAdapter.getJoinState();
      this.meetJoinState = meetJoinState || null;

      if (meetJoinState?.status === "joined") {
        this.info("Meet joined successfully.");
      } else if (meetJoinState?.status === "auth_required") {
        const joinUrl = String(meetJoinState?.url || this.sessionConfig.meetUrl || "");
        if (this.sessionConfig?.meetAssumeLoggedIn) {
          this.warn(
            `Meet reported auth_required (${joinUrl}), but MEET_ASSUME_LOGGED_IN=true so startup will continue.`
          );
        } else {
          throw new Error(
            `Meet authentication is required before joining (${joinUrl}). Log in with the same CHROME_USER_DATA_DIR and retry.`
          );
        }
      } else {
        this.info(
          `Meet page ready (join attempt executed, state=${String(
            meetJoinState?.status || "unknown"
          )}, url=${String(meetJoinState?.url || this.sessionConfig.meetUrl || "")}).`
        );
      }

      const buildBridgeSttOptions = ({ realtime = false } = {}) => ({
        chunkMs: this.sessionConfig.openaiSttChunkMs,
        partialsEnabled: realtime
          ? true
          : this.sessionConfig.openaiSttPartialsEnabled,
        partialEmitMs: this.sessionConfig.openaiSttPartialEmitMs,
        mimeType: this.sessionConfig.openaiSttMimeType,
        deviceId: this.sessionConfig.openaiSttDeviceId,
        deviceLabel: this.sessionConfig.openaiSttDeviceLabel,
        preferLoopback: this.sessionConfig.openaiSttPreferLoopback,
        audioBitsPerSecond: this.sessionConfig.openaiSttAudioBitsPerSecond,
        minSignalPeak: this.sessionConfig.openaiSttMinSignalPeak,
        vadThreshold: this.sessionConfig.openaiSttVadThreshold,
        hangoverMs: this.sessionConfig.openaiSttHangoverMs,
        segmentMinMs: this.sessionConfig.openaiSttSegmentMinMs,
        segmentMaxMs: this.sessionConfig.openaiSttSegmentMaxMs,
        bargeInMinMs: this.sessionConfig.bargeInMinMs
      });

      const requestedRealtime = this.requestedVoicePipelineMode === "realtime";
      if (requestedRealtime) {
        try {
          this.info(
            `Starting realtime voice pipeline (model=${this.sessionConfig.openaiRealtimeModel}, turnDetection=${this.sessionConfig.openaiRealtimeTurnDetection}).`
          );
          this.realtimeAdapter = new RealtimeTransportAdapter({
            apiKey: this.sessionConfig.openaiApiKey,
            model: this.sessionConfig.openaiRealtimeModel,
            language: this.sessionConfig.openaiSttLanguage,
            instructions: sessionSystemPrompt,
            voice: this.sessionConfig.openaiTtsVoice,
            temperature: this.sessionConfig.openaiTemperature,
            inputSampleRateHz: this.sessionConfig.openaiRealtimeInputSampleRateHz,
            outputSampleRateHz: this.sessionConfig.openaiRealtimeOutputSampleRateHz,
            outputChunkMs: this.sessionConfig.openaiRealtimeOutputChunkMs,
            connectTimeoutMs: this.sessionConfig.openaiRealtimeConnectTimeoutMs,
            inputTranscriptionModel:
              this.sessionConfig.openaiRealtimeInputTranscriptionModel,
            turnDetection: this.sessionConfig.openaiRealtimeTurnDetection,
            turnDetectionEagerness:
              this.sessionConfig.openaiRealtimeTurnEagerness,
            vadThreshold: this.sessionConfig.openaiRealtimeVadThreshold,
            vadSilenceMs: this.sessionConfig.openaiRealtimeVadSilenceMs,
            vadPrefixPaddingMs: this.sessionConfig.openaiRealtimeVadPrefixPaddingMs,
            interruptResponseOnTurn:
              this.sessionConfig.openaiRealtimeInterruptResponseOnTurn,
            bargeInMinMs: this.sessionConfig.bargeInMinMs,
            onEvent: handleBridgeEvent,
            onLog: (line) => this.bridge(line)
          });
          await this.realtimeAdapter.start();

          const realtimeSttStarted = await this.transportAdapter.startStt(
            buildBridgeSttOptions({ realtime: true })
          );
          if (!realtimeSttStarted) {
            throw new Error(
              "Bridge audio capture could not be started for realtime pipeline."
            );
          }

          this.activeVoicePipelineMode = "realtime";
          this.activeSttSource = "bridge-input-realtime";
          this.openAiSttStream = null;
          this.info(
            "Realtime voice pipeline is active (WS Realtime API with bridge audio input)."
          );
          if (normalizeText(this.sessionConfig?.wakeWord)) {
            this.warn(
              "WAKE_WORD filtering is not enforced in realtime mode; apply wake-word behavior in system prompt if needed."
            );
          }
        } catch (realtimeError) {
          const message = realtimeError?.message || realtimeError;
          if (!this.sessionConfig.voicePipelineFallbackToHybrid) {
            throw realtimeError;
          }

          this.warn(
            `Realtime pipeline failed (${message}); falling back to hybrid STT->LLM->TTS pipeline.`
          );
          if (this.realtimeAdapter) {
            try {
              await this.realtimeAdapter.stop();
            } catch (_) {
              // Ignore realtime adapter shutdown errors during fallback.
            }
            this.realtimeAdapter = null;
          }
        }
      }

      if (this.activeVoicePipelineMode !== "realtime") {
        const openAiTurnSilenceMs = Math.max(
          150,
          Number(this.sessionConfig.turnSilenceMs || 700)
        );
        this.openAiSttStream = new OpenAiSttTurnStream({
          turnSilenceMs: openAiTurnSilenceMs,
          apiKey: this.sessionConfig.openaiApiKey,
          model: this.sessionConfig.openaiSttModel,
          language: this.sessionConfig.openaiSttLanguage,
          timeoutMs: this.sessionConfig.openaiSttTimeoutMs,
          maxRetries: this.sessionConfig.openaiSttMaxRetries,
          minChunkBytes: this.sessionConfig.openaiSttMinChunkBytes,
          maxQueueChunks: this.sessionConfig.openaiSttMaxQueueChunks,
          onEvent: handleBridgeEvent,
          onLog: (line) => this.bridge(line)
        });
        this.info(
          `OpenAI STT turn settings: turnSilenceMs=${openAiTurnSilenceMs}, vadThreshold=${this.sessionConfig.openaiSttVadThreshold}, hangoverMs=${this.sessionConfig.openaiSttHangoverMs}, segmentMinMs=${this.sessionConfig.openaiSttSegmentMinMs}, segmentMaxMs=${this.sessionConfig.openaiSttSegmentMaxMs}, partialsEnabled=${this.sessionConfig.openaiSttPartialsEnabled}, partialEmitMs=${this.sessionConfig.openaiSttPartialEmitMs}.`
        );
        const started = await this.transportAdapter.startStt(
          buildBridgeSttOptions({ realtime: false })
        );
        if (!started) {
          throw new Error(
            "OpenAI STT audio capture could not be started in bridge page."
          );
        }
        this.info(
          `OpenAI STT turn streaming enabled (model=${this.sessionConfig.openaiSttModel}).`
        );
        this.activeVoicePipelineMode = "hybrid";
        this.activeSttSource = "bridge-input";
      }

      this.status = "running";
      if (this.activeVoicePipelineMode === "realtime") {
        this.info("Bot is running in realtime mode.");
      } else {
        this.info(
          "Bot is running. If WAKE_WORD is set, only phrases containing it will be processed."
        );
      }
      this.startJoinStateMonitor({ responder });
      void this.runAutoGreeting({ responder });
      return this.getStatus();
    } catch (err) {
      this.lastError = err?.stack || err?.message || String(err);
      this.status = "error";
      this.error(this.lastError);
      await this.stop({ reason: "startup failure" });
      throw err;
    }
  }

  async stop({ reason = "manual stop" } = {}) {
    if (this.isStopping) {
      return this.stopPromise;
    }

    if (this.status === "idle" || this.status === "stopped") {
      return this.getStatus();
    }

    this.isStopping = true;
    this.status = "stopping";

    this.stopPromise = (async () => {
      this.info(`Shutting down (${reason})...`);
      try {
        this.clearSpeculativePrefetch("session-stop");
        this.clearSoftInterrupt({ resumeAudio: true });
        await this.interruptAssistantRun("session-stop");
        await this.stopJoinStateMonitor();
        if (this.openAiSttStream) {
          try {
            this.openAiSttStream.stop({ flush: false });
          } catch (_) {
            // Ignore OpenAI STT stop errors.
          }
          this.openAiSttStream = null;
        }
        if (this.realtimeAdapter) {
          try {
            await this.realtimeAdapter.stop();
          } catch (_) {
            // Ignore realtime adapter stop errors.
          }
          this.realtimeAdapter = null;
        }

        this.queue = [];
        this.processQueueHandler = null;
        this.activeAssistantRun = null;
        const summaryTurns = this.conversationTurns.slice();
        this.conversationTurns = [];
        this.lastSourceActivityAtMs = {};
        this.recentBotOutputs = [];
        this.lastInboundBySource = {};
        this.isAssistantAudioPlaying = false;
        this.lastAssistantAudioAtMs = 0;
        this.bridgeBindings = null;
        this.requestedVoicePipelineMode = "hybrid";
        this.activeVoicePipelineMode = "";
        this.realtimeResponseInProgress = false;
        this.realtimeCurrentResponseId = "";
        this.realtimePendingUserTurnText = "";
        this.realtimeUserTurnByResponseId = {};
        this.realtimeAssistantTextByResponseId = {};
        this.realtimeAudioPlaybackChain = Promise.resolve();
        this.realtimeAudioPlaybackGeneration = 0;
        this.realtimePlaybackPcmBuffer = Buffer.alloc(0);
        this.realtimePlaybackSampleRateHz = 0;
        this.realtimePlaybackCurrentResponseId = "";
        this.realtimePlaybackFirstChunkSent = false;
        this.clearRealtimePlaybackIdleFlushTimer();
        this.activeSttSource = "";
        this.lastBridgeRecoveryAtMs = 0;
        this.hasProcessedUserTurn = false;
        this.startedAtMs = 0;
        this.responder = null;
        this.lastAcceptedText = "";
        this.lastAcceptedAtMs = 0;
        this.lastUserTurnText = "";
        this.pendingContinuationBaseText = "";
        this.pendingContinuationSetAtMs = 0;
        this.softInterruptActive = false;
        this.softInterruptRunId = "";
        this.softInterruptSource = "";
        this.softInterruptTimer = null;
        this.semanticTurnDetector = null;
        this.speculativePrefetch = null;
        this.latestPartialsBySource = {};

        if (this.transportAdapter) {
          try {
            const stopResult = await withTimeout(
              this.transportAdapter.stop({ leaveMeet: true }),
              12000,
              "Transport stop"
            );
            if (stopResult?.hasLeftCall) {
              this.info("Left Meet call before shutdown.");
            } else {
              this.warn(
                "Could not confirm Meet leave action before shutdown; continuing."
              );
            }
          } catch (transportStopErr) {
            this.warn(
              `Transport stop failed; continuing shutdown: ${
                transportStopErr?.message || transportStopErr
              }`
            );
          }
          this.transportAdapter = null;
        }
        this.bridgePage = null;
        this.meetPage = null;
        this.meetJoinState = null;

        if (this.browser) {
          try {
            await withTimeout(this.browser.close(), 8000, "Browser close");
          } catch (closeErr) {
            this.warn(
              `Browser close did not complete in time; forcing shutdown: ${
                closeErr?.message || closeErr
              }`
            );
            try {
              this.browser.process()?.kill("SIGKILL");
            } catch (_) {
              // Ignore kill errors.
            }
          }
          this.browser = null;
        }

        if (this.server) {
          await new Promise((resolve) => {
            this.server.close(() => resolve());
          });
          this.server = null;
        }

        await this.runCallSummaryWorkflow(summaryTurns);
      } finally {
        this.joinStateMonitorStopRequested = true;
        this.joinStateMonitorPromise = null;
        this.transportAdapter = null;
        this.realtimeAdapter = null;
        this.bridgePage = null;
        this.meetPage = null;
        this.meetJoinState = null;
        this.requestedVoicePipelineMode = "hybrid";
        this.activeVoicePipelineMode = "";
        this.realtimeResponseInProgress = false;
        this.realtimeCurrentResponseId = "";
        this.realtimePendingUserTurnText = "";
        this.realtimeUserTurnByResponseId = {};
        this.realtimeAssistantTextByResponseId = {};
        this.realtimeAudioPlaybackChain = Promise.resolve();
        this.realtimeAudioPlaybackGeneration = 0;
        this.realtimePlaybackPcmBuffer = Buffer.alloc(0);
        this.realtimePlaybackSampleRateHz = 0;
        this.realtimePlaybackCurrentResponseId = "";
        this.realtimePlaybackFirstChunkSent = false;
        this.clearRealtimePlaybackIdleFlushTimer();
        this.activeSttSource = "";
        this.responder = null;
        this.lastAcceptedText = "";
        this.lastAcceptedAtMs = 0;
        this.lastUserTurnText = "";
        this.pendingContinuationBaseText = "";
        this.pendingContinuationSetAtMs = 0;
        this.semanticTurnDetector = null;
        this.speculativePrefetch = null;
        this.latestPartialsBySource = {};
        this.status = "stopped";
        this.stoppedAt = new Date().toISOString();
        this.isStopping = false;
        this.stopPromise = null;
      }

      this.info("Session stopped.");
      return this.getStatus();
    })();

    return this.stopPromise;
  }

  enqueueTranscript(
    text,
    source,
    { isTurnFinal = false, receivedAtMs, segmentDurationMs } = {}
  ) {
    const normalizedText = normalizeText(text);
    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    if (!normalizedText) {
      return false;
    }

    if (
      this.shouldDropInboundTranscript({
        source: normalizedSource,
        text: normalizedText
      })
    ) {
      return false;
    }

    this.markSourceActivity(normalizedSource);
    this.queue.push({
      text: normalizedText,
      source: normalizedSource,
      isTurnFinal: Boolean(isTurnFinal),
      receivedAtMs: Number.isFinite(Number(receivedAtMs))
        ? Number(receivedAtMs)
        : Date.now(),
      segmentDurationMs: Number.isFinite(Number(segmentDurationMs))
        ? Number(segmentDurationMs)
        : undefined
    });
    this.trace(
      `Enqueued transcript (${normalizedSource}, final=${Boolean(
        isTurnFinal
      )}, chars=${normalizedText.length}, queueSize=${this.queue.length}).`
    );
    if (this.queue.length > this.maxQueueSize) {
      this.queue.shift();
      const now = Date.now();
      if (now - this.lastQueueDropWarnAtMs > 3000) {
        this.warn(
          `Transcript queue overflow (> ${this.maxQueueSize}); dropping oldest item.`
        );
        this.lastQueueDropWarnAtMs = now;
      }
    }
    void this.processQueueHandler?.();
    return true;
  }

  shouldDropInboundTranscript({ source, text }) {
    if (!text) {
      this.traceInboundDrop({
        source,
        reason: "empty text",
        text
      });
      return true;
    }

    const key = normalizeText(source || "unknown") || "unknown";
    const now = Date.now();
    const loose = normalizeLooseComparableText(text);
    if (!loose) {
      this.traceInboundDrop({
        source: key,
        reason: "no comparable tokens",
        text
      });
      return true;
    }
    const tokens = tokenizeComparableWords(loose);

    const dedupWindowMs = Number(this.sessionConfig?.inboundDedupMs || 10000);
    const history = Array.isArray(this.lastInboundBySource[key])
      ? this.lastInboundBySource[key]
      : [];
    const activeHistory = history.filter((entry) => now - entry.at <= dedupWindowMs);
    const current = {
      loose,
      tokens,
      at: now
    };

    for (const previous of activeHistory) {
      if (previous.loose === loose) {
        this.traceInboundDrop({
          source: key,
          reason: "exact duplicate",
          text
        });
        return true;
      }

      const isCurrentExpansion =
        loose.length > previous.loose.length && loose.startsWith(previous.loose);
      if (isCurrentExpansion) {
        continue;
      }

      const isCurrentTruncatedRepeat =
        previous.loose.length > loose.length &&
        previous.loose.startsWith(loose) &&
        previous.loose.length - loose.length <= 14;
      if (isCurrentTruncatedRepeat) {
        this.traceInboundDrop({
          source: key,
          reason: "truncated repeat",
          text,
          extra: `(delta=${previous.loose.length - loose.length})`
        });
        return true;
      }

      const similarity = computeJaccardSimilarity(tokens, previous.tokens);
      const lengthDelta = Math.abs(loose.length - previous.loose.length);
      const maxLength = Math.max(loose.length, previous.loose.length);
      const minSimilarity = 0.94;
      if (
        similarity >= minSimilarity &&
        lengthDelta <= Math.max(8, maxLength * 0.25) &&
        tokens.length >= 4 &&
        previous.tokens.length >= 4
      ) {
        this.traceInboundDrop({
          source: key,
          reason: "near-duplicate by similarity",
          text,
          extra: `(similarity=${similarity.toFixed(2)}, lengthDelta=${lengthDelta})`
        });
        return true;
      }
    }

    activeHistory.push(current);
    this.lastInboundBySource[key] = activeHistory.slice(-8);
    return false;
  }

  async processQueue(responder) {
    if (
      this.isProcessing ||
      this.queue.length === 0 ||
      !this.bridgePage ||
      this.status !== "running"
    ) {
      return;
    }

    this.isProcessing = true;
    const item = this.queue.shift();
    if (item) {
      this.trace(
        `Processing queue item (${item.source}, final=${Boolean(
          item.isTurnFinal
        )}, remaining=${this.queue.length}): "${truncateForLog(
          item.text,
          120
        )}".`
      );
    }

    try {
      const normalized = normalizeText(item.text);
      if (!normalized) {
        return;
      }

      let commandText = extractCommandByWakeWord(
        normalized,
        this.sessionConfig.wakeWord
      );
      if (!commandText || commandText.length < 2) {
        this.trace(
          `Queue item ignored (${item.source}): wake word filter produced empty/short text ("${truncateForLog(
            normalized,
            120
          )}").`
        );
        return;
      }

      if (!item.isTurnFinal) {
        this.trace(
          `Queue item ignored (${item.source}): waiting for final turn transcript ("${truncateForLog(
            commandText,
            120
          )}").`
        );
        return;
      }

      const meetJoinStatus = normalizeText(this.meetJoinState?.status || "")
        .toLowerCase()
        .trim();
      const shouldIgnorePrejoin =
        meetJoinStatus === "prejoin" && !this.sessionConfig?.meetAssumeLoggedIn;
      const shouldIgnoreAuthRequired = meetJoinStatus === "auth_required";
      const shouldIgnoreUntilMeetJoined =
        item.source === "openai-stt" &&
        this.meetPage &&
        (shouldIgnorePrejoin || shouldIgnoreAuthRequired);
      if (shouldIgnoreUntilMeetJoined) {
        this.info(
          `Ignoring STT turn while Meet state=${meetJoinStatus || "unknown"}.`
        );
        return;
      }

      commandText = await this.waitForPostTurnResponseDelay({
        source: item.source,
        commandText,
        isFirstUserTurn: !this.hasProcessedUserTurn,
        initialTurnAtMs: item.receivedAtMs,
        initialSegmentDurationMs: item.segmentDurationMs
      });
      commandText = this.consumePendingUserContinuation({
        source: item.source,
        currentText: commandText
      });
      if (!commandText || commandText.length < 2) {
        this.trace(
          `Turn ignored (${item.source}): text became empty after continuation merge/wait.`
        );
        return;
      }
      if (
        isLikelyIncompleteFragment(commandText, {
          minWordsForComplete: 4
        }) &&
        countWords(commandText) <= 2 &&
        !(!this.hasProcessedUserTurn && isLikelyGreetingOrPing(commandText))
      ) {
        this.trace(
          `Turn ignored (${item.source}): too short/incomplete fragment after stabilization ("${truncateForLog(
            commandText,
            120
          )}").`
        );
        return;
      }

      const now = Date.now();
      if (
        commandText.toLowerCase() === this.lastAcceptedText.toLowerCase() &&
        now - this.lastAcceptedAtMs < 4000
      ) {
        this.trace(
          `Turn ignored (${item.source}): duplicate of recently accepted text within 4s ("${truncateForLog(
            commandText,
            120
          )}").`
        );
        return;
      }

      this.lastAcceptedText = commandText;
      this.lastAcceptedAtMs = now;
      this.hasProcessedUserTurn = true;
      if (item.source !== "system") {
        this.lastUserTurnText = commandText;
      }

      const sttToHandleMs = Number.isFinite(Number(item.receivedAtMs))
        ? Math.max(0, now - Number(item.receivedAtMs))
        : null;
      if (sttToHandleMs != null) {
        this.info(
          `Turn timing (${item.source}): stt-final-to-handle=${sttToHandleMs}ms.`
        );
      }

      this.user(`[${item.source}] ${commandText}`);
      this.trace(
        `Dispatching turn to responder (${item.source}, chars=${commandText.length}).`
      );
      const openingPrefetch = await this.consumeSpeculativePrefetch({
        source: item.source,
        commandText
      });
      await this.respondToCommand({
        responder,
        source: item.source,
        commandText,
        openingPrefetch
      });
    } catch (err) {
      this.error(err?.stack || err?.message || String(err));
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        void this.processQueue(responder);
      }
    }
  }

  startJoinStateMonitor({ responder }) {
    if (this.joinStateMonitorPromise) {
      return;
    }
    if (!this.transportAdapter || typeof this.transportAdapter.refreshJoinState !== "function") {
      return;
    }

    const pollMs = Math.max(
      300,
      Number(this.sessionConfig?.meetJoinPollMs || 1200)
    );
    this.joinStateMonitorStopRequested = false;
    this.trace(`Meet join-state monitor started (pollMs=${pollMs}).`);

    this.joinStateMonitorPromise = (async () => {
      while (!this.joinStateMonitorStopRequested) {
        if (
          this.status !== "running" ||
          this.isStopping ||
          !this.transportAdapter ||
          !this.meetPage ||
          this.meetPage.isClosed()
        ) {
          this.trace("Meet join-state monitor stopping: session/page is no longer active.");
          break;
        }

        await sleep(pollMs);
        if (this.joinStateMonitorStopRequested || this.status !== "running") {
          this.trace("Meet join-state monitor stopping: stop requested.");
          break;
        }

        let nextState = null;
        try {
          nextState = await this.transportAdapter.refreshJoinState();
        } catch (_) {
          continue;
        }
        if (!nextState || typeof nextState !== "object") {
          continue;
        }

        const previousStatus = String(this.meetJoinState?.status || "");
        const nextStatus = String(nextState.status || "");
        this.meetJoinState = nextState;

        if (nextStatus && nextStatus !== previousStatus) {
          this.info(
            `Meet join state updated: ${nextStatus}${
              nextState?.url ? ` (${nextState.url})` : ""
            }.`
          );
        }

        if (nextStatus === "joined") {
          this.trace("Meet join-state monitor detected joined status.");
          if (!this.hasProcessedUserTurn) {
            void this.runAutoGreeting({ responder });
          }
          break;
        }

        if (nextStatus === "auth_required") {
          if (!this.sessionConfig?.meetAssumeLoggedIn) {
            this.warn(
              "Meet session requires authentication; auto-greeting is paused until login is completed."
            );
            break;
          }
          continue;
        }
      }
    })()
      .catch((err) => {
        this.warn(`Meet join monitor stopped: ${err?.message || err}`);
      })
      .finally(() => {
        this.trace("Meet join-state monitor stopped.");
        this.joinStateMonitorPromise = null;
      });
  }

  async stopJoinStateMonitor() {
    this.joinStateMonitorStopRequested = true;
    const monitorPromise = this.joinStateMonitorPromise;
    if (!monitorPromise) {
      return;
    }
    this.trace("Waiting for meet join-state monitor to stop...");
    try {
      await Promise.race([monitorPromise, sleep(1200)]);
    } catch (_) {
      // Ignore monitor shutdown errors.
    }
    this.joinStateMonitorPromise = null;
  }

  async runAutoGreeting({ responder }) {
    if (!this.sessionConfig?.autoGreetingEnabled) {
      this.trace("Auto greeting skipped: disabled.");
      return;
    }
    if (this.autoGreetingCompleted || this.autoGreetingInFlight) {
      this.trace(
        `Auto greeting skipped: completed=${this.autoGreetingCompleted}, inFlight=${this.autoGreetingInFlight}.`
      );
      return;
    }

    const delayMs = Math.max(
      0,
      Number(this.sessionConfig.autoGreetingDelayMs || 0)
    );
    if (delayMs > 0) {
      this.trace(`Auto greeting waiting for configured delay (${delayMs}ms).`);
      await sleep(delayMs);
    }

    if (this.status !== "running" || this.isStopping) {
      this.trace("Auto greeting skipped: session is not running.");
      return;
    }
    if (this.meetJoinState?.status !== "joined") {
      this.trace(
        `Auto greeting skipped: Meet state is ${String(
          this.meetJoinState?.status || "unknown"
        )}.`
      );
      return;
    }
    if (this.hasProcessedUserTurn) {
      this.trace("Auto greeting skipped: user turn already captured.");
      return;
    }
    const hasPendingUserInput = this.queue.some((item) =>
      Boolean(normalizeText(item?.text || ""))
    );
    if (hasPendingUserInput) {
      this.trace("Auto greeting skipped: pending user transcript in queue.");
      return;
    }

    const prompt = normalizeText(this.sessionConfig.autoGreetingPrompt);
    if (!prompt) {
      this.trace("Auto greeting skipped: prompt is empty.");
      return;
    }

    this.autoGreetingInFlight = true;
    this.trace(
      `Auto greeting started (chars=${prompt.length}, source=system).`
    );
    try {
      if (this.isRealtimePipelineActive()) {
        const delivered = await this.realtimeAdapter?.createTextTurn({
          role: "system",
          text: prompt,
          createResponse: true
        });
        if (!delivered) {
          throw new Error("Realtime auto greeting was not delivered.");
        }
      } else {
        await this.respondToCommand({
          responder,
          source: "system",
          commandText: prompt
        });
      }
      this.autoGreetingCompleted = true;
      this.trace("Auto greeting completed.");
    } catch (err) {
      this.warn(`Auto greeting failed: ${err?.message || err}`);
    } finally {
      this.autoGreetingInFlight = false;
    }
  }

  isRealtimePipelineActive() {
    return (
      this.activeVoicePipelineMode === "realtime" &&
      this.realtimeAdapter &&
      this.status !== "stopped"
    );
  }

  clearRealtimePlaybackIdleFlushTimer() {
    if (!this.realtimePlaybackIdleFlushTimer) {
      return;
    }
    clearTimeout(this.realtimePlaybackIdleFlushTimer);
    this.realtimePlaybackIdleFlushTimer = null;
  }

  getRealtimePlaybackChunkTargets(sampleRateHz = 24000) {
    const baseChunkMs = Math.max(
      60,
      Math.trunc(Number(this.sessionConfig?.openaiRealtimeOutputChunkMs || 120))
    );
    const firstChunkMs = Math.max(80, Math.min(220, baseChunkMs));
    const steadyChunkMs = Math.max(
      firstChunkMs + 80,
      Math.min(900, Math.round(baseChunkMs * REALTIME_PLAYBACK_MULTIPLIER))
    );
    const maxBufferMs = Math.max(
      steadyChunkMs + 120,
      Math.min(1800, Math.round(baseChunkMs * REALTIME_PLAYBACK_MAX_MULTIPLIER))
    );

    return {
      firstChunkBytes: msToPcm16Bytes(sampleRateHz, firstChunkMs),
      steadyChunkBytes: msToPcm16Bytes(sampleRateHz, steadyChunkMs),
      maxBufferBytes: msToPcm16Bytes(sampleRateHz, maxBufferMs),
      idleFlushMs: REALTIME_PLAYBACK_IDLE_FLUSH_MS
    };
  }

  enqueueRealtimeAudioPayload(payload = {}, { responseId = "" } = {}) {
    const generation = this.realtimeAudioPlaybackGeneration;
    const normalizedResponseId = normalizeText(responseId || "");

    this.realtimeAudioPlaybackChain = this.realtimeAudioPlaybackChain
      .then(async () => {
        if (!this.isRealtimePipelineActive()) {
          return;
        }
        if (generation !== this.realtimeAudioPlaybackGeneration) {
          return;
        }
        this.isAssistantAudioPlaying = true;
        this.lastAssistantAudioAtMs = Date.now();
        const played = await this.playAudioOnBridge(payload);
        if (!played) {
          this.warn(
            `Realtime audio playback failed${
              normalizedResponseId ? ` (responseId=${normalizedResponseId})` : ""
            }.`
          );
        }
      })
      .catch((err) => {
        this.warn(`Realtime audio queue failure: ${err?.message || err}`);
      })
      .finally(() => {
        this.isAssistantAudioPlaying = false;
        this.lastAssistantAudioAtMs = Date.now();
      });
  }

  flushRealtimePlaybackBuffer({ force = false, responseId = "" } = {}) {
    if (!this.realtimePlaybackPcmBuffer.length) {
      this.clearRealtimePlaybackIdleFlushTimer();
      return 0;
    }

    const sampleRateHz = Math.max(
      8000,
      Math.trunc(
        Number(
          this.realtimePlaybackSampleRateHz ||
            this.sessionConfig?.openaiRealtimeOutputSampleRateHz ||
            24000
        )
      )
    );
    const targets = this.getRealtimePlaybackChunkTargets(sampleRateHz);
    const normalizedResponseId = normalizeText(
      responseId || this.realtimePlaybackCurrentResponseId || this.realtimeCurrentResponseId
    );
    let emittedChunks = 0;

    while (this.realtimePlaybackPcmBuffer.length > 0) {
      const chunkTargetBytes = this.realtimePlaybackFirstChunkSent
        ? targets.steadyChunkBytes
        : targets.firstChunkBytes;

      if (!force && this.realtimePlaybackPcmBuffer.length < chunkTargetBytes) {
        break;
      }

      let chunkBytes = force ? this.realtimePlaybackPcmBuffer.length : chunkTargetBytes;
      if (!force && this.realtimePlaybackPcmBuffer.length > targets.maxBufferBytes) {
        chunkBytes = Math.min(this.realtimePlaybackPcmBuffer.length, targets.maxBufferBytes);
      }
      if (chunkBytes < 2) {
        break;
      }
      if (chunkBytes % 2 !== 0) {
        chunkBytes -= 1;
      }
      if (chunkBytes < 2) {
        break;
      }

      const pcmChunk = this.realtimePlaybackPcmBuffer.subarray(0, chunkBytes);
      this.realtimePlaybackPcmBuffer = this.realtimePlaybackPcmBuffer.subarray(chunkBytes);
      this.realtimePlaybackFirstChunkSent = true;
      emittedChunks += 1;

      const wavBytes = encodeWavFromPcm16(pcmChunk, sampleRateHz, 1);
      this.enqueueRealtimeAudioPayload(
        {
          audioBase64: wavBytes.toString("base64"),
          mimeType: "audio/wav",
          text: "",
          durationMs: pcm16BytesToMs(pcmChunk.length, sampleRateHz)
        },
        { responseId: normalizedResponseId }
      );
    }

    if (this.realtimePlaybackPcmBuffer.length === 0) {
      this.clearRealtimePlaybackIdleFlushTimer();
    }
    return emittedChunks;
  }

  queueRealtimeAudioPlayback(event = {}) {
    if (!this.isRealtimePipelineActive()) {
      return;
    }

    const audioBase64 = normalizeText(event.audioBase64 || "");
    if (!audioBase64) {
      return;
    }

    const responseId = normalizeText(event.responseId || "");

    let decoded;
    try {
      decoded = extractWavPcm16(Buffer.from(audioBase64, "base64"));
    } catch (err) {
      this.warn(`Realtime audio chunk decode failed: ${err?.message || err}`);
      return;
    }

    if (!decoded?.samples?.length) {
      return;
    }

    const sampleRateHz = Math.max(8000, Math.trunc(Number(decoded.sampleRate) || 24000));
    if (
      this.realtimePlaybackCurrentResponseId &&
      responseId &&
      this.realtimePlaybackCurrentResponseId !== responseId
    ) {
      this.flushRealtimePlaybackBuffer({
        force: true,
        responseId: this.realtimePlaybackCurrentResponseId
      });
      this.realtimePlaybackCurrentResponseId = responseId;
      this.realtimePlaybackFirstChunkSent = false;
    } else if (responseId && !this.realtimePlaybackCurrentResponseId) {
      this.realtimePlaybackCurrentResponseId = responseId;
    }

    if (
      this.realtimePlaybackSampleRateHz &&
      this.realtimePlaybackSampleRateHz !== sampleRateHz &&
      this.realtimePlaybackPcmBuffer.length > 0
    ) {
      this.flushRealtimePlaybackBuffer({
        force: true,
        responseId:
          this.realtimePlaybackCurrentResponseId ||
          responseId ||
          this.realtimeCurrentResponseId
      });
    }
    this.realtimePlaybackSampleRateHz = sampleRateHz;

    const pcmBytes = Buffer.from(
      decoded.samples.buffer,
      decoded.samples.byteOffset,
      decoded.samples.byteLength
    );
    this.realtimePlaybackPcmBuffer = this.realtimePlaybackPcmBuffer.length
      ? Buffer.concat([this.realtimePlaybackPcmBuffer, pcmBytes])
      : pcmBytes;

    this.flushRealtimePlaybackBuffer({
      force: false,
      responseId: responseId || this.realtimePlaybackCurrentResponseId
    });

    this.clearRealtimePlaybackIdleFlushTimer();
    const idleFlushMs = this.getRealtimePlaybackChunkTargets(sampleRateHz).idleFlushMs;
    this.realtimePlaybackIdleFlushTimer = setTimeout(() => {
      this.realtimePlaybackIdleFlushTimer = null;
      this.flushRealtimePlaybackBuffer({
        force: true,
        responseId: responseId || this.realtimePlaybackCurrentResponseId
      });
    }, idleFlushMs);
    if (typeof this.realtimePlaybackIdleFlushTimer?.unref === "function") {
      this.realtimePlaybackIdleFlushTimer.unref();
    }
  }

  handleRealtimeResponseStarted(event = {}) {
    const responseId = normalizeText(event.responseId || "");
    if (
      responseId &&
      this.realtimePlaybackCurrentResponseId &&
      this.realtimePlaybackCurrentResponseId !== responseId &&
      this.realtimePlaybackPcmBuffer.length > 0
    ) {
      this.flushRealtimePlaybackBuffer({
        force: true,
        responseId: this.realtimePlaybackCurrentResponseId
      });
    }
    this.realtimeResponseInProgress = true;
    this.realtimeCurrentResponseId = responseId || this.realtimeCurrentResponseId || "";
    if (responseId) {
      this.realtimePlaybackCurrentResponseId = responseId;
      this.realtimePlaybackFirstChunkSent = false;
    }
    this.setBridgeTtsDucking(false);
    if (responseId && this.realtimePendingUserTurnText) {
      this.realtimeUserTurnByResponseId[responseId] = this.realtimePendingUserTurnText;
      this.realtimePendingUserTurnText = "";
    }
    this.trace(
      `Realtime assistant response started${
        responseId ? ` (${responseId})` : ""
      }.`
    );
  }

  handleRealtimeAssistantTextFinal(event = {}) {
    const responseId = normalizeText(event.responseId || "");
    const text = normalizeText(event.text || "");
    if (!text) {
      return;
    }

    if (responseId) {
      this.realtimeAssistantTextByResponseId[responseId] = text;
    }

    this.bot(text);
    this.rememberBotOutput(text);
  }

  handleRealtimeResponseDone(event = {}) {
    const responseId = normalizeText(event.responseId || "");
    const status = normalizeText(event.status || "unknown") || "unknown";
    const reason = normalizeText(event.reason || "");
    this.flushRealtimePlaybackBuffer({
      force: true,
      responseId: responseId || this.realtimePlaybackCurrentResponseId
    });
    if (
      !responseId ||
      !this.realtimePlaybackCurrentResponseId ||
      this.realtimePlaybackCurrentResponseId === responseId
    ) {
      this.realtimePlaybackCurrentResponseId = "";
      this.realtimePlaybackFirstChunkSent = false;
    }
    this.realtimeResponseInProgress = false;
    if (!responseId || this.realtimeCurrentResponseId === responseId) {
      this.realtimeCurrentResponseId = "";
    }
    this.setBridgeTtsDucking(false);

    const assistantText = responseId
      ? normalizeText(this.realtimeAssistantTextByResponseId[responseId] || "")
      : "";
    const userText = responseId
      ? normalizeText(this.realtimeUserTurnByResponseId[responseId] || "")
      : "";

    if (assistantText && userText) {
      this.appendConversationTurn({
        source: "openai-realtime",
        user: userText,
        bot: assistantText
      });
    }

    if (responseId) {
      delete this.realtimeAssistantTextByResponseId[responseId];
      delete this.realtimeUserTurnByResponseId[responseId];
    }
    this.trace(
      `Realtime assistant response finished${
        responseId ? ` (${responseId})` : ""
      }, status=${status}${reason ? `, reason=${reason}` : ""}.`
    );
  }

  handleRealtimeUserFinal({ source = "openai-realtime", text = "" } = {}) {
    const normalizedText = normalizeText(text);
    if (!normalizedText) {
      return;
    }
    const normalizedSource = normalizeText(source || "openai-realtime") || "openai-realtime";

    if (
      this.shouldDropInboundTranscript({
        source: normalizedSource,
        text: normalizedText
      })
    ) {
      return;
    }

    this.latestPartialsBySource[normalizedSource] = {
      text: normalizedText,
      at: Date.now()
    };
    this.lastUserTurnText = normalizedText;
    this.hasProcessedUserTurn = true;
    this.realtimePendingUserTurnText = normalizedText;
    if (
      this.realtimeResponseInProgress &&
      this.realtimeCurrentResponseId &&
      !this.realtimeUserTurnByResponseId[this.realtimeCurrentResponseId]
    ) {
      this.realtimeUserTurnByResponseId[this.realtimeCurrentResponseId] =
        normalizedText;
      this.realtimePendingUserTurnText = "";
    }
    this.user(`[${normalizedSource}] ${normalizedText}`);
  }

  handleRealtimeConfirmedVadBargeIn({
    source = "openai-realtime",
    reason = "vad-confirmed",
    speechMs = 0,
    peak = 0
  } = {}) {
    if (!this.sessionConfig?.bargeInEnabled) {
      return;
    }
    if (!this.realtimeResponseInProgress) {
      return;
    }

    const minBargeInMs = Number(this.sessionConfig?.bargeInMinMs || 0);
    if (Number(speechMs || 0) < minBargeInMs) {
      return;
    }

    const latestPartial = this.getLatestPartial(source);
    const partialAgeMs = latestPartial?.at
      ? Date.now() - Number(latestPartial.at)
      : Number.MAX_SAFE_INTEGER;
    const partialText =
      latestPartial && partialAgeMs <= 1600 ? normalizeText(latestPartial.text) : "";

    if (partialText && this.isLikelyBotEcho(partialText)) {
      return;
    }

    this.markPendingUserContinuation({
      source,
      text: partialText
    });
    this.appendInterruptionContext({
      source,
      reason,
      text: partialText || "[realtime-vad-confirmed-without-text]"
    });
    this.trace(
      `Realtime VAD-confirmed barge-in accepted (${source}:${reason}, speechMs=${Math.max(
        0,
        Number(speechMs || 0)
      )}, peak=${Number(peak || 0).toFixed(4)}).`
    );
    void this.interruptRealtimeOutput(`barge-in:${source}:${reason}`, {
      source,
      text: partialText
    });
  }

  async interruptRealtimeOutput(
    reason = "realtime-interrupt",
    { source = "openai-realtime", text = "" } = {}
  ) {
    if (!this.isRealtimePipelineActive()) {
      return false;
    }
    if (!this.realtimeResponseInProgress && !this.isAssistantAudioPlaying) {
      return false;
    }

    this.clearSpeculativePrefetch(`realtime-interrupt:${reason}`);
    this.clearSoftInterrupt({ resumeAudio: false, reason: "realtime hard interrupt" });
    this.realtimeAudioPlaybackGeneration += 1;
    this.realtimePlaybackPcmBuffer = Buffer.alloc(0);
    this.realtimePlaybackSampleRateHz = 0;
    this.realtimePlaybackCurrentResponseId = "";
    this.realtimePlaybackFirstChunkSent = false;
    this.clearRealtimePlaybackIdleFlushTimer();
    this.realtimeResponseInProgress = false;
    this.realtimeCurrentResponseId = "";

    try {
      if (this.transportAdapter && this.bridgePage) {
        await this.transportAdapter.stopSpeaking({
          flush: true,
          resumeGateMs: 24
        });
      }
    } catch (_) {
      // Ignore bridge stop errors while interrupting realtime output.
    }

    try {
      await this.realtimeAdapter?.interrupt({
        reason,
        clearInputBuffer: true
      });
    } catch (_) {
      // Ignore realtime interrupt errors.
    }

    this.setBridgeTtsDucking(false);
    if (text) {
      this.markPendingUserContinuation({
        source,
        text
      });
    }
    this.info(`Realtime assistant output interrupted (${reason}).`);
    return true;
  }

  async recoverBridgePage(reason = "bridge transport failure") {
    if (
      !this.browser ||
      !this.sessionConfig ||
      !this.transportAdapter ||
      this.isStopping
    ) {
      return false;
    }

    const now = Date.now();
    if (now - this.lastBridgeRecoveryAtMs < 1500) {
      return false;
    }
    this.lastBridgeRecoveryAtMs = now;

    this.warn(`Bridge page unavailable (${reason}); attempting recovery.`);

    try {
      this.bridgePage = await this.transportAdapter.reopenBridge();
      await this.transportAdapter.startStt({
        chunkMs: this.sessionConfig.openaiSttChunkMs,
        partialsEnabled: this.isRealtimePipelineActive()
          ? true
          : this.sessionConfig.openaiSttPartialsEnabled,
        partialEmitMs: this.sessionConfig.openaiSttPartialEmitMs,
        mimeType: this.sessionConfig.openaiSttMimeType,
        deviceId: this.sessionConfig.openaiSttDeviceId,
        deviceLabel: this.sessionConfig.openaiSttDeviceLabel,
        preferLoopback: this.sessionConfig.openaiSttPreferLoopback,
        audioBitsPerSecond: this.sessionConfig.openaiSttAudioBitsPerSecond,
        minSignalPeak: this.sessionConfig.openaiSttMinSignalPeak,
        vadThreshold: this.sessionConfig.openaiSttVadThreshold,
        hangoverMs: this.sessionConfig.openaiSttHangoverMs,
        segmentMinMs: this.sessionConfig.openaiSttSegmentMinMs,
        segmentMaxMs: this.sessionConfig.openaiSttSegmentMaxMs,
        bargeInMinMs: this.sessionConfig.bargeInMinMs
      });
      this.setBridgeTtsDucking(this.softInterruptActive);

      this.info("Bridge page recovered.");
      if (this.queue.length > 0) {
        void this.processQueueHandler?.();
      }
      return true;
    } catch (err) {
      this.warn(`Bridge recovery failed: ${err?.message || err}`);
      return false;
    }
  }

  async playAudioOnBridge(payload) {
    if (!payload || !payload.audioBase64) {
      return false;
    }

    if (
      !this.transportAdapter ||
      !this.bridgePage ||
      this.bridgePage.isClosed()
    ) {
      const recovered = await this.recoverBridgePage("bridge page closed");
      if (!recovered) {
        return false;
      }
    }

    try {
      return Boolean(await this.transportAdapter.playAudio(payload));
    } catch (err) {
      if (!isBridgeTransportError(err)) {
        throw err;
      }

      const recovered = await this.recoverBridgePage(
        "audio playback bridge transport error"
      );
      if (
        !recovered ||
        !this.transportAdapter ||
        !this.bridgePage ||
        this.bridgePage.isClosed()
      ) {
        return false;
      }
      return Boolean(await this.transportAdapter.playAudio(payload));
    }
  }

  async respondToCommand({
    responder,
    source,
    commandText,
    openingPrefetch = null
  }) {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const abortController = new AbortController();
    const llmStartedAtMs = Date.now();
    let firstTextChunkAtMs = 0;
    let prefetchComparable = "";
    let prefetchConsumed = false;
    this.trace(
      `Assistant run started (${runId}, source=${source}, userChars=${commandText.length}).`
    );
    this.activeAssistantRun = {
      id: runId,
      source,
      startedAt: Date.now(),
      abortController,
      firstAudioAtMs: 0
    };
    this.setBridgeTtsDucking(false);

    let playbackChain = Promise.resolve();
    const queueChunkPlayback = (
      chunkText,
      { prefetchedAudio = null, chunkOrigin = "stream" } = {}
    ) => {
      const text = normalizeText(chunkText);
      if (!text) {
        return;
      }
      if (!firstTextChunkAtMs) {
        firstTextChunkAtMs = Date.now();
      }
      this.trace(
        `Assistant text chunk queued (${runId}, chars=${text.length}, origin=${chunkOrigin}).`
      );

      playbackChain = playbackChain
        .then(() =>
          this.playAssistantChunk({
            responder,
            text,
            runId,
            signal: abortController.signal,
            prefetchedAudio
          })
        )
        .catch((err) => {
          if (!isAbortErrorLike(err)) {
            this.warn(`Chunk playback failed: ${err?.message || err}`);
          }
        });
    };

    if (openingPrefetch?.audioPayload && openingPrefetch?.text) {
      prefetchComparable = normalizeComparableText(openingPrefetch.text);
      queueChunkPlayback(openingPrefetch.text, {
        prefetchedAudio: openingPrefetch.audioPayload,
        chunkOrigin: "speculative-prefetch"
      });
    }

    let streamResult = null;
    try {
      try {
        streamResult = await responder.streamReply(commandText, {
          signal: abortController.signal,
          onTextChunk: async (chunk) => {
            if (
              !prefetchConsumed &&
              prefetchComparable &&
              isComparablePrefixMatch(chunk, openingPrefetch?.text || "")
            ) {
              prefetchConsumed = true;
              this.trace(
                `Skipped streamed chunk in favor of speculative prefetch (${runId}).`
              );
              return;
            }
            queueChunkPlayback(chunk);
          }
        });
      } catch (streamErr) {
        if (!isAbortErrorLike(streamErr)) {
          throw streamErr;
        }
        this.trace(
          `Assistant stream aborted (${runId}) while waiting for chunks.`
        );
      }

      await playbackChain;

      if (!abortController.signal.aborted) {
        const firstAudioAtMs = Number(this.activeAssistantRun?.firstAudioAtMs || 0);
        const llmFirstChunkMs = firstTextChunkAtMs
          ? firstTextChunkAtMs - llmStartedAtMs
          : null;
        const ttsFirstAudioMs =
          firstAudioAtMs && firstTextChunkAtMs
            ? firstAudioAtMs - firstTextChunkAtMs
            : null;
        const totalMs = Date.now() - llmStartedAtMs;
        this.info(
          `Turn timing (${source}): llm-first-chunk=${
            llmFirstChunkMs == null ? "n/a" : `${llmFirstChunkMs}ms`
          }, tts-first-audio=${
            ttsFirstAudioMs == null ? "n/a" : `${ttsFirstAudioMs}ms`
          }, total=${totalMs}ms.`
        );
      }

      const isAborted =
        Boolean(streamResult?.aborted) || Boolean(abortController.signal.aborted);
      const rawReply = normalizeText(streamResult?.text || "");
      const completionDetected = hasCompletionToken(
        rawReply,
        this.sessionConfig.intakeCompleteToken
      );
      const reply = stripControlTokens(
        rawReply,
        this.sessionConfig.intakeCompleteToken
      );

      if (!isAborted && reply) {
        this.bot(reply);
        this.rememberBotOutput(reply);
        this.appendConversationTurn({
          source,
          user: commandText,
          bot: reply
        });

        if (completionDetected) {
          await this.handleIntakeCompletion();
        }
      } else {
        this.trace(
          `Assistant run produced no committed reply (${runId}, aborted=${isAborted}).`
        );
      }
    } finally {
      this.clearSoftInterrupt({ resumeAudio: true });
      this.trace(`Assistant run finished (${runId}).`);
      if (this.activeAssistantRun?.id === runId) {
        this.activeAssistantRun = null;
      }
    }
  }

  async playAssistantChunk({
    responder,
    text,
    runId,
    signal,
    prefetchedAudio = null
  }) {
    const chunkText = stripControlTokens(
      text,
      this.sessionConfig?.intakeCompleteToken
    );
    if (!chunkText || this.status !== "running" || this.isStopping) {
      return;
    }
    if (signal?.aborted) {
      return;
    }
    if (runId && this.activeAssistantRun?.id !== runId) {
      return;
    }

    this.rememberBotOutput(chunkText);
    this.isAssistantAudioPlaying = true;
    this.lastAssistantAudioAtMs = Date.now();
    const ttsStartedAtMs = Date.now();
    this.trace(
      `TTS chunk start (${runId || "n/a"}, chars=${chunkText.length}).`
    );

    try {
      const timedAudio = prefetchedAudio?.audioBase64
        ? prefetchedAudio
        : await withTimeout(
            responder.synthesizeSpeech(chunkText, { signal }),
            this.sessionConfig.openaiTtsTimeoutMs,
            "OpenAI TTS chunk"
          );

      if (signal?.aborted || (runId && this.activeAssistantRun?.id !== runId)) {
        return;
      }

      if (!timedAudio?.audioBase64) {
        throw new Error("OpenAI TTS returned empty chunk audio.");
      }
      const ttsLatencyMs = Date.now() - ttsStartedAtMs;

      const played = await this.playAudioOnBridge({
        audioBase64: timedAudio.audioBase64,
        mimeType: timedAudio.mimeType,
        text: chunkText
      });
      if (!played) {
        throw new Error("Bridge audio playback failed.");
      }
      if (
        this.activeAssistantRun &&
        this.activeAssistantRun.id === runId &&
        !this.activeAssistantRun.firstAudioAtMs
      ) {
        this.activeAssistantRun.firstAudioAtMs = Date.now();
      }
      this.trace(
        `TTS chunk played (${runId || "n/a"}, ttsLatencyMs=${ttsLatencyMs}, chars=${chunkText.length}).`
      );
    } finally {
      this.isAssistantAudioPlaying = false;
      this.lastAssistantAudioAtMs = Date.now();
    }
  }

  appendConversationTurn({ source, user, bot }) {
    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    if (normalizedSource === "system") {
      return;
    }

    const normalizedUser = normalizeText(user);
    const normalizedBot = normalizeText(bot);
    if (!normalizedUser || !normalizedBot) {
      return;
    }

    this.conversationTurns.push({
      source: normalizedSource,
      user: normalizedUser,
      bot: normalizedBot
    });
    if (this.conversationTurns.length > this.maxConversationTurns) {
      this.conversationTurns.shift();
    }
  }

  rememberBotOutput(text) {
    const comparable = normalizeComparableText(text);
    const looseComparable = normalizeLooseComparableText(text);
    const tokens = tokenizeComparableWords(text);
    if (!comparable) {
      return;
    }

    const now = Date.now();
    this.recentBotOutputs.push({
      text: comparable,
      loose: looseComparable,
      tokens,
      at: now
    });

    const maxAgeMs = 15000;
    this.recentBotOutputs = this.recentBotOutputs
      .filter((entry) => now - entry.at <= maxAgeMs)
      .slice(-60);
  }

  isLikelyBotEcho(text) {
    const comparable = normalizeComparableText(text);
    const looseComparable = normalizeLooseComparableText(text);
    const incomingTokens = tokenizeComparableWords(text);
    if (!comparable) {
      return false;
    }

    const now = Date.now();
    const maxAgeMs = 15000;
    this.recentBotOutputs = this.recentBotOutputs.filter(
      (entry) => now - entry.at <= maxAgeMs
    );

    return this.recentBotOutputs.some(
      (entry) => {
        const basicMatch =
          comparable === entry.text ||
          comparable.startsWith(entry.text) ||
          entry.text.startsWith(comparable);
        if (basicMatch) {
          return true;
        }

        const looseMatch =
          looseComparable.length >= 10 &&
          String(entry.loose || "").length >= 10 &&
          (looseComparable === entry.loose ||
            looseComparable.includes(entry.loose) ||
            entry.loose.includes(looseComparable));
        if (looseMatch) {
          return true;
        }

        if (incomingTokens.length < 3 || !Array.isArray(entry.tokens)) {
          return false;
        }

        const tokenSet = new Set(entry.tokens);
        let overlap = 0;
        for (const token of incomingTokens) {
          if (tokenSet.has(token)) {
            overlap += 1;
          }
        }

        const overlapRatio = overlap / incomingTokens.length;
        return overlap >= 2 && overlapRatio >= 0.6;
      }
    );
  }

  async handleIntakeCompletion() {
    if (!this.sessionConfig?.autoLeaveOnIntakeComplete) {
      return;
    }
    if (this.status !== "running" || this.isStopping) {
      return;
    }

    const delayMs = Math.max(
      0,
      Number(this.sessionConfig.intakeCompleteLeaveDelayMs || 0)
    );
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    if (this.status !== "running" || this.isStopping) {
      return;
    }

    this.info("Intake completion detected; leaving Meet and closing session.");
    await this.stop({ reason: "intake complete" });
  }

  setBridgeTtsDucking(active) {
    if (
      !this.transportAdapter ||
      !this.bridgePage ||
      this.bridgePage.isClosed()
    ) {
      return;
    }

    const duckLevel = Math.max(
      0,
      Math.min(1, Number(this.sessionConfig?.softInterruptDuckLevel ?? 0.22))
    );
    this.trace(
      `Bridge ducking ${Boolean(active) ? "enabled" : "disabled"} (level=${duckLevel.toFixed(
        2
      )}).`
    );

    void Promise.resolve(
      this.transportAdapter.setTtsDucking({
        active: Boolean(active),
        level: duckLevel
      })
    ).catch(() => {});
  }

  clearSoftInterrupt({ resumeAudio = true, reason = "" } = {}) {
    if (this.softInterruptTimer) {
      clearTimeout(this.softInterruptTimer);
      this.softInterruptTimer = null;
    }
    const wasActive = this.softInterruptActive;
    this.softInterruptActive = false;
    this.softInterruptRunId = "";
    this.softInterruptSource = "";
    if (resumeAudio && wasActive) {
      this.setBridgeTtsDucking(false);
    }
    if (wasActive) {
      this.trace(
        `Soft interrupt cleared${reason ? ` (${reason})` : ""}; resumeAudio=${resumeAudio}.`
      );
    }
  }

  maybeStartSoftInterrupt({ source, reason }) {
    if (!this.sessionConfig?.softInterruptEnabled) {
      return;
    }
    if (!this.sessionConfig?.bargeInEnabled) {
      return;
    }

    const run = this.activeAssistantRun;
    if (!run || this.isStopping) {
      return;
    }

    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    if (normalizedSource !== "openai-stt") {
      return;
    }

    if (run.abortController?.signal?.aborted) {
      return;
    }

    const elapsedMs = Date.now() - Number(run.startedAt || 0);
    const minBargeInMs = Number(this.sessionConfig?.bargeInMinMs || 0);
    if (elapsedMs < minBargeInMs) {
      this.trace(
        `Soft interrupt ignored (${normalizedSource}:${reason}): elapsed ${elapsedMs}ms < bargeInMinMs ${minBargeInMs}.`
      );
      return;
    }

    if (this.softInterruptActive && this.softInterruptRunId === run.id) {
      if (this.softInterruptTimer) {
        clearTimeout(this.softInterruptTimer);
        this.softInterruptTimer = null;
      }
      this.trace(
        `Soft interrupt re-armed (${normalizedSource}:${reason}) for active run ${run.id}.`
      );
      return;
    }

    this.clearSoftInterrupt({ resumeAudio: false, reason: "re-arm" });
    this.softInterruptActive = true;
    this.softInterruptRunId = run.id;
    this.softInterruptSource = normalizedSource;
    this.setBridgeTtsDucking(true);
    this.info(`Soft interrupt armed (${normalizedSource}:${reason}).`);
  }

  handleSoftInterruptStop({ source, reason }) {
    if (!this.softInterruptActive) {
      return;
    }

    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    if (this.softInterruptSource && normalizedSource !== this.softInterruptSource) {
      return;
    }

    const run = this.activeAssistantRun;
    if (!run || run.id !== this.softInterruptRunId || run.abortController?.signal?.aborted) {
      this.clearSoftInterrupt({
        resumeAudio: true,
        reason: "run changed before vad.stop confirm"
      });
      return;
    }

    const confirmMs = Math.max(
      200,
      Number(this.sessionConfig?.softInterruptConfirmMs || 700)
    );

    if (this.softInterruptTimer) {
      clearTimeout(this.softInterruptTimer);
      this.softInterruptTimer = null;
    }
    this.trace(
      `Soft interrupt confirmation timer started (${confirmMs}ms, ${normalizedSource}:${reason}).`
    );
    this.softInterruptTimer = setTimeout(() => {
      if (!this.softInterruptActive) {
        return;
      }
      const activeRun = this.activeAssistantRun;
      if (
        !activeRun ||
        activeRun.id !== this.softInterruptRunId ||
        activeRun.abortController?.signal?.aborted
      ) {
        this.clearSoftInterrupt({
          resumeAudio: true,
          reason: "run changed during confirm timeout"
        });
        return;
      }
      this.info(
        `Soft interrupt expired without confirmed speech (${normalizedSource}:${reason}).`
      );
      this.clearSoftInterrupt({ resumeAudio: true, reason: "confirm-timeout" });
    }, confirmMs);
  }

  appendInterruptionContext({ source, reason, text = "" }) {
    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    const normalizedReason = normalizeText(reason || "unknown") || "unknown";
    const normalizedText = normalizeText(text || "");

    if (this.responder && typeof this.responder.appendInterruptionContext === "function") {
      try {
        this.responder.appendInterruptionContext({
          source: normalizedSource,
          reason: normalizedReason,
          text: normalizedText
        });
      } catch (_) {
        // Ignore interruption context injection failures.
      }
    }

    if (
      this.isRealtimePipelineActive() &&
      this.realtimeAdapter &&
      typeof this.realtimeAdapter.appendSystemContext === "function"
    ) {
      const note = normalizeText(
        `Interruption context: user started speaking over assistant output (source=${normalizedSource}, reason=${normalizedReason}). Latest user fragment: ${
          normalizedText || "<none>"
        }`
      );
      if (note) {
        void this.realtimeAdapter.appendSystemContext(note).catch(() => {});
      }
    }
  }

  getLatestPartial(source) {
    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    const entry = this.latestPartialsBySource?.[normalizedSource];
    if (!entry || !normalizeText(entry.text)) {
      return null;
    }
    return {
      source: normalizedSource,
      text: normalizeText(entry.text),
      at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0
    };
  }

  async maybeStartSpeculativePrefetch({ source, text, responder }) {
    if (!this.sessionConfig?.partialSpeculationEnabled) {
      return;
    }
    if (!responder || this.isStopping || this.status !== "running") {
      return;
    }
    if (this.activeAssistantRun) {
      return;
    }

    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    if (normalizedSource !== "openai-stt") {
      return;
    }

    const normalizedText = normalizeText(text);
    if (!normalizedText) {
      return;
    }
    const minWords = Math.max(
      1,
      Number(this.sessionConfig?.partialSpeculationMinWords || 3)
    );
    if (countWords(normalizedText) < minWords) {
      return;
    }

    if (this.speculativePrefetch?.pending) {
      const previousText = normalizeText(this.speculativePrefetch?.seedText);
      if (
        previousText &&
        (isComparablePrefixMatch(previousText, normalizedText) ||
          isComparablePrefixMatch(normalizedText, previousText))
      ) {
        return;
      }
      this.clearSpeculativePrefetch("new partial superseded previous seed");
    }

    let semantic = null;
    if (this.semanticTurnDetector) {
      semantic = await this.semanticTurnDetector.evaluate(normalizedText, {
        isFirstUserTurn: !this.hasProcessedUserTurn
      });
    }
    if (
      semantic &&
      (semantic.status === "incomplete" ||
        Number(semantic.recommendedDelayMs || 0) >
          Number(this.sessionConfig?.semanticEotMinDelayMs || 250) + 200)
    ) {
      return;
    }

    const prefetchId = `spec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const abortController = new AbortController();
    const timeoutMs = Math.max(
      120,
      Number(this.sessionConfig?.partialSpeculationTimeoutMs || 1400)
    );
    const prefetchState = {
      id: prefetchId,
      source: normalizedSource,
      seedText: normalizedText,
      createdAt: Date.now(),
      firstChunkText: "",
      audioPayload: null,
      pending: true,
      abortController
    };
    this.speculativePrefetch = prefetchState;
    this.trace(
      `Speculative prefetch started (${prefetchId}, source=${normalizedSource}, chars=${normalizedText.length}).`
    );

    const timeout = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    try {
      await responder.streamReply(normalizedText, {
        signal: abortController.signal,
        commitHistory: false,
        onTextChunk: async (chunk) => {
          if (!chunk || prefetchState.firstChunkText) {
            return;
          }
          const firstChunkText = normalizeText(chunk);
          if (!firstChunkText) {
            return;
          }
          prefetchState.firstChunkText = firstChunkText;
          try {
            const audioPayload = await withTimeout(
              responder.synthesizeSpeech(firstChunkText, {
                signal: abortController.signal
              }),
              this.sessionConfig.openaiTtsTimeoutMs,
              "Speculative TTS prefetch"
            );
            if (audioPayload?.audioBase64) {
              prefetchState.audioPayload = audioPayload;
              this.trace(
                `Speculative prefetch ready (${prefetchId}, chunkChars=${firstChunkText.length}).`
              );
            }
          } catch (prefetchErr) {
            if (!isAbortErrorLike(prefetchErr)) {
              this.trace(
                `Speculative prefetch TTS failed (${prefetchId}): ${
                  prefetchErr?.message || prefetchErr
                }`
              );
            }
          } finally {
            abortController.abort();
          }
        }
      });
    } catch (err) {
      if (!isAbortErrorLike(err)) {
        this.trace(
          `Speculative prefetch failed (${prefetchId}): ${err?.message || err}`
        );
      }
    } finally {
      clearTimeout(timeout);
      if (this.speculativePrefetch?.id === prefetchId) {
        this.speculativePrefetch.pending = false;
      }
    }
  }

  clearSpeculativePrefetch(reason = "") {
    const active = this.speculativePrefetch;
    if (!active) {
      return;
    }
    try {
      active.abortController?.abort();
    } catch (_) {
      // Ignore abort errors.
    }
    this.speculativePrefetch = null;
    if (reason) {
      this.trace(`Speculative prefetch cleared (${reason}).`);
    }
  }

  async consumeSpeculativePrefetch({ source, commandText }) {
    const active = this.speculativePrefetch;
    if (!active) {
      return null;
    }

    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    if (normalizedSource !== active.source) {
      this.clearSpeculativePrefetch("source mismatch");
      return null;
    }

    const normalizedCommand = normalizeText(commandText);
    if (!normalizedCommand) {
      this.clearSpeculativePrefetch("empty command");
      return null;
    }
    if (!isComparablePrefixMatch(active.seedText, normalizedCommand)) {
      this.clearSpeculativePrefetch("seed mismatch");
      return null;
    }

    const maxAgeMs = Math.max(
      120,
      Number(this.sessionConfig?.partialSpeculationMaxAgeMs || 1800)
    );
    if (Date.now() - Number(active.createdAt || 0) > maxAgeMs) {
      this.clearSpeculativePrefetch("stale");
      return null;
    }

    const timeoutMs = 80;
    const startedAt = Date.now();
    while (
      this.speculativePrefetch &&
      this.speculativePrefetch.id === active.id &&
      this.speculativePrefetch.pending &&
      Date.now() - startedAt < timeoutMs
    ) {
      await sleep(10);
    }

    const current = this.speculativePrefetch;
    this.speculativePrefetch = null;
    if (!current?.audioPayload?.audioBase64 || !current.firstChunkText) {
      return null;
    }
    this.trace(
      `Speculative prefetch consumed (${current.id}, seedChars=${current.seedText.length}, commandChars=${normalizedCommand.length}).`
    );
    return {
      text: current.firstChunkText,
      audioPayload: current.audioPayload,
      seedText: current.seedText
    };
  }

  handleConfirmedVadBargeIn({ source, reason, speechMs = 0, peak = 0 }) {
    if (!this.sessionConfig?.bargeInOnVadConfirmed) {
      return;
    }
    if (!this.sessionConfig?.bargeInEnabled) {
      return;
    }

    const run = this.activeAssistantRun;
    const hasHybridRun =
      Boolean(run) && !run?.abortController?.signal?.aborted && !this.isStopping;
    const hasRealtimeRun =
      this.isRealtimePipelineActive() && this.realtimeResponseInProgress && !this.isStopping;
    if (!hasHybridRun && !hasRealtimeRun) {
      return;
    }

    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    if (
      normalizedSource !== "openai-stt" &&
      normalizedSource !== "openai-realtime"
    ) {
      return;
    }

    const minBargeInMs = Number(this.sessionConfig?.bargeInMinMs || 0);
    if (Number(speechMs || 0) < minBargeInMs) {
      return;
    }

    const minPeak = Math.max(
      0,
      Number(this.sessionConfig?.bargeInVadMinPeak || 0)
    );
    if (Number(peak || 0) < minPeak) {
      this.trace(
        `VAD-confirmed barge-in ignored (${normalizedSource}:${reason}): peak ${Number(
          peak || 0
        ).toFixed(4)} < min ${minPeak.toFixed(4)}.`
      );
      return;
    }

    const latestPartial = this.getLatestPartial(normalizedSource);
    const partialAgeMs = latestPartial?.at
      ? Date.now() - Number(latestPartial.at)
      : Number.MAX_SAFE_INTEGER;
    const partialText =
      latestPartial && partialAgeMs <= 1600 ? normalizeText(latestPartial.text) : "";
    if (partialText && this.isLikelyBotEcho(partialText)) {
      return;
    }

    this.clearSpeculativePrefetch("confirmed barge-in");
    if (this.softInterruptActive) {
      this.clearSoftInterrupt({
        resumeAudio: false,
        reason: "vad-confirmed hard interrupt"
      });
    }
    this.markPendingUserContinuation({
      source: normalizedSource,
      text: partialText
    });
    this.appendInterruptionContext({
      source: normalizedSource,
      reason,
      text: partialText || "[vad-confirmed-without-text]"
    });
    this.trace(
      `VAD-confirmed barge-in accepted (${normalizedSource}:${reason}, speechMs=${speechMs}, peak=${Number(
        peak || 0
      ).toFixed(4)}).`
    );
    if (hasRealtimeRun) {
      void this.interruptRealtimeOutput(`barge-in:${normalizedSource}:${reason}`, {
        source: normalizedSource,
        text: partialText
      });
      return;
    }
    void this.interruptAssistantRun(`barge-in:${normalizedSource}:${reason}`);
  }

  maybeInterruptAssistantOutput({ source, text, reason }) {
    if (!this.sessionConfig?.bargeInEnabled) {
      return;
    }

    if (!text || !this.activeAssistantRun || this.isStopping) {
      if (text && this.isStopping) {
        this.trace(
          `Barge-in skipped (${source}:${reason}): session is stopping.`
        );
      }
      return;
    }
    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    if (normalizedSource === "openai-stt") {
      const minWords = Math.max(
        1,
        Number(this.sessionConfig?.bargeInMinWordsOpenAiStt || 2)
      );
      if (countWords(text) < minWords) {
        this.trace(
          `Barge-in skipped (${source}:${reason}): ${countWords(
            text
          )} word(s) < min ${minWords}.`
        );
        return;
      }
    }
    if (this.isLikelyBotEcho(text)) {
      this.trace(
        `Barge-in skipped (${source}:${reason}): transcript looks like bot echo ("${truncateForLog(
          text,
          120
        )}").`
      );
      return;
    }
    if (this.activeAssistantRun.abortController?.signal?.aborted) {
      this.trace(`Barge-in skipped (${source}:${reason}): run already aborted.`);
      return;
    }

    const elapsedMs = Date.now() - Number(this.activeAssistantRun.startedAt || 0);
    const minBargeInMs = Number(this.sessionConfig.bargeInMinMs || 0);
    if (elapsedMs < minBargeInMs) {
      this.trace(
        `Barge-in skipped (${source}:${reason}): elapsed ${elapsedMs}ms < bargeInMinMs ${minBargeInMs}.`
      );
      return;
    }

    if (this.softInterruptActive) {
      this.clearSoftInterrupt({
        resumeAudio: false,
        reason: "hard-interrupt confirmed"
      });
    }
    this.trace(
      `Barge-in accepted (${source}:${reason}) -> interrupting assistant.`
    );
    this.clearSpeculativePrefetch("hard barge-in");
    this.markPendingUserContinuation({
      source: normalizedSource,
      text
    });
    this.appendInterruptionContext({
      source: normalizedSource,
      reason,
      text
    });
    void this.interruptAssistantRun(`barge-in:${source}:${reason}`);
  }

  markPendingUserContinuation({ source, text }) {
    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    if (normalizedSource === "system") {
      return;
    }

    const latestUserText = normalizeText(this.lastUserTurnText);
    const incomingText = normalizeText(text);
    if (!latestUserText || !incomingText) {
      return;
    }

    this.pendingContinuationBaseText = latestUserText;
    this.pendingContinuationSetAtMs = Date.now();
    this.trace(
      `Pending continuation armed from last user turn (${normalizedSource}, baseChars=${latestUserText.length}, newChars=${incomingText.length}).`
    );
  }

  consumePendingUserContinuation({ source, currentText }) {
    const normalizedCurrent = normalizeText(currentText);
    if (!normalizedCurrent) {
      return "";
    }

    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    if (normalizedSource === "system") {
      return normalizedCurrent;
    }

    const base = normalizeText(this.pendingContinuationBaseText);
    const setAtMs = Number(this.pendingContinuationSetAtMs || 0);
    if (!base || !Number.isFinite(setAtMs) || setAtMs <= 0) {
      return normalizedCurrent;
    }

    const continuationWindowMs = Math.max(
      1000,
      Number(this.sessionConfig?.bargeInContinuationWindowMs || 20000)
    );
    if (Date.now() - setAtMs > continuationWindowMs) {
      this.pendingContinuationBaseText = "";
      this.pendingContinuationSetAtMs = 0;
      this.trace(
        `Pending continuation expired after ${continuationWindowMs}ms window.`
      );
      return normalizedCurrent;
    }

    this.pendingContinuationBaseText = "";
    this.pendingContinuationSetAtMs = 0;
    const merged = mergeUserContinuationText(base, normalizedCurrent);
    this.trace(
      `Pending continuation merged (baseChars=${base.length}, currentChars=${normalizedCurrent.length}, mergedChars=${merged.length}).`
    );
    return merged;
  }

  async interruptAssistantRun(reason = "interrupted") {
    const run = this.activeAssistantRun;
    if (!run || run.abortController?.signal?.aborted) {
      if (this.isRealtimePipelineActive()) {
        return this.interruptRealtimeOutput(reason);
      }
      return false;
    }

    this.clearSpeculativePrefetch(`interrupt:${reason}`);
    this.clearSoftInterrupt({ resumeAudio: false, reason: "hard interrupt" });
    run.abortController.abort();
    try {
      if (this.transportAdapter && this.bridgePage) {
        await this.transportAdapter.stopSpeaking({
          flush: true,
          resumeGateMs: 40
        });
        await sleep(20);
        await this.transportAdapter.stopSpeaking({
          flush: true,
          resumeGateMs: 40
        });
      }
    } catch (_) {
      // Ignore playback interruption transport errors.
    }
    this.setBridgeTtsDucking(false);

    this.info(`Assistant output interrupted (${reason}).`);
    return true;
  }

  markSourceActivity(source) {
    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    this.lastSourceActivityAtMs[normalizedSource] = Date.now();
  }

  getSourceSilenceMs(source) {
    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    const lastAt = Number(this.lastSourceActivityAtMs[normalizedSource] || 0);
    if (!Number.isFinite(lastAt) || lastAt <= 0) {
      return Number.MAX_SAFE_INTEGER;
    }
    return Date.now() - lastAt;
  }

  async waitForPostTurnResponseDelay({
    source,
    commandText,
    isFirstUserTurn = false,
    initialTurnAtMs,
    initialSegmentDurationMs
  }) {
    let resolved = normalizeText(commandText);
    if (!resolved) {
      return "";
    }
    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    const isOpenAiSttSource = normalizedSource === "openai-stt";

    const configuredDelayMsRaw = Number(
      this.sessionConfig?.postTurnResponseDelayMs
    );
    const continuationSilenceMsRaw = Number(
      this.sessionConfig?.turnContinuationSilenceMs
    );
    const configuredDelayMs = Number.isFinite(configuredDelayMsRaw)
      ? Math.max(0, configuredDelayMsRaw)
      : 0;
    const continuationSilenceMs = Number.isFinite(continuationSilenceMsRaw)
      ? Math.max(120, continuationSilenceMsRaw)
      : 360;

    let delayMs = isOpenAiSttSource
      ? continuationSilenceMs
      : configuredDelayMs;
    if (delayMs <= 0) {
      this.trace(
        `Turn delay skipped (${normalizedSource}): configured delay is ${delayMs}ms.`
      );
      return resolved;
    }
    const initialResolved = resolved;

    let semanticSummary = null;
    const semanticEnabled =
      isOpenAiSttSource &&
      this.sessionConfig?.semanticEotEnabled &&
      this.semanticTurnDetector;
    if (semanticEnabled) {
      const semantic = await this.semanticTurnDetector.evaluate(resolved, {
        isFirstUserTurn
      });
      if (semantic) {
        const minDelayMs = Math.max(
          120,
          Number(this.sessionConfig?.semanticEotMinDelayMs || 250)
        );
        const maxDelayMs = Math.max(
          minDelayMs,
          Number(this.sessionConfig?.semanticEotMaxDelayMs || 900)
        );
        delayMs = Math.max(
          minDelayMs,
          Math.min(maxDelayMs, Number(semantic.recommendedDelayMs || delayMs))
        );
        semanticSummary = semantic;
      }
    }
    this.trace(
      `Turn delay start (${normalizedSource}): targetSilenceMs=${delayMs}, continuationSilenceMs=${continuationSilenceMs}, postTurnDelayMs=${configuredDelayMs}${
        semanticSummary
          ? `, semanticStatus=${semanticSummary.status}, semanticReason=${semanticSummary.reason}, semanticLlm=${Boolean(
              semanticSummary.llmUsed
            )}`
          : ""
      }.`
    );

    const isIncompleteIntakeStub = isLikelyIncompleteIntakeStub(resolved);
    if (isOpenAiSttSource && isIncompleteIntakeStub) {
      delayMs = Math.max(delayMs, 2800);
      this.trace(
        `Turn delay extended for incomplete intake stub (${normalizedSource}) to ${delayMs}ms.`
      );
    }
    if (isOpenAiSttSource) {
      const segmentMaxMs = Math.max(
        400,
        Number(this.sessionConfig?.openaiSttSegmentMaxMs || 15000)
      );
      const currentSegmentDurationMs = Number(initialSegmentDurationMs || 0);
      const likelyForcedByMaxDuration =
        Number.isFinite(currentSegmentDurationMs) &&
        currentSegmentDurationMs >= Math.max(240, segmentMaxMs - 220);
      if (likelyForcedByMaxDuration) {
        // When a segment is force-flushed by max duration, wait for the next
        // segment so long monologues are merged before generating a reply.
        delayMs = Math.max(
          delayMs,
          Math.min(30000, segmentMaxMs + continuationSilenceMs)
        );
        this.trace(
          `Turn delay extended for max-duration flush (${normalizedSource}): segmentDurationMs=${currentSegmentDurationMs}, delayMs=${delayMs}.`
        );
      }
    }

    const openAiChunkMs = Number(this.sessionConfig?.openaiSttChunkMs || 1200);
    const chunkAllowanceMs = isOpenAiSttSource
      ? Math.min(500, Math.max(120, openAiChunkMs))
      : openAiChunkMs;

    const hardMaxWaitMs = Math.max(
      delayMs,
      Math.min(
        10000,
        delayMs + chunkAllowanceMs
      )
    );

    const stitchState = {
      lastTurnAtMs: Number.isFinite(Number(initialTurnAtMs))
        ? Number(initialTurnAtMs)
        : Date.now()
    };

    let lastSemanticComparable = normalizeComparableText(resolved);
    const startedAt = Date.now();
    while (Date.now() - startedAt < hardMaxWaitMs) {
      resolved = this.consumeExpandedQueueText({
        source,
        currentText: resolved,
        includeTurnFinal: true,
        stitchState
      });

      if (semanticEnabled) {
        const comparable = normalizeComparableText(resolved);
        if (comparable && comparable !== lastSemanticComparable) {
          lastSemanticComparable = comparable;
          const semantic = await this.semanticTurnDetector.evaluate(resolved, {
            isFirstUserTurn
          });
          if (semantic) {
            const minDelayMs = Math.max(
              120,
              Number(this.sessionConfig?.semanticEotMinDelayMs || 250)
            );
            const maxDelayMs = Math.max(
              minDelayMs,
              Number(this.sessionConfig?.semanticEotMaxDelayMs || 900)
            );
            const nextDelayMs = Math.max(
              minDelayMs,
              Math.min(maxDelayMs, Number(semantic.recommendedDelayMs || delayMs))
            );
            if (nextDelayMs !== delayMs) {
              this.trace(
                `Semantic EoT delay updated (${normalizedSource}): ${delayMs}ms -> ${nextDelayMs}ms (status=${semantic.status}, reason=${semantic.reason}).`
              );
            }
            delayMs = nextDelayMs;
          }
        }
      }

      if (this.isStopping || this.status !== "running") {
        this.trace(
          `Turn delay stopped early (${normalizedSource}): session status=${this.status}, isStopping=${this.isStopping}.`
        );
        break;
      }

      const silenceMs = this.getSourceSilenceMs(source);
      if (silenceMs >= delayMs) {
        break;
      }

      const remainingMs = delayMs - silenceMs;
      if (remainingMs <= 0) {
        break;
      }
      await sleep(Math.min(140, Math.max(40, remainingMs)));
    }

    resolved = this.consumeExpandedQueueText({
      source,
      currentText: resolved,
      includeTurnFinal: true,
      stitchState
    });
    const allowShortFirstGreeting =
      isFirstUserTurn && isLikelyGreetingOrPing(resolved);
    if (isLikelyIncompleteIntakeStub(resolved) && !allowShortFirstGreeting) {
      this.trace(
        `Turn delay result dropped (${normalizedSource}): still incomplete stub ("${truncateForLog(
          resolved,
          140
        )}").`
      );
      return "";
    }
    this.trace(
      `Turn delay done (${normalizedSource}): waited=${Date.now() - startedAt}ms, initial="${truncateForLog(
        initialResolved,
        120
      )}", final="${truncateForLog(resolved, 140)}".`
    );
    return normalizeText(resolved);
  }

  consumeExpandedQueueText({
    source,
    currentText,
    includeTurnFinal = false,
    stitchState = null
  }) {
    if (!Array.isArray(this.queue) || this.queue.length === 0) {
      return currentText;
    }

    let resolvedText = currentText;
    const consumedIndexes = [];
    let resolvedComparable = normalizeComparableText(resolvedText);
    const turnStitchEnabled =
      includeTurnFinal && this.sessionConfig?.turnStitchEnabled !== false;
    const turnStitchWindowMs = Math.max(
      200,
      Number(this.sessionConfig?.turnStitchWindowMs || 1100)
    );

    for (let index = 0; index < this.queue.length; index += 1) {
      const item = this.queue[index];
      if (
        !item ||
        item.source !== source ||
        (item.isTurnFinal && !includeTurnFinal)
      ) {
        continue;
      }

      const queuedText = normalizeText(item.text);
      if (!queuedText) {
        consumedIndexes.push(index);
        continue;
      }

      const queuedComparable = normalizeComparableText(queuedText);
      if (!queuedComparable) {
        consumedIndexes.push(index);
        continue;
      }
      const queuedAtMs = Number.isFinite(Number(item.receivedAtMs))
        ? Number(item.receivedAtMs)
        : Date.now();

      if (resolvedComparable === queuedComparable) {
        resolvedText = queuedText;
        resolvedComparable = queuedComparable;
        consumedIndexes.push(index);
        if (stitchState && Number.isFinite(queuedAtMs)) {
          stitchState.lastTurnAtMs = queuedAtMs;
        }
        continue;
      }

      const isExpansion =
        queuedComparable.startsWith(resolvedComparable) ||
        resolvedComparable.startsWith(queuedComparable);
      if (isExpansion) {
        const previousResolvedText = resolvedText;
        if (queuedComparable.length >= resolvedComparable.length) {
          resolvedText = queuedText;
          resolvedComparable = queuedComparable;
        }
        this.trace(
          `Turn text expanded from queue (${source}, final=${Boolean(
            item.isTurnFinal
          )}): "${truncateForLog(previousResolvedText, 100)}" -> "${truncateForLog(
            resolvedText,
            100
          )}".`
        );
        consumedIndexes.push(index);
        if (stitchState && Number.isFinite(queuedAtMs)) {
          stitchState.lastTurnAtMs = queuedAtMs;
        }
        continue;
      }

      const shouldStitchAdjacentFinals =
        turnStitchEnabled &&
        item.isTurnFinal &&
        countWords(queuedText) >= 2 &&
        countWords(resolvedText) >= 2 &&
        isLikelyIncompleteFragment(resolvedText, {
          minWordsForComplete: 4
        }) &&
        isWithinTurnStitchWindow(
          stitchState?.lastTurnAtMs,
          queuedAtMs,
          turnStitchWindowMs
        );

      if (shouldStitchAdjacentFinals) {
        const previousResolvedText = resolvedText;
        const stitched = normalizeText(`${resolvedText} ${queuedText}`);
        if (stitched && stitched !== resolvedText) {
          resolvedText = stitched;
          resolvedComparable = normalizeComparableText(stitched);
        }
        this.trace(
          `Turn stitch applied (${source}): "${truncateForLog(
            previousResolvedText,
            100
          )}" + "${truncateForLog(queuedText, 100)}" -> "${truncateForLog(
            resolvedText,
            120
          )}".`
        );
        consumedIndexes.push(index);
        if (stitchState && Number.isFinite(queuedAtMs)) {
          stitchState.lastTurnAtMs = queuedAtMs;
        }
      }
    }

    if (consumedIndexes.length > 0) {
      consumedIndexes.sort((a, b) => b - a);
      for (const index of consumedIndexes) {
        this.queue.splice(index, 1);
      }
    }

    return resolvedText;
  }

  async runCallSummaryWorkflow(turns) {
    if (!this.sessionConfig?.callSummaryEnabled) {
      return;
    }
    if (!Array.isArray(turns) || turns.length === 0) {
      this.info("Skipping call summary: no user/bot turns captured.");
      return;
    }

    try {
      const summaryResult = await withTimeout(
        summarizeCallWithGraph({
          apiKey: this.sessionConfig.openaiApiKey,
          model: this.sessionConfig.callSummaryModel,
          temperature: this.sessionConfig.callSummaryTemperature,
          conversationTurns: turns,
          sessionId: this.sessionId,
          meetUrl: this.sessionConfig.meetUrl,
          projectContext: this.sessionConfig.projectContext,
          maxTurns: this.sessionConfig.callSummaryMaxTurns,
          maxTranscriptChars: this.sessionConfig.callSummaryMaxTranscriptChars,
          maxOutputChars: this.sessionConfig.callSummaryMaxOutputChars
        }),
        this.sessionConfig.callSummaryTimeoutMs,
        "Call summary workflow"
      );

      if (!summaryResult?.summary) {
        this.warn("Call summary workflow finished with empty output.");
        return;
      }

      log(
        `CALL-SUMMARY:${this.sessionId}`,
        `Generated from ${summaryResult.turnsCount} turns:\n${summaryResult.summary}`
      );
    } catch (err) {
      this.warn(`Call summary workflow failed: ${err?.message || err}`);
    }
  }

  trace(message) {
    if (this.sessionConfig?.verboseSessionLogs === false) {
      return;
    }
    this.info(message);
  }

  traceInboundDrop({ source, reason, text, extra = "" }) {
    if (this.sessionConfig?.verboseSessionLogs === false) {
      return;
    }
    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    const details = extra ? ` ${extra}` : "";
    const preview = truncateForLog(text, 140);
    this.info(
      `Inbound transcript dropped (${normalizedSource}): ${reason}${details}${
        preview ? ` | "${preview}"` : ""
      }`
    );
  }

  info(message) {
    log(`SESSION:${this.sessionId}`, message);
  }

  warn(message) {
    warn(`SESSION:${this.sessionId}`, message);
  }

  error(message) {
    error(`SESSION:${this.sessionId}`, message);
  }

  bridge(message) {
    log(`BRIDGE:${this.sessionId}`, message);
  }

  stt(message) {
    log(`STT:${this.sessionId}`, message);
  }

  user(message) {
    log(`USER:${this.sessionId}`, message);
  }

  bot(message) {
    log(`BOT:${this.sessionId}`, message);
  }
}

module.exports = {
  BotSession
};

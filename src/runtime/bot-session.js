const { startBridgeServer } = require("../bridge-server");
const { createResponder } = require("../responder-factory");
const { launchBrowser } = require("../meet-controller");
const { createTransportAdapter } = require("../transports/transport-factory");
const { OpenAiSttTurnStream } = require("../openai-stt-service");
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
    this.activeSttSource = "";
    this.lastBridgeRecoveryAtMs = 0;
    this.hasProcessedUserTurn = false;
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
    this.activeSttSource = "";
    this.lastBridgeRecoveryAtMs = 0;
    this.hasProcessedUserTurn = false;

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

    this.info("Starting bridge server...");
    const { server } = await startBridgeServer(
      this.sessionConfig.bridgePort,
      this.sessionConfig.bridgeHost
    );
    this.server = server;

    this.info("Starting AI responder...");
    const responder = createResponder({
      runtime: this.sessionConfig.agentRuntime,
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
    this.processQueueHandler = async () => {
      await this.processQueue(responder);
    };

    this.info(
      `TTS mode: OpenAI (${this.sessionConfig.openaiTtsModel}, voice=${this.sessionConfig.openaiTtsVoice}, format=${this.sessionConfig.openaiTtsFormat})`
    );
    this.info(`Agent runtime: ${this.sessionConfig.agentRuntime}.`);
    if (this.sessionConfig.projectContext) {
      this.info("Project context attached to this session.");
    }

    const handleBridgeEvent = (event = {}) => {
      const source = normalizeText(event.source || "openai-stt") || "openai-stt";
      const type = normalizeText(event.type || "").toLowerCase();
      const text = normalizeText(event.text || "");

      if (text) {
        this.markSourceActivity(source);
      }

      if (type === "transcript.partial" && text) {
        if (this.sessionConfig?.openaiSttLogPartials) {
          this.stt(`[${source}] partial: ${text}`);
        }
        if (this.sessionConfig?.bargeInOnPartials) {
          this.maybeInterruptAssistantOutput({
            source,
            text,
            reason: "partial-transcript"
          });
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
        if (!text || this.isLikelyBotEcho(text)) {
          return;
        }
        const accepted = this.enqueueTranscript(text, source, {
          isTurnFinal: true,
          receivedAtMs: event.ts,
          segmentDurationMs: event.segmentDurationMs
        });
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
        onAudioChunk: (payload) => this.openAiSttStream?.enqueueChunk(payload),
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
        `OpenAI STT turn settings: turnSilenceMs=${openAiTurnSilenceMs}, vadThreshold=${this.sessionConfig.openaiSttVadThreshold}, hangoverMs=${this.sessionConfig.openaiSttHangoverMs}, segmentMinMs=${this.sessionConfig.openaiSttSegmentMinMs}, segmentMaxMs=${this.sessionConfig.openaiSttSegmentMaxMs}.`
      );
      const started = await this.transportAdapter.startStt({
        chunkMs: this.sessionConfig.openaiSttChunkMs,
        mimeType: this.sessionConfig.openaiSttMimeType,
        deviceId: this.sessionConfig.openaiSttDeviceId,
        deviceLabel: this.sessionConfig.openaiSttDeviceLabel,
        preferLoopback: this.sessionConfig.openaiSttPreferLoopback,
        audioBitsPerSecond: this.sessionConfig.openaiSttAudioBitsPerSecond,
        minSignalPeak: this.sessionConfig.openaiSttMinSignalPeak,
        vadThreshold: this.sessionConfig.openaiSttVadThreshold,
        hangoverMs: this.sessionConfig.openaiSttHangoverMs,
        segmentMinMs: this.sessionConfig.openaiSttSegmentMinMs,
        segmentMaxMs: this.sessionConfig.openaiSttSegmentMaxMs
      });
      if (!started) {
        throw new Error("OpenAI STT audio capture could not be started in bridge page.");
      }
      this.info(
        `OpenAI STT turn streaming enabled (model=${this.sessionConfig.openaiSttModel}).`
      );
      this.activeSttSource = "bridge-input";

      this.status = "running";
      this.info(
        "Bot is running. If WAKE_WORD is set, only phrases containing it will be processed."
      );
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
        this.bridgePage = null;
        this.meetPage = null;
        this.meetJoinState = null;
        this.activeSttSource = "";
        this.responder = null;
        this.lastAcceptedText = "";
        this.lastAcceptedAtMs = 0;
        this.lastUserTurnText = "";
        this.pendingContinuationBaseText = "";
        this.pendingContinuationSetAtMs = 0;
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
      return true;
    }

    const key = normalizeText(source || "unknown") || "unknown";
    const now = Date.now();
    const loose = normalizeLooseComparableText(text);
    if (!loose) {
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
        return;
      }

      if (!item.isTurnFinal) {
        return;
      }

      const meetJoinStatus = normalizeText(this.meetJoinState?.status || "")
        .toLowerCase()
        .trim();
      const shouldIgnoreUntilMeetJoined =
        item.source === "openai-stt" &&
        this.meetPage &&
        meetJoinStatus !== "joined";
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
        return;
      }
      if (
        isLikelyIncompleteFragment(commandText, {
          minWordsForComplete: 4
        }) &&
        countWords(commandText) <= 2 &&
        !(!this.hasProcessedUserTurn && isLikelyGreetingOrPing(commandText))
      ) {
        return;
      }

      const now = Date.now();
      if (
        commandText.toLowerCase() === this.lastAcceptedText.toLowerCase() &&
        now - this.lastAcceptedAtMs < 4000
      ) {
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
      await this.respondToCommand({
        responder,
        source: item.source,
        commandText
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

    this.joinStateMonitorPromise = (async () => {
      while (!this.joinStateMonitorStopRequested) {
        if (
          this.status !== "running" ||
          this.isStopping ||
          !this.transportAdapter ||
          !this.meetPage ||
          this.meetPage.isClosed()
        ) {
          break;
        }

        await sleep(pollMs);
        if (this.joinStateMonitorStopRequested || this.status !== "running") {
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
        this.joinStateMonitorPromise = null;
      });
  }

  async stopJoinStateMonitor() {
    this.joinStateMonitorStopRequested = true;
    const monitorPromise = this.joinStateMonitorPromise;
    if (!monitorPromise) {
      return;
    }
    try {
      await Promise.race([monitorPromise, sleep(1200)]);
    } catch (_) {
      // Ignore monitor shutdown errors.
    }
    this.joinStateMonitorPromise = null;
  }

  async runAutoGreeting({ responder }) {
    if (!this.sessionConfig?.autoGreetingEnabled) {
      return;
    }

    const delayMs = Math.max(
      0,
      Number(this.sessionConfig.autoGreetingDelayMs || 0)
    );
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    if (this.status !== "running" || this.isStopping) {
      return;
    }
    if (this.meetJoinState?.status !== "joined") {
      return;
    }
    if (this.hasProcessedUserTurn) {
      return;
    }
    const hasPendingUserInput = this.queue.some((item) =>
      Boolean(normalizeText(item?.text || ""))
    );
    if (hasPendingUserInput) {
      return;
    }

    const prompt = normalizeText(this.sessionConfig.autoGreetingPrompt);
    if (!prompt) {
      return;
    }

    try {
      await this.respondToCommand({
        responder,
        source: "system",
        commandText: prompt
      });
    } catch (err) {
      this.warn(`Auto greeting failed: ${err?.message || err}`);
    }
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
        mimeType: this.sessionConfig.openaiSttMimeType,
        deviceId: this.sessionConfig.openaiSttDeviceId,
        deviceLabel: this.sessionConfig.openaiSttDeviceLabel,
        preferLoopback: this.sessionConfig.openaiSttPreferLoopback,
        audioBitsPerSecond: this.sessionConfig.openaiSttAudioBitsPerSecond,
        minSignalPeak: this.sessionConfig.openaiSttMinSignalPeak,
        vadThreshold: this.sessionConfig.openaiSttVadThreshold,
        hangoverMs: this.sessionConfig.openaiSttHangoverMs,
        segmentMinMs: this.sessionConfig.openaiSttSegmentMinMs,
        segmentMaxMs: this.sessionConfig.openaiSttSegmentMaxMs
      });

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

  async respondToCommand({ responder, source, commandText }) {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const abortController = new AbortController();
    const llmStartedAtMs = Date.now();
    let firstTextChunkAtMs = 0;
    this.activeAssistantRun = {
      id: runId,
      source,
      startedAt: Date.now(),
      abortController,
      firstAudioAtMs: 0
    };

    let playbackChain = Promise.resolve();
    const queueChunkPlayback = (chunkText) => {
      const text = normalizeText(chunkText);
      if (!text) {
        return;
      }
      if (!firstTextChunkAtMs) {
        firstTextChunkAtMs = Date.now();
      }

      playbackChain = playbackChain
        .then(() =>
          this.playAssistantChunk({
            responder,
            text,
            runId,
            signal: abortController.signal
          })
        )
        .catch((err) => {
          if (!isAbortErrorLike(err)) {
            this.warn(`Chunk playback failed: ${err?.message || err}`);
          }
        });
    };

    let streamResult = null;
    try {
      try {
        streamResult = await responder.streamReply(commandText, {
          signal: abortController.signal,
          onTextChunk: async (chunk) => {
            queueChunkPlayback(chunk);
          }
        });
      } catch (streamErr) {
        if (!isAbortErrorLike(streamErr)) {
          throw streamErr;
        }
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
      }
    } finally {
      if (this.activeAssistantRun?.id === runId) {
        this.activeAssistantRun = null;
      }
    }
  }

  async playAssistantChunk({ responder, text, runId, signal }) {
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

    try {
      const timedAudio = await withTimeout(
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

  maybeInterruptAssistantOutput({ source, text, reason }) {
    if (!this.sessionConfig?.bargeInEnabled) {
      return;
    }

    if (!text || !this.activeAssistantRun || this.isStopping) {
      return;
    }
    const normalizedSource = normalizeText(source || "unknown") || "unknown";
    if (normalizedSource === "openai-stt") {
      const minWords = Math.max(
        1,
        Number(this.sessionConfig?.bargeInMinWordsOpenAiStt || 2)
      );
      if (countWords(text) < minWords) {
        return;
      }
    }
    if (this.isLikelyBotEcho(text)) {
      return;
    }
    if (this.activeAssistantRun.abortController?.signal?.aborted) {
      return;
    }

    const elapsedMs = Date.now() - Number(this.activeAssistantRun.startedAt || 0);
    const minBargeInMs = Number(this.sessionConfig.bargeInMinMs || 0);
    if (elapsedMs < minBargeInMs) {
      return;
    }

    this.markPendingUserContinuation({
      source: normalizedSource,
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
      return normalizedCurrent;
    }

    this.pendingContinuationBaseText = "";
    this.pendingContinuationSetAtMs = 0;
    return mergeUserContinuationText(base, normalizedCurrent);
  }

  async interruptAssistantRun(reason = "interrupted") {
    const run = this.activeAssistantRun;
    if (!run || run.abortController?.signal?.aborted) {
      return false;
    }

    run.abortController.abort();
    try {
      if (this.transportAdapter && this.bridgePage) {
        await this.transportAdapter.stopSpeaking();
      }
    } catch (_) {
      // Ignore playback interruption transport errors.
    }

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
      ? Math.max(500, continuationSilenceMsRaw)
      : 3000;

    let delayMs = isOpenAiSttSource
      ? continuationSilenceMs
      : configuredDelayMs;
    if (delayMs <= 0) {
      return resolved;
    }

    const isIncompleteIntakeStub = isLikelyIncompleteIntakeStub(resolved);
    if (isOpenAiSttSource && isIncompleteIntakeStub) {
      delayMs = Math.max(delayMs, 2800);
    }
    if (isOpenAiSttSource) {
      const segmentMaxMs = Math.max(
        400,
        Number(this.sessionConfig?.openaiSttSegmentMaxMs || 15000)
      );
      const currentSegmentDurationMs = Number(initialSegmentDurationMs || 0);
      const likelyForcedByMaxDuration =
        Number.isFinite(currentSegmentDurationMs) &&
        currentSegmentDurationMs >= Math.max(1000, segmentMaxMs - 250);
      if (likelyForcedByMaxDuration) {
        // When a segment is force-flushed by max duration, wait for the next
        // segment so long monologues are merged before generating a reply.
        delayMs = Math.max(
          delayMs,
          Math.min(30000, segmentMaxMs + continuationSilenceMs)
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

    const startedAt = Date.now();
    while (Date.now() - startedAt < hardMaxWaitMs) {
      resolved = this.consumeExpandedQueueText({
        source,
        currentText: resolved,
        includeTurnFinal: true,
        stitchState
      });

      if (this.isStopping || this.status !== "running") {
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
      return "";
    }
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
        if (queuedComparable.length >= resolvedComparable.length) {
          resolvedText = queuedText;
          resolvedComparable = queuedComparable;
        }
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
        const stitched = normalizeText(`${resolvedText} ${queuedText}`);
        if (stitched && stitched !== resolvedText) {
          resolvedText = stitched;
          resolvedComparable = normalizeComparableText(stitched);
        }
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

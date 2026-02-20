const test = require("node:test");
const assert = require("node:assert/strict");
const { BotSession } = require("../src/runtime/bot-session");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("inbound dedup keeps transcript expansions for better recognition", () => {
  const session = new BotSession({ config: {} });
  session.sessionConfig = { inboundDedupMs: 10000 };

  const first = session.shouldDropInboundTranscript({
    source: "openai-stt",
    text: "my name is"
  });
  const expanded = session.shouldDropInboundTranscript({
    source: "openai-stt",
    text: "my name is vlad"
  });

  assert.equal(first, false);
  assert.equal(expanded, false);
});

test("inbound dedup drops exact transcript duplicates", () => {
  const session = new BotSession({ config: {} });
  session.sessionConfig = { inboundDedupMs: 10000 };

  const first = session.shouldDropInboundTranscript({
    source: "openai-stt",
    text: "my budget is 10000 usd"
  });
  const second = session.shouldDropInboundTranscript({
    source: "openai-stt",
    text: "my budget is 10000 usd"
  });

  assert.equal(first, false);
  assert.equal(second, true);
});

test("consumeExpandedQueueText can merge turn.final transcript expansions", () => {
  const session = new BotSession({ config: {} });
  session.queue = [
    {
      text: "my name is vlad",
      source: "openai-stt",
      isTurnFinal: true,
      receivedAtMs: Date.now()
    }
  ];

  const resolved = session.consumeExpandedQueueText({
    source: "openai-stt",
    currentText: "my name is",
    includeTurnFinal: true
  });

  assert.equal(resolved, "my name is vlad");
  assert.equal(session.queue.length, 0);
});

test("consumeExpandedQueueText stitches adjacent final turns for incomplete phrase", () => {
  const session = new BotSession({ config: {} });
  const baseTs = Date.now();
  session.sessionConfig = {
    turnStitchEnabled: true,
    turnStitchWindowMs: 1200
  };
  session.queue = [
    {
      text: "I need help with my project and",
      source: "openai-stt",
      isTurnFinal: true,
      receivedAtMs: baseTs
    },
    {
      text: "I can spend around ten thousand dollars",
      source: "openai-stt",
      isTurnFinal: true,
      receivedAtMs: baseTs + 400
    }
  ];

  const resolved = session.consumeExpandedQueueText({
    source: "openai-stt",
    currentText: "I need help with my project and",
    includeTurnFinal: true,
    stitchState: { lastTurnAtMs: baseTs }
  });

  assert.equal(
    resolved,
    "I need help with my project and I can spend around ten thousand dollars"
  );
  assert.equal(session.queue.length, 0);
});

test("waitForPostTurnResponseDelay keeps latest final transcript expansion", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    postTurnResponseDelayMs: 60,
    turnContinuationSilenceMs: 60,
    openaiSttChunkMs: 120
  };
  session.markSourceActivity("openai-stt");
  session.queue.push({
    text: "tell me a joke",
    source: "openai-stt",
    isTurnFinal: true
  });

  const resolved = await session.waitForPostTurnResponseDelay({
    source: "openai-stt",
    commandText: "tell me"
  });

  assert.equal(resolved, "tell me a joke");
});

test("waitForPostTurnResponseDelay respects continuation silence for openai-stt", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    postTurnResponseDelayMs: 10,
    turnContinuationSilenceMs: 140,
    openaiSttChunkMs: 1200
  };

  session.markSourceActivity("openai-stt");
  const startedAt = Date.now();
  const resolved = await session.waitForPostTurnResponseDelay({
    source: "openai-stt",
    commandText: "I need help with a proposal"
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(resolved, "I need help with a proposal");
  assert.ok(elapsedMs >= 100);
});

test("waitForPostTurnResponseDelay extends wait for max-duration STT segment", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    turnContinuationSilenceMs: 80,
    openaiSttSegmentMaxMs: 400,
    openaiSttChunkMs: 100
  };

  session.markSourceActivity("openai-stt");
  const startedAt = Date.now();
  const resolved = await session.waitForPostTurnResponseDelay({
    source: "openai-stt",
    commandText: "long sentence fragment",
    initialSegmentDurationMs: 390
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(resolved, "long sentence fragment");
  assert.ok(elapsedMs >= 350);
});

test("waitForPostTurnResponseDelay drops incomplete intake stubs", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    postTurnResponseDelayMs: 300,
    turnContinuationSilenceMs: 80,
    openaiSttChunkMs: 1200
  };

  session.markSourceActivity("openai-stt");
  const resolved = await session.waitForPostTurnResponseDelay({
    source: "openai-stt",
    commandText: "hi, my name is"
  });
  assert.equal(resolved, "");

  session.markSourceActivity("openai-stt");
  const resolvedBudget = await session.waitForPostTurnResponseDelay({
    source: "openai-stt",
    commandText: "my project budget is"
  });
  assert.equal(resolvedBudget, "");
});

test("runAutoGreeting uses prompt-driven opening", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.meetJoinState = { status: "joined" };
  session.sessionConfig = {
    autoGreetingEnabled: true,
    autoGreetingDelayMs: 0,
    autoGreetingPrompt:
      "System event: The call is connected and the user is silent. Start naturally."
  };
  session.lastSourceActivityAtMs = {};

  const calls = [];
  session.respondToCommand = async ({ source, commandText }) => {
    calls.push({ source, commandText });
  };

  await session.runAutoGreeting({ responder: {} });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "system");
  assert.equal(
    calls[0].commandText,
    "System event: The call is connected and the user is silent. Start naturally."
  );
});

test("runAutoGreeting skips when meet is not joined", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.meetJoinState = { status: "unknown" };
  session.sessionConfig = {
    autoGreetingEnabled: true,
    autoGreetingDelayMs: 0,
    autoGreetingPrompt: "hello"
  };

  const calls = [];
  session.respondToCommand = async ({ source, commandText }) => {
    calls.push({ source, commandText });
  };

  await session.runAutoGreeting({ responder: {} });

  assert.equal(calls.length, 0);
});

test("runAutoGreeting is deduplicated across concurrent triggers", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.meetJoinState = { status: "joined" };
  session.sessionConfig = {
    autoGreetingEnabled: true,
    autoGreetingDelayMs: 0,
    autoGreetingPrompt: "hello"
  };

  let calls = 0;
  session.respondToCommand = async () => {
    calls += 1;
    await sleep(40);
  };

  await Promise.all([
    session.runAutoGreeting({ responder: {} }),
    session.runAutoGreeting({ responder: {} })
  ]);

  assert.equal(calls, 1);
  assert.equal(session.autoGreetingCompleted, true);
});

test("consumePendingUserContinuation merges previous user turn after barge-in", () => {
  const session = new BotSession({ config: {} });
  session.sessionConfig = {
    bargeInContinuationWindowMs: 20000
  };
  session.lastUserTurnText = "I need help with the real estate bot";
  session.markPendingUserContinuation({
    source: "openai-stt",
    text: "and the budget is twenty thousand"
  });

  const merged = session.consumePendingUserContinuation({
    source: "openai-stt",
    currentText: "and the budget is twenty thousand"
  });

  assert.equal(
    merged,
    "I need help with the real estate bot and the budget is twenty thousand"
  );
});

test("consumePendingUserContinuation skips stale pending continuation", () => {
  const session = new BotSession({ config: {} });
  session.sessionConfig = {
    bargeInContinuationWindowMs: 1000
  };
  session.pendingContinuationBaseText = "my previous sentence";
  session.pendingContinuationSetAtMs = Date.now() - 5000;

  const merged = session.consumePendingUserContinuation({
    source: "openai-stt",
    currentText: "new sentence"
  });

  assert.equal(merged, "new sentence");
  assert.equal(session.pendingContinuationBaseText, "");
  assert.equal(session.pendingContinuationSetAtMs, 0);
});

test("soft interrupt ducks assistant audio and restores it if speech is not confirmed", async () => {
  const session = new BotSession({ config: {} });
  const duckingCalls = [];
  session.sessionConfig = {
    bargeInEnabled: true,
    softInterruptEnabled: true,
    softInterruptConfirmMs: 220,
    softInterruptDuckLevel: 0.2,
    bargeInMinMs: 0
  };
  session.bridgePage = { isClosed: () => false };
  session.transportAdapter = {
    setTtsDucking: async (payload) => {
      duckingCalls.push(payload);
      return true;
    }
  };
  session.activeAssistantRun = {
    id: "run_soft_1",
    startedAt: Date.now() - 2000,
    abortController: { signal: { aborted: false } }
  };

  session.maybeStartSoftInterrupt({
    source: "openai-stt",
    reason: "vad-start"
  });
  assert.equal(session.softInterruptActive, true);

  session.handleSoftInterruptStop({
    source: "openai-stt",
    reason: "vad-stop"
  });
  await sleep(280);

  assert.equal(session.softInterruptActive, false);
  assert.equal(
    duckingCalls.some((item) => item?.active === true),
    true
  );
  assert.equal(
    duckingCalls.some((item) => item?.active === false),
    true
  );
});

test("final user turn after soft interrupt triggers hard interruption", async () => {
  const session = new BotSession({ config: {} });
  session.sessionConfig = {
    bargeInEnabled: true,
    bargeInMinMs: 0,
    bargeInMinWordsOpenAiStt: 2
  };
  session.activeAssistantRun = {
    id: "run_soft_2",
    startedAt: Date.now() - 1500,
    abortController: { signal: { aborted: false } }
  };
  session.softInterruptActive = true;
  session.softInterruptRunId = "run_soft_2";
  session.softInterruptSource = "openai-stt";

  let interrupted = false;
  session.interruptAssistantRun = async () => {
    interrupted = true;
    return true;
  };

  session.maybeInterruptAssistantOutput({
    source: "openai-stt",
    text: "hello i need help",
    reason: "final-turn"
  });
  await sleep(10);

  assert.equal(interrupted, true);
  assert.equal(session.softInterruptActive, false);
});

test("waitForPostTurnResponseDelay keeps first short greeting", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    postTurnResponseDelayMs: 300,
    turnContinuationSilenceMs: 80,
    openaiSttChunkMs: 1200
  };

  session.markSourceActivity("openai-stt");
  const resolved = await session.waitForPostTurnResponseDelay({
    source: "openai-stt",
    commandText: "Hi there",
    isFirstUserTurn: true
  });

  assert.equal(resolved, "Hi there");
});

test("startJoinStateMonitor updates join state and triggers auto greeting", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    meetJoinPollMs: 5,
    autoGreetingEnabled: true,
    autoGreetingDelayMs: 0,
    autoGreetingPrompt: "hello"
  };
  session.meetPage = { isClosed: () => false };
  session.transportAdapter = {
    refreshJoinState: async () => ({ status: "joined", url: "https://meet.google.com/abc-defg-hij" })
  };

  let greetingCalls = 0;
  session.runAutoGreeting = async () => {
    greetingCalls += 1;
  };

  session.startJoinStateMonitor({ responder: {} });
  if (session.joinStateMonitorPromise) {
    await session.joinStateMonitorPromise;
  } else {
    await sleep(50);
  }

  assert.equal(session.meetJoinState?.status, "joined");
  assert.equal(greetingCalls, 1);
});

test("startJoinStateMonitor keeps polling on auth_required when MEET_ASSUME_LOGGED_IN=true", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    meetJoinPollMs: 5,
    meetAssumeLoggedIn: true,
    autoGreetingEnabled: true,
    autoGreetingDelayMs: 0,
    autoGreetingPrompt: "hello"
  };
  session.meetPage = { isClosed: () => false };
  let refreshCalls = 0;
  session.transportAdapter = {
    refreshJoinState: async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return { status: "auth_required", url: "https://accounts.google.com/" };
      }
      return { status: "joined", url: "https://meet.google.com/abc-defg-hij" };
    }
  };

  let greetingCalls = 0;
  session.runAutoGreeting = async () => {
    greetingCalls += 1;
  };

  session.startJoinStateMonitor({ responder: {} });
  if (session.joinStateMonitorPromise) {
    await session.joinStateMonitorPromise;
  } else {
    await sleep(80);
  }

  assert.ok(refreshCalls >= 2);
  assert.equal(session.meetJoinState?.status, "joined");
  assert.equal(greetingCalls, 1);
});

test("processQueue ignores openai-stt turns while meet is not joined", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.bridgePage = {};
  session.meetPage = {};
  session.meetJoinState = { status: "prejoin" };
  session.sessionConfig = {
    wakeWord: "",
    postTurnResponseDelayMs: 0
  };
  session.queue = [
    {
      text: "Hello are you there?",
      source: "openai-stt",
      isTurnFinal: true,
      receivedAtMs: Date.now()
    }
  ];

  let called = false;
  await session.processQueue({
    respond: async () => {
      called = true;
      return { text: "x", aborted: false };
    }
  });

  assert.equal(called, false);
  assert.equal(session.queue.length, 0);
});

test("processQueue accepts openai-stt turns on prejoin when MEET_ASSUME_LOGGED_IN=true", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.bridgePage = {};
  session.meetPage = {};
  session.meetJoinState = { status: "prejoin" };
  session.sessionConfig = {
    wakeWord: "",
    postTurnResponseDelayMs: 0,
    meetAssumeLoggedIn: true
  };
  session.queue = [
    {
      text: "Hello are you there?",
      source: "openai-stt",
      isTurnFinal: true,
      receivedAtMs: Date.now()
    }
  ];

  let called = false;
  session.respondToCommand = async () => {
    called = true;
  };
  await session.processQueue({});

  assert.equal(called, true);
  assert.equal(session.queue.length, 0);
});

test("handleConfirmedVadBargeIn interrupts realtime response in realtime mode", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    bargeInOnVadConfirmed: true,
    bargeInEnabled: true,
    bargeInMinMs: 220,
    bargeInVadMinPeak: 0.01
  };
  session.activeVoicePipelineMode = "realtime";
  session.realtimeAdapter = {};
  session.realtimeResponseInProgress = true;
  session.latestPartialsBySource = {
    "openai-stt": {
      text: "sorry wait one sec",
      at: Date.now()
    }
  };

  let interrupted = false;
  session.interruptRealtimeOutput = async () => {
    interrupted = true;
    return true;
  };

  session.handleConfirmedVadBargeIn({
    source: "openai-stt",
    reason: "vad-confirmed",
    speechMs: 260,
    peak: 0.03
  });
  await sleep(20);

  assert.equal(interrupted, true);
});

test("runAutoGreeting uses realtime adapter when realtime mode is active", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.meetJoinState = { status: "joined" };
  session.sessionConfig = {
    autoGreetingEnabled: true,
    autoGreetingDelayMs: 0,
    autoGreetingPrompt: "System: greet the user with one short sentence."
  };
  session.activeVoicePipelineMode = "realtime";
  let called = 0;
  session.realtimeAdapter = {
    createTextTurn: async ({ role, text, createResponse }) => {
      called += 1;
      assert.equal(role, "system");
      assert.equal(createResponse, true);
      assert.equal(text, "System: greet the user with one short sentence.");
      return true;
    }
  };

  await session.runAutoGreeting({ responder: {} });

  assert.equal(called, 1);
  assert.equal(session.autoGreetingCompleted, true);
});

test("realtime intake completion token triggers session stop", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    intakeCompleteToken: "[[INTAKE_COMPLETE]]",
    autoLeaveOnIntakeComplete: true,
    intakeCompleteLeaveDelayMs: 0
  };

  let stopReason = "";
  session.stop = async ({ reason } = {}) => {
    stopReason = String(reason || "");
    session.status = "stopped";
    return session.getStatus();
  };

  session.handleRealtimeAssistantTextFinal({
    responseId: "resp_complete",
    text: "Great, intake is done [[INTAKE_COMPLETE]]"
  });

  await sleep(30);

  assert.equal(stopReason, "intake complete");
  assert.equal(
    session.realtimeAssistantTextByResponseId.resp_complete,
    "Great, intake is done"
  );
});

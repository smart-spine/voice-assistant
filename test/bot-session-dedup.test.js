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

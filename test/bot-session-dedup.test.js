const test = require("node:test");
const assert = require("node:assert/strict");
const { BotSession } = require("../src/runtime/bot-session");

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
      isTurnFinal: true
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

test("waitForPostTurnResponseDelay keeps latest final transcript expansion", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    postTurnResponseDelayMs: 60,
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

test("waitForPostTurnResponseDelay is shortened for high-signal turns", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    postTurnResponseDelayMs: 2000,
    openaiSttChunkMs: 1200
  };

  session.markSourceActivity("openai-stt");
  const startedAt = Date.now();
  const resolved = await session.waitForPostTurnResponseDelay({
    source: "openai-stt",
    commandText: "my name is vlad"
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(resolved, "my name is vlad");
  assert.ok(elapsedMs < 1200);
});

test("waitForPostTurnResponseDelay treats i'm-name as high-signal name turn", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    postTurnResponseDelayMs: 2000,
    openaiSttChunkMs: 1200
  };

  session.markSourceActivity("openai-stt");
  const startedAt = Date.now();
  const resolved = await session.waitForPostTurnResponseDelay({
    source: "openai-stt",
    commandText: "I'm Vlad"
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(resolved, "I'm Vlad");
  assert.ok(elapsedMs < 1200);
});

test("waitForPostTurnResponseDelay drops incomplete intake stubs", async () => {
  const session = new BotSession({ config: {} });
  session.status = "running";
  session.sessionConfig = {
    postTurnResponseDelayMs: 300,
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

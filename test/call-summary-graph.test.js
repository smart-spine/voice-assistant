const test = require("node:test");
const assert = require("node:assert/strict");
const {
  summarizeCallWithGraph,
  sanitizeConversationTurns,
  buildTranscript
} = require("../src/workflows/call-summary-graph");

test("sanitizeConversationTurns keeps only valid user/bot pairs and applies maxTurns", () => {
  const turns = sanitizeConversationTurns(
    [
      { user: "A", bot: "B", source: "x" },
      { user: "", bot: "skip" },
      { user: "C", bot: "D", source: "y" }
    ],
    1
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0].user, "C");
  assert.equal(turns[0].bot, "D");
  assert.equal(turns[0].source, "y");
});

test("buildTranscript creates readable turn blocks", () => {
  const transcript = buildTranscript([
    { source: "openai-stt", user: "Hello", bot: "Hi there" }
  ]);

  assert.match(transcript, /Turn 1 \(openai-stt\):/);
  assert.match(transcript, /User: Hello/);
  assert.match(transcript, /Assistant: Hi there/);
});

test("summarizeCallWithGraph uses graph node and returns summary", async () => {
  let capturedMessages = [];
  const fakeLlm = {
    invoke: async (messages) => {
      capturedMessages = messages;
      return {
        content:
          "1) Client profile\n- Name: Alice\n- Budget: $5000\n2) Key points\n- Wants MVP quickly"
      };
    }
  };

  const result = await summarizeCallWithGraph({
    llm: fakeLlm,
    conversationTurns: [
      { source: "openai-stt", user: "My name is Alice", bot: "Nice to meet you." },
      { source: "openai-stt", user: "Budget is around five thousand", bot: "Noted." }
    ],
    sessionId: "session_test",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    projectContext: "Client wants AI assistant",
    maxTurns: 5
  });

  assert.ok(result);
  assert.equal(result.turnsCount, 2);
  assert.match(result.summary, /Client profile/);
  assert.equal(Array.isArray(capturedMessages), true);
  assert.equal(capturedMessages.length, 2);
  assert.match(String(capturedMessages[1].content || ""), /Session ID: session_test/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { SemanticTurnDetector } = require("../src/semantic-turn-detector");

test("semantic detector marks punctuated sentence as complete", async () => {
  const detector = new SemanticTurnDetector({
    enabled: true,
    useLlm: false,
    minDelayMs: 250,
    maxDelayMs: 900
  });

  const result = await detector.evaluate("I need help with a sales bot.");
  assert.equal(result.status, "complete");
  assert.ok(result.recommendedDelayMs <= 320);
});

test("semantic detector marks trailing connector as incomplete", async () => {
  const detector = new SemanticTurnDetector({
    enabled: true,
    useLlm: false,
    minDelayMs: 250,
    maxDelayMs: 900
  });

  const result = await detector.evaluate("I need help with pricing and");
  assert.equal(result.status, "incomplete");
  assert.ok(result.recommendedDelayMs >= 700);
});


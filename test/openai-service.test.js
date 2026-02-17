const test = require("node:test");
const assert = require("node:assert/strict");
const { consumeStreamingChunks } = require("../src/openai-service");

test("consumeStreamingChunks emits chunk on sentence punctuation", () => {
  const input = "Hello there, this is a streamed sentence. Another part";
  const { chunks, rest } = consumeStreamingChunks(input, {
    minChars: 10,
    targetChars: 20,
    maxChars: 80,
    force: false
  });

  assert.deepEqual(chunks, ["Hello there, this is a streamed sentence."]);
  assert.equal(rest, "Another part");
});

test("consumeStreamingChunks does not split early on comma boundaries", () => {
  const input =
    "I am SmartSpine Bot, a sales discovery assistant. What is your name?";
  const { chunks, rest } = consumeStreamingChunks(input, {
    minChars: 20,
    targetChars: 28,
    maxChars: 120,
    force: false
  });

  assert.deepEqual(chunks, [
    "I am SmartSpine Bot, a sales discovery assistant. What is your name?"
  ]);
  assert.equal(rest, "");
});

test("consumeStreamingChunks keeps short partial text without force", () => {
  const { chunks, rest } = consumeStreamingChunks("small phrase", {
    minChars: 10,
    targetChars: 30,
    maxChars: 60,
    force: false
  });

  assert.deepEqual(chunks, []);
  assert.equal(rest, "small phrase");
});

test("consumeStreamingChunks force-splits long text by max chars", () => {
  const input = "alpha beta gamma delta epsilon zeta eta theta iota";
  const { chunks, rest } = consumeStreamingChunks(input, {
    minChars: 6,
    targetChars: 12,
    maxChars: 20,
    force: true
  });

  assert.equal(chunks.length > 0, true);
  assert.equal(rest.length <= 20, true);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  countWords,
  normalizeText,
  normalizeComparableText,
  normalizeLooseComparableText,
  isTextExpansion,
  isLikelySentenceComplete,
  isLikelyIncompleteFragment,
  extractCommandByWakeWord
} = require("../src/utils/text-utils");

test("normalizeText compresses whitespace", () => {
  assert.equal(normalizeText("  hello   world \n"), "hello world");
});

test("countWords returns token count for normalized text", () => {
  assert.equal(countWords("  hello   world \n"), 2);
  assert.equal(countWords(""), 0);
});

test("normalizeComparableText removes trailing punctuation", () => {
  assert.equal(normalizeComparableText("Hello world!!!"), "hello world");
});

test("normalizeLooseComparableText strips punctuation for robust matching", () => {
  assert.equal(
    normalizeLooseComparableText("Client name — John. Budget: $10,000!"),
    "client name john budget 10 000"
  );
});

test("isTextExpansion detects partial caption growth", () => {
  assert.equal(isTextExpansion("tell me", "tell me a joke"), true);
  assert.equal(isTextExpansion("tell me a joke", "tell me"), false);
});

test("isLikelySentenceComplete requires enough words and punctuation", () => {
  assert.equal(isLikelySentenceComplete("hi."), false);
  assert.equal(isLikelySentenceComplete("how are you?"), true);
});

test("isLikelyIncompleteFragment detects trailing fragments", () => {
  assert.equal(isLikelyIncompleteFragment("how's"), true);
  assert.equal(isLikelyIncompleteFragment("tell me a"), true);
  assert.equal(isLikelyIncompleteFragment("tell me a joke?"), false);
});

test("extractCommandByWakeWord returns tail only", () => {
  assert.equal(
    extractCommandByWakeWord("Hey bot, tell me a joke", "bot"),
    "tell me a joke"
  );
  assert.equal(extractCommandByWakeWord("tell me a joke", "bot"), "");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSystemPrompt,
  normalizeProjectContext
} = require("../src/prompts/prompt-builder");

test("normalizeProjectContext supports string and object", () => {
  assert.equal(normalizeProjectContext("  hello  "), "hello");
  assert.match(
    normalizeProjectContext({ budget: 5000 }),
    /"budget": 5000/
  );
});

test("buildSystemPrompt appends project context section", () => {
  const result = buildSystemPrompt({
    basePrompt: "Base prompt",
    projectContext: { name: "Client A" },
    responseLanguage: "en-US"
  });

  assert.match(result, /^Base prompt/);
  assert.match(result, /Language policy:/);
  assert.match(result, /Respond in English only/);
  assert.match(result, /Additional project context from the intake form:/);
  assert.match(result, /"name": "Client A"/);
});

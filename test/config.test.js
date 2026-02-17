const test = require("node:test");
const assert = require("node:assert/strict");
const { validateSessionConfig, isAllowedMeetUrl } = require("../src/config");

test("isAllowedMeetUrl validates protocol and host", () => {
  assert.equal(
    isAllowedMeetUrl("https://meet.google.com/abc-defg-hij", {
      allowAnyMeetUrl: false
    }),
    true
  );
  assert.equal(
    isAllowedMeetUrl("http://meet.google.com/abc-defg-hij", {
      allowAnyMeetUrl: false
    }),
    false
  );
  assert.equal(
    isAllowedMeetUrl("https://example.com/room", { allowAnyMeetUrl: false }),
    false
  );
  assert.equal(
    isAllowedMeetUrl("https://example.com/room", { allowAnyMeetUrl: true }),
    true
  );
});

test("validateSessionConfig rejects invalid meet URL by default", () => {
  const missing = validateSessionConfig(
    {
      openaiApiKey: "sk-test",
      meetUrl: "https://example.com/room",
      allowAnyMeetUrl: false
    },
    { requireMeetUrl: true }
  );

  assert.ok(
    missing.includes("MEET_URL (must match https://meet.google.com/...)")
  );
});


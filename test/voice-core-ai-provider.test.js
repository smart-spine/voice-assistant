const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OpenAIRealtimeAIProvider
} = require("../src/voice-core/engine/ai-provider");

function createStartedProvider({ runtimeConfig = {} } = {}) {
  const provider = new OpenAIRealtimeAIProvider({
    runtimeConfig
  });
  const sent = [];
  provider.started = true;
  provider.upstream = {
    readyState: 1,
    send(raw) {
      sent.push(JSON.parse(String(raw || "{}")));
    }
  };
  return {
    provider,
    sent
  };
}

test("OpenAIRealtimeAIProvider interrupt sends WS-spec compliant events", async () => {
  const { provider, sent } = createStartedProvider();
  provider.assistantInProgress = true;
  provider.currentResponseId = "resp_test_1";
  provider.currentAssistantItemId = "item_test_1";
  provider.currentAssistantContentIndex = 0;
  provider.currentResponseAudioMs = 640;

  await provider.interrupt({
    reason: "barge_in",
    truncateAudioMs: 320
  });

  const types = sent.map((event) => event?.type);
  assert.deepEqual(types, ["conversation.item.truncate", "response.cancel"]);
  assert.ok(!types.includes("output_audio_buffer.clear"));
});

test("OpenAIRealtimeAIProvider truncation is idempotent per item", async () => {
  const { provider, sent } = createStartedProvider();
  provider.assistantInProgress = true;
  provider.currentResponseId = "resp_test_2";
  provider.currentAssistantItemId = "item_test_2";
  provider.currentAssistantContentIndex = 0;
  provider.currentResponseAudioMs = 900;

  await provider.interrupt({
    reason: "barge_in",
    truncateAudioMs: 450
  });
  await provider.interrupt({
    reason: "barge_in",
    truncateAudioMs: 450
  });

  const truncateEvents = sent.filter(
    (event) => String(event?.type || "") === "conversation.item.truncate"
  );
  const cancelEvents = sent.filter(
    (event) => String(event?.type || "") === "response.cancel"
  );
  assert.equal(truncateEvents.length, 1);
  assert.equal(cancelEvents.length, 2);
});

test("OpenAIRealtimeAIProvider blocks unsupported realtime client event types", async () => {
  const { provider } = createStartedProvider();
  const warnings = [];
  provider.on("warning", (event) => warnings.push(event));

  const ok = provider.sendUpstream({
    type: "output_audio_buffer.clear"
  });

  assert.equal(ok, false);
  assert.ok(
    warnings.some((event) => String(event?.code || "") === "unsupported_client_event")
  );
});

test("OpenAIRealtimeAIProvider defers short forced commit until transcript arrives", async () => {
  const { provider, sent } = createStartedProvider({
    runtimeConfig: {
      voiceCoreMinUserAudioMs: 400,
      voiceCoreMinTranscriptChars: 3,
      voiceCoreShortCommitTranscriptWaitMs: 30
    }
  });

  provider.pendingCommitQueue.push({
    commit_id: "commit_short_1",
    buffered_ms: 160,
    force_response: true
  });

  await provider.handleUpstreamEvent({
    type: "input_audio_buffer.committed"
  });
  assert.equal(
    sent.filter((event) => String(event?.type || "") === "response.create").length,
    0
  );

  await provider.handleUpstreamEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item_short_1",
    transcript: "hello"
  });

  assert.equal(
    sent.filter((event) => String(event?.type || "") === "response.create").length,
    1
  );
});

test("OpenAIRealtimeAIProvider skips short empty commit after transcript timeout", async () => {
  const { provider, sent } = createStartedProvider({
    runtimeConfig: {
      voiceCoreMinUserAudioMs: 400,
      voiceCoreMinTranscriptChars: 3,
      voiceCoreShortCommitTranscriptWaitMs: 120
    }
  });
  const warnings = [];
  provider.on("warning", (event) => warnings.push(event));

  provider.pendingCommitQueue.push({
    commit_id: "commit_short_2",
    buffered_ms: 120,
    force_response: true
  });

  await provider.handleUpstreamEvent({
    type: "input_audio_buffer.committed"
  });
  await new Promise((resolve) => setTimeout(resolve, 170));

  assert.equal(
    sent.filter((event) => String(event?.type || "") === "response.create").length,
    0
  );
  assert.ok(
    warnings.some((event) => String(event?.code || "") === "empty_turn_skipped")
  );
});

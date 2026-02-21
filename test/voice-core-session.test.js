const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const { VoiceSession } = require("../src/voice-core/engine/voice-session");
const { buildEnvelope, createId } = require("../src/voice-core/protocol/envelope");

class FakeTransport {
  constructor() {
    this.controls = [];
    this.audio = [];
    this.closed = false;
  }

  async sendControl(envelope) {
    this.controls.push(envelope);
  }

  async sendAudio(frame) {
    this.audio.push(frame);
  }

  async close() {
    this.closed = true;
  }
}

class FakeAIProvider extends EventEmitter {
  constructor() {
    super();
    this.started = false;
    this.commitCalls = [];
    this.clearCalls = 0;
  }

  async startSession() {
    this.started = true;
    this.emit("session.ready", {
      model: "fake-model",
      t_ms: Date.now()
    });
  }

  async appendInputAudio() {
    if (!this.started) {
      throw new Error("Provider not started.");
    }
  }

  async commitInput({ commitId, bufferedMs }) {
    this.commitCalls.push({ commitId, bufferedMs });

    this.emit("input.committed", {
      commit_id: commitId,
      buffered_ms: bufferedMs,
      source: "upstream",
      t_ms: Date.now()
    });

    this.emit("assistant.state", {
      state: "requested",
      t_ms: Date.now()
    });

    this.emit("assistant.state", {
      state: "speaking",
      response_id: "rsp_1",
      t_ms: Date.now()
    });

    const outputBytes = new Uint8Array(3000);
    this.emit("assistant.audio.chunk", {
      response_id: "rsp_1",
      frame: {
        kind: "output_audio",
        codec: "pcm16",
        seq: 1,
        sample_rate_hz: 24000,
        channels: 1,
        duration_ms: 62,
        bytes: outputBytes
      },
      t_ms: Date.now()
    });

    this.emit("assistant.text.final", {
      response_id: "rsp_1",
      text: "hi",
      t_ms: Date.now()
    });

    this.emit("assistant.state", {
      state: "done",
      response_id: "rsp_1",
      t_ms: Date.now()
    });
  }

  async interrupt({ reason }) {
    this.emit("assistant.state", {
      state: "interrupted",
      reason,
      t_ms: Date.now()
    });
  }

  async clearInputBuffer() {
    this.clearCalls += 1;
    return true;
  }

  async stopSession() {
    this.started = false;
    this.emit("session.state", {
      state: "stopped",
      reason: "stop",
      t_ms: Date.now()
    });
  }
}

test("VoiceSession commits audio and streams assistant output", async () => {
  const transport = new FakeTransport();
  const provider = new FakeAIProvider();

  const session = new VoiceSession({
    sessionId: "vs_test_1",
    runtimeConfig: {
      voiceCoreMinCommitMs: 100,
      voiceCoreMinCommitBytes: 2400,
      voiceCoreMinUserAudioMs: 100,
      semanticEotEnabled: false
    },
    transport,
    aiProvider: provider
  });

  await session.start(
    buildEnvelope({
      type: "session.start",
      msgId: createId("client"),
      payload: {
        client: {
          kind: "ui",
          name: "test",
          version: "1.0.0"
        }
      }
    })
  );

  const inputBytes = new Uint8Array(4000);
  await session.onAudio({
    kind: "input_audio",
    codec: "pcm16",
    seq: 1,
    sample_rate_hz: 24000,
    channels: 1,
    duration_ms: 120,
    bytes: inputBytes
  });

  await session.onControl(
    buildEnvelope({
      type: "audio.commit",
      sessionId: "vs_test_1",
      msgId: createId("client"),
      payload: {
        reason: "manual",
        force_response: true
      }
    })
  );

  assert.equal(provider.commitCalls.length, 1);

  const types = transport.controls.map((item) => item.type);
  assert.ok(types.includes("audio.committed"));
  assert.ok(types.includes("assistant.state"));
  assert.ok(types.includes("assistant.text.final"));
  assert.ok(transport.audio.length >= 1);

  await session.stop({ reason: "test_done" });
  assert.equal(session.getStatus().state, "stopped");
});

test("VoiceSession rejects too-small commit payload", async () => {
  const transport = new FakeTransport();
  const provider = new FakeAIProvider();

  const session = new VoiceSession({
    sessionId: "vs_test_2",
    runtimeConfig: {
      voiceCoreMinCommitMs: 100,
      voiceCoreMinCommitBytes: 2400,
      semanticEotEnabled: false
    },
    transport,
    aiProvider: provider
  });

  await session.start(
    buildEnvelope({
      type: "session.start",
      msgId: createId("client"),
      payload: {
        client: {
          kind: "ui",
          name: "test",
          version: "1.0.0"
        }
      }
    })
  );

  await session.onAudio({
    kind: "input_audio",
    codec: "pcm16",
    seq: 1,
    sample_rate_hz: 24000,
    channels: 1,
    duration_ms: 20,
    bytes: new Uint8Array(600)
  });

  await session.onControl(
    buildEnvelope({
      type: "audio.commit",
      sessionId: "vs_test_2",
      msgId: createId("client"),
      payload: {
        reason: "manual",
        force_response: true
      }
    })
  );

  assert.equal(provider.commitCalls.length, 0);
  const warning = transport.controls.find((item) => item.type === "warning");
  assert.ok(Boolean(warning));

  await session.stop({ reason: "test_done" });
});

test("VoiceSession skips empty turn without forcing model response", async () => {
  const transport = new FakeTransport();
  const provider = new FakeAIProvider();

  const session = new VoiceSession({
    sessionId: "vs_test_empty_turn",
    runtimeConfig: {
      voiceCoreMinCommitMs: 100,
      voiceCoreMinCommitBytes: 2400,
      voiceCoreMinUserAudioMs: 400,
      voiceCoreMinTranscriptChars: 3,
      semanticEotEnabled: false
    },
    transport,
    aiProvider: provider
  });

  await session.start(
    buildEnvelope({
      type: "session.start",
      msgId: createId("client"),
      payload: {
        client: { kind: "ui", name: "test", version: "1.0.0" }
      }
    })
  );

  // 180ms of silence-like PCM (zeros) should not pass empty-turn gate.
  await session.onAudio({
    kind: "input_audio",
    codec: "pcm16",
    seq: 1,
    sample_rate_hz: 24000,
    channels: 1,
    duration_ms: 180,
    bytes: new Uint8Array(9000)
  });

  await session.onControl(
    buildEnvelope({
      type: "audio.commit",
      sessionId: "vs_test_empty_turn",
      msgId: createId("client"),
      payload: {
        reason: "manual",
        force_response: true
      }
    })
  );

  assert.equal(provider.commitCalls.length, 0);
  assert.equal(provider.clearCalls, 1);
  const skippedWarning = transport.controls.find(
    (item) =>
      item.type === "warning" && String(item?.payload?.code || "") === "empty_turn_skipped"
  );
  assert.ok(Boolean(skippedWarning));
  assert.equal(session.getStatus().state, "listening");

  await session.stop({ reason: "test_done" });
});

test("VoiceSession treats invalid_value provider errors as recoverable", async () => {
  const transport = new FakeTransport();
  const provider = new FakeAIProvider();

  const session = new VoiceSession({
    sessionId: "vs_test_recoverable_error",
    runtimeConfig: {
      semanticEotEnabled: false
    },
    transport,
    aiProvider: provider
  });

  await session.start(
    buildEnvelope({
      type: "session.start",
      msgId: createId("client"),
      payload: {
        client: { kind: "ui", name: "test", version: "1.0.0" }
      }
    })
  );

  provider.emit("error", {
    code: "invalid_value",
    message: "Unsupported event type",
    fatal: false,
    t_ms: Date.now()
  });

  // allow async listeners to flush
  await new Promise((resolve) => setTimeout(resolve, 5));

  const warning = transport.controls.find(
    (item) =>
      item.type === "warning" &&
      String(item?.payload?.code || "").toLowerCase() === "invalid_value"
  );
  assert.ok(Boolean(warning));
  assert.notEqual(session.getStatus().state, "error");

  await session.stop({ reason: "test_done" });
});

test("VoiceSession handles interrupt during speaking without entering error", async () => {
  const transport = new FakeTransport();
  const provider = new FakeAIProvider();

  const session = new VoiceSession({
    sessionId: "vs_test_interrupt_recovery",
    runtimeConfig: {
      semanticEotEnabled: false
    },
    transport,
    aiProvider: provider
  });

  await session.start(
    buildEnvelope({
      type: "session.start",
      msgId: createId("client"),
      payload: {
        client: { kind: "ui", name: "test", version: "1.0.0" }
      }
    })
  );

  provider.emit("assistant.state", {
    state: "speaking",
    response_id: "rsp_interrupt",
    t_ms: Date.now()
  });

  await session.onControl(
    buildEnvelope({
      type: "assistant.interrupt",
      sessionId: "vs_test_interrupt_recovery",
      msgId: createId("client"),
      payload: {
        reason: "barge_in",
        played_ms: 220
      }
    })
  );

  const clearEvent = transport.controls.find((item) => item.type === "audio.clear");
  assert.ok(Boolean(clearEvent));
  assert.notEqual(session.getStatus().state, "error");

  await session.stop({ reason: "test_done" });
});

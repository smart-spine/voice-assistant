const test = require("node:test");
const assert = require("node:assert/strict");
const { OpenAiSttTurnStream } = require("../src/openai-stt-service");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("openai stt stream finalizes an expanded turn", async () => {
  const events = [];
  const stream = new OpenAiSttTurnStream({
    apiKey: "sk-test",
    turnSilenceMs: 60,
    minChunkBytes: 0,
    onEvent: (event) => events.push(event)
  });

  const transcripts = ["my name is", "my name is vlad"];
  stream.transcribeBuffer = async () => transcripts.shift() || "";

  stream.enqueueChunk({
    audioBase64: Buffer.from("chunk-1").toString("base64"),
    mimeType: "audio/webm",
    ts: Date.now()
  });
  stream.enqueueChunk({
    audioBase64: Buffer.from("chunk-2").toString("base64"),
    mimeType: "audio/webm",
    ts: Date.now() + 15
  });

  await sleep(180);
  stream.stop({ flush: false });

  const finals = events.filter((event) => event.type === "turn.final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, "my name is vlad");
});

test("openai stt stream ignores duplicate partial chunks", async () => {
  const events = [];
  const stream = new OpenAiSttTurnStream({
    apiKey: "sk-test",
    turnSilenceMs: 60,
    minChunkBytes: 0,
    onEvent: (event) => events.push(event)
  });

  const transcripts = ["budget is 1000 usd", "budget is 1000 usd"];
  stream.transcribeBuffer = async () => transcripts.shift() || "";

  stream.enqueueChunk({
    audioBase64: Buffer.from("chunk-1").toString("base64"),
    mimeType: "audio/webm",
    ts: Date.now()
  });
  stream.enqueueChunk({
    audioBase64: Buffer.from("chunk-2").toString("base64"),
    mimeType: "audio/webm",
    ts: Date.now() + 20
  });

  await sleep(180);
  stream.stop({ flush: false });

  const partials = events.filter((event) => event.type === "transcript.partial");
  assert.equal(partials.length, 1);
  assert.equal(partials[0].text, "budget is 1000 usd");
});

test("openai stt stream emits one final turn for segment-final chunks", async () => {
  const events = [];
  const stream = new OpenAiSttTurnStream({
    apiKey: "sk-test",
    turnSilenceMs: 120,
    minChunkBytes: 0,
    onEvent: (event) => events.push(event)
  });

  const transcripts = ["my name is vlad", "my name is vlad"];
  stream.transcribeBuffer = async () => transcripts.shift() || "";

  stream.enqueueChunk({
    audioBase64: Buffer.from("segment-1").toString("base64"),
    mimeType: "audio/wav",
    ts: Date.now(),
    durationMs: 1400,
    isSegmentFinal: true
  });
  stream.enqueueChunk({
    audioBase64: Buffer.from("segment-2").toString("base64"),
    mimeType: "audio/wav",
    ts: Date.now() + 300,
    durationMs: 1200,
    isSegmentFinal: true
  });

  await sleep(120);
  stream.stop({ flush: false });

  const finals = events.filter((event) => event.type === "turn.final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, "my name is vlad");
});

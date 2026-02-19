const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RealtimeTransportAdapter,
  extractWavPcm16,
  resamplePcm16,
  encodeWavFromPcm16
} = require("../src/transports/realtime-transport-adapter");

function int16ToBuffer(values) {
  const samples = Int16Array.from(values);
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

test("extractWavPcm16 decodes wav payload and keeps sample rate", () => {
  const sourceSamples = Array.from({ length: 160 }, (_, index) =>
    Math.round(Math.sin(index / 8) * 10000)
  );
  const wav = encodeWavFromPcm16(int16ToBuffer(sourceSamples), 48000, 1);
  const decoded = extractWavPcm16(wav);

  assert.equal(decoded.sampleRate, 48000);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.samples.length, sourceSamples.length);
  assert.equal(decoded.samples[12], sourceSamples[12]);
});

test("resamplePcm16 downsamples PCM16 correctly", () => {
  const source = Int16Array.from(Array.from({ length: 480 }, (_, index) => index));
  const downsampled = resamplePcm16(source, 48000, 24000);

  assert.equal(downsampled.length, 240);
  assert.ok(downsampled[0] >= 0);
  assert.ok(downsampled[120] > downsampled[10]);
});

test("appendAudioChunk sends incremental realtime audio and commits on final", async () => {
  const sent = [];
  const adapter = new RealtimeTransportAdapter({
    apiKey: "sk-test",
    model: "gpt-4o-mini-realtime-preview-2024-12-17"
  });
  adapter.started = true;
  adapter.socket = {
    send: (event) => {
      sent.push(event);
    }
  };

  const source = Array.from({ length: 1000 }, (_, index) =>
    Math.round(Math.sin(index / 18) * 12000)
  );
  const partialWav = encodeWavFromPcm16(int16ToBuffer(source.slice(0, 600)), 48000, 1);
  const finalWav = encodeWavFromPcm16(int16ToBuffer(source), 48000, 1);

  await adapter.appendAudioChunk({
    audioBase64: partialWav.toString("base64"),
    isSegmentFinal: false
  });
  await adapter.appendAudioChunk({
    audioBase64: finalWav.toString("base64"),
    isSegmentFinal: true
  });

  assert.equal(sent.length, 4);
  assert.equal(sent[0].type, "input_audio_buffer.append");
  assert.equal(sent[1].type, "input_audio_buffer.append");
  assert.equal(sent[2].type, "input_audio_buffer.commit");
  assert.equal(sent[3].type, "response.create");

  const firstChunkBytes = Buffer.from(sent[0].audio, "base64").length;
  const secondChunkBytes = Buffer.from(sent[1].audio, "base64").length;
  assert.ok(firstChunkBytes > 0);
  assert.ok(secondChunkBytes > 0);
  assert.ok(firstChunkBytes > secondChunkBytes);
});

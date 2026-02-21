const { createId, nowMs } = require("../protocol/envelope");
const {
  normalizeAudioFrame,
  estimatePcm16DurationMs
} = require("../protocol/audio-frame");
const {
  AUDIO_KIND_INPUT,
  AUDIO_KIND_OUTPUT,
  AUDIO_MIN_COMMIT_MS,
  AUDIO_MIN_COMMIT_BYTES
} = require("../protocol/constants");

class AudioPipeline {
  constructor({
    minCommitMs = AUDIO_MIN_COMMIT_MS,
    minCommitBytes = AUDIO_MIN_COMMIT_BYTES
  } = {}) {
    this.minCommitMs = Math.max(40, Math.trunc(Number(minCommitMs) || AUDIO_MIN_COMMIT_MS));
    this.minCommitBytes = Math.max(
      320,
      Math.trunc(Number(minCommitBytes) || AUDIO_MIN_COMMIT_BYTES)
    );

    this.inputFrames = [];
    this.inputBufferedBytes = 0;
    this.inputBufferedMs = 0;

    this.outputFrames = [];
    this.outputBufferedBytes = 0;
    this.outputBufferedMs = 0;

    this.pendingCommits = [];
  }

  appendInputFrame(frame) {
    const normalized = normalizeAudioFrame(frame, {
      defaultKind: AUDIO_KIND_INPUT
    });
    if (normalized.kind !== AUDIO_KIND_INPUT) {
      throw new Error(
        `AudioPipeline.appendInputFrame expects kind=${AUDIO_KIND_INPUT}, got ${normalized.kind}.`
      );
    }

    this.inputFrames.push(normalized);
    this.inputBufferedBytes += normalized.bytes.byteLength;
    this.inputBufferedMs +=
      normalized.duration_ms ||
      estimatePcm16DurationMs({
        byteLength: normalized.bytes.byteLength,
        sampleRateHz: normalized.sample_rate_hz,
        channels: normalized.channels
      });

    return {
      buffered_bytes: this.inputBufferedBytes,
      buffered_ms: this.inputBufferedMs,
      frames: this.inputFrames.length
    };
  }

  appendOutputFrame(frame) {
    const normalized = normalizeAudioFrame(frame, {
      defaultKind: AUDIO_KIND_OUTPUT
    });
    if (normalized.kind !== AUDIO_KIND_OUTPUT) {
      throw new Error(
        `AudioPipeline.appendOutputFrame expects kind=${AUDIO_KIND_OUTPUT}, got ${normalized.kind}.`
      );
    }

    this.outputFrames.push(normalized);
    this.outputBufferedBytes += normalized.bytes.byteLength;
    this.outputBufferedMs += normalized.duration_ms || 0;

    return normalized;
  }

  popOutputFrame() {
    if (this.outputFrames.length === 0) {
      return null;
    }
    const frame = this.outputFrames.shift();
    this.outputBufferedBytes = Math.max(0, this.outputBufferedBytes - frame.bytes.byteLength);
    this.outputBufferedMs = Math.max(0, this.outputBufferedMs - (frame.duration_ms || 0));
    return frame;
  }

  clearOutputFrames() {
    const clearedCount = this.outputFrames.length;
    this.outputFrames = [];
    this.outputBufferedBytes = 0;
    this.outputBufferedMs = 0;
    return {
      cleared_frames: clearedCount
    };
  }

  hasUncommittedInput({ minMs = this.minCommitMs, minBytes = this.minCommitBytes } = {}) {
    return this.inputBufferedMs >= Math.max(0, Number(minMs) || 0) &&
      this.inputBufferedBytes >= Math.max(0, Number(minBytes) || 0);
  }

  consumeCommitSnapshot({
    commitId = "",
    reason = "unknown",
    minMs = this.minCommitMs,
    minBytes = this.minCommitBytes
  } = {}) {
    const requiredMs = Math.max(40, Math.trunc(Number(minMs) || this.minCommitMs));
    const requiredBytes = Math.max(
      320,
      Math.trunc(Number(minBytes) || this.minCommitBytes)
    );

    if (!this.inputFrames.length) {
      return {
        ok: false,
        code: "empty_buffer",
        reason: "Audio input buffer is empty.",
        buffered_ms: 0,
        buffered_bytes: 0
      };
    }

    if (this.inputBufferedMs < requiredMs || this.inputBufferedBytes < requiredBytes) {
      return {
        ok: false,
        code: "buffer_too_small",
        reason: `Audio buffer is too small for commit (${this.inputBufferedMs}ms / ${this.inputBufferedBytes} bytes).`,
        buffered_ms: this.inputBufferedMs,
        buffered_bytes: this.inputBufferedBytes,
        required_ms: requiredMs,
        required_bytes: requiredBytes
      };
    }

    const frames = this.inputFrames;
    this.inputFrames = [];

    const snapshot = {
      commit_id: String(commitId || createId("commit")),
      reason: String(reason || "unknown"),
      created_at_ms: nowMs(),
      frames,
      frame_count: frames.length,
      buffered_ms: this.inputBufferedMs,
      buffered_bytes: this.inputBufferedBytes,
      from_seq: frames[0]?.seq || 0,
      to_seq: frames[frames.length - 1]?.seq || 0
    };

    this.inputBufferedMs = 0;
    this.inputBufferedBytes = 0;

    this.pendingCommits.push(snapshot);

    return {
      ok: true,
      code: "ok",
      snapshot
    };
  }

  ackPendingCommit() {
    if (!this.pendingCommits.length) {
      return null;
    }
    return this.pendingCommits.shift();
  }

  dropPendingCommits({ reason = "drop" } = {}) {
    const dropped = this.pendingCommits.splice(0, this.pendingCommits.length);
    return {
      reason: String(reason || "drop"),
      dropped_count: dropped.length,
      dropped
    };
  }

  getStats() {
    return {
      input: {
        frames: this.inputFrames.length,
        buffered_ms: this.inputBufferedMs,
        buffered_bytes: this.inputBufferedBytes
      },
      output: {
        frames: this.outputFrames.length,
        buffered_ms: this.outputBufferedMs,
        buffered_bytes: this.outputBufferedBytes
      },
      pending_commits: this.pendingCommits.length
    };
  }

  resetAll() {
    this.inputFrames = [];
    this.inputBufferedMs = 0;
    this.inputBufferedBytes = 0;

    this.outputFrames = [];
    this.outputBufferedMs = 0;
    this.outputBufferedBytes = 0;

    this.pendingCommits = [];
  }
}

module.exports = {
  AudioPipeline
};

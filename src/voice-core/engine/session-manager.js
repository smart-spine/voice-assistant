const { EventEmitter } = require("events");
const { log, warn, error } = require("../../logger");
const { createId } = require("../protocol/envelope");
const { VoiceSession } = require("./voice-session");

class SessionManager extends EventEmitter {
  constructor({ runtimeConfig = {}, createSession = null } = {}) {
    super();

    this.runtimeConfig = runtimeConfig || {};
    this.createSessionImpl = typeof createSession === "function" ? createSession : null;
    this.sessions = new Map();
    this.sessionChains = new Map();
    this.scope = "VOICE-CORE:MANAGER";
  }

  createOperationChain(sessionId) {
    if (!this.sessionChains.has(sessionId)) {
      this.sessionChains.set(sessionId, Promise.resolve());
    }
    return this.sessionChains.get(sessionId);
  }

  runSessionExclusive(sessionId, task) {
    const currentChain = this.createOperationChain(sessionId);
    const nextChain = currentChain.then(task, task);
    this.sessionChains.set(
      sessionId,
      nextChain.catch(() => {
        // Keep chain alive.
      })
    );
    return nextChain;
  }

  listSessionIds() {
    return [...this.sessions.keys()];
  }

  getSession(sessionId) {
    const normalized = String(sessionId || "").trim();
    if (!normalized) {
      return null;
    }
    return this.sessions.get(normalized) || null;
  }

  getSessionStatus(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }
    return session.getStatus();
  }

  createSession({ sessionId = "", transport, startEnvelope = null } = {}) {
    const normalizedSessionId = String(sessionId || createId("vs")).trim();
    if (!normalizedSessionId) {
      throw new Error("Session id is required.");
    }

    if (this.sessions.has(normalizedSessionId)) {
      const err = new Error(`Session already exists: ${normalizedSessionId}.`);
      err.code = "SESSION_EXISTS";
      throw err;
    }

    const session = this.createSessionImpl
      ? this.createSessionImpl({
          sessionId: normalizedSessionId,
          runtimeConfig: this.runtimeConfig,
          transport
        })
      : new VoiceSession({
          sessionId: normalizedSessionId,
          runtimeConfig: this.runtimeConfig,
          transport
        });

    if (!session || typeof session.start !== "function") {
      throw new Error("createSession() must return a VoiceSession-compatible instance.");
    }

    this.sessions.set(normalizedSessionId, session);
    this.createOperationChain(normalizedSessionId);

    session.on("stopped", () => {
      this.removeSession(normalizedSessionId);
    });

    this.emit("session.created", {
      session_id: normalizedSessionId,
      t_ms: Date.now()
    });

    log(this.scope, `session created: ${normalizedSessionId}`);

    const startTask = async () => {
      if (!startEnvelope) {
        return session.getStatus();
      }
      return session.start(startEnvelope);
    };

    return this.runSessionExclusive(normalizedSessionId, startTask);
  }

  removeSession(sessionId) {
    const normalized = String(sessionId || "").trim();
    if (!normalized) {
      return false;
    }

    const existed = this.sessions.delete(normalized);
    this.sessionChains.delete(normalized);

    if (existed) {
      this.emit("session.removed", {
        session_id: normalized,
        t_ms: Date.now()
      });
      log(this.scope, `session removed: ${normalized}`);
    }

    return existed;
  }

  async routeControl(sessionId, envelope) {
    const session = this.getSession(sessionId);
    if (!session) {
      const err = new Error(`Session not found: ${sessionId}`);
      err.code = "SESSION_NOT_FOUND";
      throw err;
    }

    return this.runSessionExclusive(session.sessionId, () => session.onControl(envelope));
  }

  async routeAudio(sessionId, frame) {
    const session = this.getSession(sessionId);
    if (!session) {
      const err = new Error(`Session not found: ${sessionId}`);
      err.code = "SESSION_NOT_FOUND";
      throw err;
    }

    return this.runSessionExclusive(session.sessionId, () => session.onAudio(frame));
  }

  async routeBinaryAudio(sessionId, binaryFrame) {
    const session = this.getSession(sessionId);
    if (!session) {
      const err = new Error(`Session not found: ${sessionId}`);
      err.code = "SESSION_NOT_FOUND";
      throw err;
    }

    if (typeof session.onBinaryAudio !== "function") {
      const err = new Error(`Session does not support binary audio: ${sessionId}`);
      err.code = "BINARY_AUDIO_UNSUPPORTED";
      throw err;
    }

    return this.runSessionExclusive(session.sessionId, () => session.onBinaryAudio(binaryFrame));
  }

  async stopSession(sessionId, { reason = "manager_stop" } = {}) {
    const session = this.getSession(sessionId);
    if (!session) {
      return {
        session_id: String(sessionId || "").trim() || undefined,
        status: "missing"
      };
    }

    return this.runSessionExclusive(session.sessionId, async () => {
      const status = await session.stop({ reason });
      this.removeSession(session.sessionId);
      return status;
    });
  }

  async shutdown({ reason = "manager_shutdown" } = {}) {
    const sessionIds = this.listSessionIds();
    for (const sessionId of sessionIds) {
      try {
        await this.stopSession(sessionId, { reason });
      } catch (err) {
        error(this.scope, `failed to stop session ${sessionId}: ${err?.message || err}`);
      }
    }

    this.sessions.clear();
    this.sessionChains.clear();

    warn(this.scope, `shutdown completed (${reason})`);
  }
}

module.exports = {
  SessionManager
};

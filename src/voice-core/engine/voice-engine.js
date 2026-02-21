const { SessionManager } = require("./session-manager");

class VoiceEngine {
  constructor({ runtimeConfig = {}, sessionManager = null } = {}) {
    this.runtimeConfig = runtimeConfig || {};
    this.sessionManager =
      sessionManager ||
      new SessionManager({
        runtimeConfig: this.runtimeConfig
      });

    this.initialized = false;
  }

  async init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
  }

  async createSession(transport, { sessionId = "", startEnvelope = null } = {}) {
    if (!this.initialized) {
      await this.init();
    }
    return this.sessionManager.createSession({
      sessionId,
      transport,
      startEnvelope
    });
  }

  getSession(sessionId) {
    return this.sessionManager.getSession(sessionId);
  }

  getSessionStatus(sessionId) {
    return this.sessionManager.getSessionStatus(sessionId);
  }

  async routeControl(sessionId, envelope) {
    return this.sessionManager.routeControl(sessionId, envelope);
  }

  async routeAudio(sessionId, frame) {
    return this.sessionManager.routeAudio(sessionId, frame);
  }

  async routeBinaryAudio(sessionId, binaryFrame) {
    return this.sessionManager.routeBinaryAudio(sessionId, binaryFrame);
  }

  async stopSession(sessionId, reason = "engine_stop") {
    return this.sessionManager.stopSession(sessionId, {
      reason
    });
  }

  async shutdown(reason = "engine_shutdown") {
    await this.sessionManager.shutdown({ reason });
    this.initialized = false;
  }
}

module.exports = {
  VoiceEngine
};

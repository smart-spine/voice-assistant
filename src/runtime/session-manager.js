const { BotSession } = require("./bot-session");

class BotSessionManager {
  constructor({ config }) {
    this.config = config;
    this.activeSession = null;
    this.operationChain = Promise.resolve();
  }

  runExclusive(task) {
    const next = this.operationChain.then(task, task);
    this.operationChain = next.catch(() => {});
    return next;
  }

  async stopActiveSession({ reason }) {
    if (!this.activeSession || !this.isSessionActive()) {
      this.activeSession = null;
      return {
        sessionId: null,
        status: "idle"
      };
    }

    const status = await this.activeSession.stop({ reason });
    this.activeSession = null;
    return {
      ...status,
      status: "stopped"
    };
  }

  async startSession({ meetUrl, forceRestart = false, projectContext = "" } = {}) {
    return this.runExclusive(async () => {
      if (this.activeSession && this.isSessionActive()) {
        if (!forceRestart) {
          const err = new Error("A session is already running.");
          err.code = "SESSION_ALREADY_RUNNING";
          throw err;
        }
        await this.stopActiveSession({ reason: "force restart" });
      }

      const session = new BotSession({ config: this.config });
      this.activeSession = session;
      await session.start({ meetUrl, projectContext });
      return session.getStatus();
    });
  }

  async stopSession({ reason = "api stop request" } = {}) {
    return this.runExclusive(() => this.stopActiveSession({ reason }));
  }

  getStatus() {
    if (!this.activeSession) {
      return {
        sessionId: null,
        status: "idle"
      };
    }
    return this.activeSession.getStatus();
  }

  isSessionActive() {
    if (!this.activeSession) {
      return false;
    }
    const state = this.activeSession.getStatus().status;
    return state === "starting" || state === "running" || state === "stopping";
  }
}

module.exports = {
  BotSessionManager
};

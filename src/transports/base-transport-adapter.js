class BaseTransportAdapter {
  constructor({ browser, config } = {}) {
    this.browser = browser;
    this.config = config;
  }

  async start() {
    throw new Error("start() is not implemented for this transport adapter.");
  }

  async stop() {
    throw new Error("stop() is not implemented for this transport adapter.");
  }

  async reopenBridge() {
    throw new Error("reopenBridge() is not implemented for this transport adapter.");
  }

  async stopSpeaking() {
    throw new Error("stopSpeaking() is not implemented for this transport adapter.");
  }

  async setTtsDucking() {
    return false;
  }

  async startCoreWs() {
    throw new Error("startCoreWs() is not implemented for this transport adapter.");
  }

  async stopCoreWs() {
    return false;
  }

  async coreInterrupt() {
    return false;
  }

  async coreCreateTextTurn() {
    return false;
  }

  async coreAppendSystemContext() {
    return false;
  }

  getBridgePage() {
    return null;
  }

  getMeetPage() {
    return null;
  }

  getJoinState() {
    return null;
  }

  async refreshJoinState() {
    return this.getJoinState();
  }
}

module.exports = {
  BaseTransportAdapter
};

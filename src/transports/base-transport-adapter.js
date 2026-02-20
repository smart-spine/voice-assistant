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

  async startStt() {
    throw new Error("startStt() is not implemented for this transport adapter.");
  }

  async stopStt() {
    throw new Error("stopStt() is not implemented for this transport adapter.");
  }

  async playAudio() {
    throw new Error("playAudio() is not implemented for this transport adapter.");
  }

  async stopSpeaking() {
    throw new Error("stopSpeaking() is not implemented for this transport adapter.");
  }

  async setTtsDucking() {
    return false;
  }

  async startRealtime() {
    throw new Error("startRealtime() is not implemented for this transport adapter.");
  }

  async stopRealtime() {
    return false;
  }

  async realtimeCreateTextTurn() {
    throw new Error(
      "realtimeCreateTextTurn() is not implemented for this transport adapter."
    );
  }

  async realtimeAppendSystemContext() {
    return false;
  }

  async realtimeInterrupt() {
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

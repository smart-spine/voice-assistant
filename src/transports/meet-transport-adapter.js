const {
  setupBridgePage,
  bridgeStopSpeaking,
  bridgeSetTtsDucking,
  bridgeStartCoreWs,
  bridgeStopCoreWs,
  bridgeCoreInterrupt,
  bridgeCoreCreateTextTurn,
  bridgeCoreAppendSystemContext,
  openMeetPage,
  detectMeetJoinState,
  leaveMeetPage
} = require("../meet-controller");
const { BaseTransportAdapter } = require("./base-transport-adapter");

class MeetTransportAdapter extends BaseTransportAdapter {
  constructor({ browser, config, bridgeBindings } = {}) {
    super({ browser, config });
    this.bridgeBindings = bridgeBindings || {};
    this.bridgePage = null;
    this.meetPage = null;
    this.joinState = null;
  }

  async start() {
    this.bridgePage = await setupBridgePage({
      browser: this.browser,
      config: this.config,
      ...this.bridgeBindings
    });

    const meetResult = await openMeetPage({
      browser: this.browser,
      config: this.config
    });
    this.meetPage = meetResult?.page || meetResult;
    this.joinState =
      meetResult && typeof meetResult === "object" ? meetResult.joinState : null;

    return {
      bridgePage: this.bridgePage,
      meetPage: this.meetPage,
      joinState: this.joinState
    };
  }

  async reopenBridge() {
    await this.closeBridgePage();
    this.bridgePage = await setupBridgePage({
      browser: this.browser,
      config: this.config,
      ...this.bridgeBindings
    });
    return this.bridgePage;
  }

  async stopSpeaking(options = {}) {
    if (!this.bridgePage || this.bridgePage.isClosed()) {
      return false;
    }
    return bridgeStopSpeaking(this.bridgePage, options);
  }

  async setTtsDucking(options = {}) {
    if (!this.bridgePage || this.bridgePage.isClosed()) {
      return false;
    }
    return bridgeSetTtsDucking(this.bridgePage, options);
  }

  async startCoreWs(options = {}) {
    if (!this.bridgePage || this.bridgePage.isClosed()) {
      throw new Error("Bridge page is unavailable.");
    }
    return bridgeStartCoreWs(this.bridgePage, options);
  }

  async stopCoreWs(options = {}) {
    if (!this.bridgePage || this.bridgePage.isClosed()) {
      return false;
    }
    return bridgeStopCoreWs(this.bridgePage, options);
  }

  async coreInterrupt(options = {}) {
    if (!this.bridgePage || this.bridgePage.isClosed()) {
      return false;
    }
    return bridgeCoreInterrupt(this.bridgePage, options);
  }

  async coreCreateTextTurn(payload = {}) {
    if (!this.bridgePage || this.bridgePage.isClosed()) {
      return false;
    }
    return bridgeCoreCreateTextTurn(this.bridgePage, payload);
  }

  async coreAppendSystemContext(note = "") {
    if (!this.bridgePage || this.bridgePage.isClosed()) {
      return false;
    }
    return bridgeCoreAppendSystemContext(this.bridgePage, note);
  }

  async stop({ leaveMeet = true } = {}) {
    let hasLeftCall = false;

    try {
      await this.stopCoreWs({ reason: "adapter-stop" });
    } catch (_) {
      // Ignore core ws stop failures during shutdown.
    }

    if (leaveMeet && this.meetPage && !this.meetPage.isClosed()) {
      try {
        hasLeftCall = Boolean(await leaveMeetPage(this.meetPage));
      } catch (_) {
        hasLeftCall = false;
      }
    }

    await this.closeBridgePage();
    await this.closeMeetPage();

    return {
      hasLeftCall
    };
  }

  async closeBridgePage() {
    if (!this.bridgePage || this.bridgePage.isClosed()) {
      this.bridgePage = null;
      return;
    }
    try {
      await bridgeStopCoreWs(this.bridgePage, { reason: "close-bridge-page" });
    } catch (_) {
      // Ignore bridge core stop errors.
    }
    try {
      await this.bridgePage.close({ runBeforeUnload: true });
    } catch (_) {
      // Ignore close errors.
    }
    this.bridgePage = null;
  }

  async closeMeetPage() {
    if (!this.meetPage || this.meetPage.isClosed()) {
      this.meetPage = null;
      return;
    }
    try {
      await this.meetPage.close({ runBeforeUnload: true });
    } catch (_) {
      // Ignore close errors.
    }
    this.meetPage = null;
  }

  getBridgePage() {
    return this.bridgePage;
  }

  getMeetPage() {
    return this.meetPage;
  }

  getJoinState() {
    return this.joinState;
  }

  async refreshJoinState() {
    if (!this.meetPage || this.meetPage.isClosed()) {
      return this.joinState;
    }

    try {
      this.joinState = await detectMeetJoinState(this.meetPage);
    } catch (_) {
      // Ignore transient detection errors and keep last known state.
    }
    return this.joinState;
  }
}

module.exports = {
  MeetTransportAdapter
};

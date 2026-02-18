const {
  setupBridgePage,
  bridgeStartOpenAiStt,
  bridgeStopOpenAiStt,
  bridgeSpeakAudio,
  bridgeStopSpeaking,
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

  async startStt(options = {}) {
    if (!this.bridgePage || this.bridgePage.isClosed()) {
      throw new Error("Bridge page is unavailable.");
    }
    return bridgeStartOpenAiStt(this.bridgePage, options);
  }

  async stopStt() {
    if (!this.bridgePage || this.bridgePage.isClosed()) {
      return false;
    }
    return bridgeStopOpenAiStt(this.bridgePage);
  }

  async playAudio(payload = {}) {
    if (!this.bridgePage || this.bridgePage.isClosed()) {
      throw new Error("Bridge page is unavailable.");
    }
    return bridgeSpeakAudio(this.bridgePage, payload);
  }

  async stopSpeaking() {
    if (!this.bridgePage || this.bridgePage.isClosed()) {
      return false;
    }
    return bridgeStopSpeaking(this.bridgePage);
  }

  async stop({ leaveMeet = true } = {}) {
    let hasLeftCall = false;

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
      await bridgeStopOpenAiStt(this.bridgePage);
    } catch (_) {
      // Ignore bridge stop errors.
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

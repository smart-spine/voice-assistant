const path = require("path");
const puppeteer = require("puppeteer");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchBrowser(config) {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--use-fake-ui-for-media-stream",
    "--window-size=1400,900"
  ];

  if (config.chromeUserDataDir) {
    const userDataDir = path.resolve(process.cwd(), config.chromeUserDataDir);
    args.push(`--user-data-dir=${userDataDir}`);
  }

  const launchOptions = {
    headless: config.headless ? "new" : false,
    args,
    defaultViewport: {
      width: 1400,
      height: 900
    }
  };

  if (config.chromePath) {
    launchOptions.executablePath = config.chromePath;
  }

  return puppeteer.launch(launchOptions);
}

async function setupBridgePage({
  browser,
  config,
  onAudioChunk = () => {},
  onBridgeLog = () => {},
  onBridgeEvent = () => {}
}) {
  const page = await browser.newPage();

  await page.exposeFunction("notifyBridgeEvent", async (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const event = {
      type: typeof payload.type === "string" ? payload.type : "unknown",
      source:
        typeof payload.source === "string" && payload.source
          ? payload.source
          : "openai-stt",
      text: typeof payload.text === "string" ? payload.text : "",
      ts: Number.isFinite(Number(payload.ts))
        ? Number(payload.ts)
        : Date.now(),
      isFinal: Boolean(payload.isFinal),
      reason:
        typeof payload.reason === "string" && payload.reason
          ? payload.reason
          : undefined,
      peak: Number.isFinite(Number(payload.peak))
        ? Number(payload.peak)
        : undefined,
      speechMs: Number.isFinite(Number(payload.speechMs))
        ? Number(payload.speechMs)
        : undefined,
      turnId:
        typeof payload.turnId === "string" && payload.turnId
          ? payload.turnId
          : undefined
    };

    await onBridgeEvent(event);
  });

  await page.exposeFunction("notifyBridgeAudioChunk", async (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const audioBase64 =
      typeof payload.audioBase64 === "string" ? payload.audioBase64.trim() : "";
    if (!audioBase64) {
      return;
    }

    await onAudioChunk({
      audioBase64,
      mimeType:
        typeof payload.mimeType === "string" && payload.mimeType
          ? payload.mimeType
          : "audio/webm;codecs=opus",
      ts: Number.isFinite(Number(payload.ts))
        ? Number(payload.ts)
        : Date.now(),
      durationMs: Number.isFinite(Number(payload.durationMs))
        ? Number(payload.durationMs)
        : undefined,
      isSegmentFinal: Boolean(payload.isSegmentFinal)
    });
  });

  await page.exposeFunction("notifyBridgeLog", (line) => {
    onBridgeLog(String(line || ""));
  });

  const bridgeHost = config.bridgeHost || "127.0.0.1";
  const localhostOrigin = `http://${bridgeHost}:${config.bridgePort}`;
  try {
    await browser.defaultBrowserContext().overridePermissions(localhostOrigin, [
      "microphone",
      "speaker-selection"
    ]);
  } catch (error) {
    const message = String(error?.message || "");
    if (!message.toLowerCase().includes("unknown permission")) {
      throw error;
    }
    await browser.defaultBrowserContext().overridePermissions(localhostOrigin, [
      "microphone"
    ]);
  }

  const bridgeUrlObject = new URL("/bridge.html", localhostOrigin);
  bridgeUrlObject.searchParams.set("lang", config.language);
  bridgeUrlObject.searchParams.set(
    "silenceMs",
    String(config.silenceAfterSpeakMs)
  );
  bridgeUrlObject.searchParams.set(
    "turnSilenceMs",
    String(config.turnSilenceMs)
  );
  if (config.bridgeTtsOutputDeviceId) {
    bridgeUrlObject.searchParams.set(
      "ttsOutputDeviceId",
      config.bridgeTtsOutputDeviceId
    );
  }
  if (config.bridgeTtsOutputDeviceLabel) {
    bridgeUrlObject.searchParams.set(
      "ttsOutputDeviceLabel",
      config.bridgeTtsOutputDeviceLabel
    );
  }
  const bridgeUrl = bridgeUrlObject.toString();

  await page.goto(bridgeUrl, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => typeof window.botBridge !== "undefined");
  await warmUpBridgePage(page);
  await bridgePrepareTtsOutput(page);

  return page;
}

async function warmUpBridgePage(page) {
  await page.bringToFront();

  const viewport = page.viewport() || { width: 1200, height: 800 };
  const clickX = Math.max(10, Math.floor(viewport.width / 2));
  const clickY = Math.max(10, Math.floor(viewport.height / 2));

  try {
    await page.mouse.click(clickX, clickY);
  } catch (_) {
    // Ignore click failures; unlock attempt may still succeed.
  }

  try {
    await page.evaluate(async () => {
      if (window.botBridge?.unlockAudio) {
        await window.botBridge.unlockAudio();
      }
    });
  } catch (_) {
    // Ignore warm-up failures; runtime will retry audio unlock on demand.
  }
}

async function bridgeStartOpenAiStt(page, options = {}) {
  return page.evaluate((opts) => {
    if (!window.botBridge?.startOpenAiStt) {
      return false;
    }
    return window.botBridge.startOpenAiStt(opts);
  }, options);
}

async function bridgeStopOpenAiStt(page) {
  return page.evaluate(() => {
    if (!window.botBridge?.stopOpenAiStt) {
      return false;
    }
    return window.botBridge.stopOpenAiStt();
  });
}

async function bridgeSpeakAudio(page, payload) {
  return page.evaluate((audioPayload) => {
    return window.botBridge.playAudio(audioPayload);
  }, payload);
}

async function bridgePrepareTtsOutput(page) {
  return page.evaluate(async () => {
    if (!window.botBridge?.prepareTtsOutput) {
      return false;
    }
    try {
      return await window.botBridge.prepareTtsOutput();
    } catch (_) {
      return false;
    }
  });
}

async function bridgeStopSpeaking(page, options = {}) {
  return page.evaluate((stopOptions) => {
    if (!window.botBridge?.stopSpeaking) {
      return false;
    }
    return window.botBridge.stopSpeaking(stopOptions || {});
  }, options);
}

async function bridgeSetTtsDucking(page, options = {}) {
  return page.evaluate((duckOptions) => {
    if (!window.botBridge?.setTtsDucking) {
      return false;
    }
    return window.botBridge.setTtsDucking(duckOptions || {});
  }, options);
}

async function openMeetPage({ browser, config }) {
  const page = await browser.newPage();
  let meetOrigin;
  try {
    meetOrigin = new URL(config.meetUrl).origin;
  } catch (_) {
    throw new Error(`Invalid meet URL: ${config.meetUrl}`);
  }

  await browser.defaultBrowserContext().overridePermissions(meetOrigin, [
    "microphone",
    "camera",
    "notifications"
  ]);

  await page.goto(config.meetUrl, { waitUntil: "domcontentloaded" });
  await sleep(2500);

  await tryTypeBotName(page, config.botName);
  await ensureCameraOff(page);
  await ensureMicOn(page);
  await clickJoinButton(page, {
    attempts: Number(config?.meetJoinClickAttempts || 8),
    retryMs: Number(config?.meetJoinClickRetryMs || 700)
  });
  void keepMicUnmuted(page, 120000);

  const joinState = await waitForMeetJoinState(page, {
    timeoutMs: Number(config?.meetJoinStateTimeoutMs || 6000),
    pollMs: Number(config?.meetJoinPollMs || 900),
    stopOnAuthRequired: !config?.meetAssumeLoggedIn
  });
  return { page, joinState };
}

async function waitForMeetJoinState(
  page,
  { timeoutMs = 18000, pollMs = 900, stopOnAuthRequired = true } = {}
) {
  const startedAt = Date.now();
  let lastState = {
    status: "unknown",
    url: "",
    matched: []
  };

  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastState = await detectMeetJoinState(page);
    } catch (_) {
      // Ignore transient navigation/evaluation failures.
    }

    if (lastState.status === "joined") {
      return lastState;
    }
    if (stopOnAuthRequired && lastState.status === "auth_required") {
      return lastState;
    }

    await sleep(pollMs);
  }

  return lastState;
}

async function detectMeetJoinState(page) {
  return page.evaluate(() => {
    const url = String(window.location.href || "");
    const normalizedUrl = url.toLowerCase();

    const authRequiredByUrl =
      normalizedUrl.includes("accounts.google.com") ||
      normalizedUrl.includes("/signin") ||
      normalizedUrl.includes("servicelogin");

    const controls = Array.from(document.querySelectorAll('button, [role="button"]'));
    const toLabel = (el) =>
      `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) {
        return false;
      }
      if (
        el.closest("[hidden], [aria-hidden='true'], [inert], [style*='display: none']")
      ) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (!style || style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };
    const visibleLabels = controls
      .filter((el) => isVisible(el))
      .map((el) => toLabel(el))
      .filter(Boolean);
    const labels = visibleLabels.length > 0 ? visibleLabels : controls.map((el) => toLabel(el)).filter(Boolean);

    const hasAny = (phrases) =>
      phrases.some((phrase) => labels.some((label) => label.includes(phrase)));

    const hasLeaveControl = hasAny([
      "leave call",
      "hang up",
      "end call",
      "leave",
      "exit call",
      "disconnect",
      "покинуть звонок",
      "покинуть встречу",
      "завершить звонок",
      "отключиться",
      "выйти"
    ]);

    const hasJoinControl = hasAny([
      "join now",
      "ask to join",
      "join",
      "rejoin",
      "присоединиться",
      "попросить присоединиться",
      "повторно присоединиться"
    ]);

    const hasInCallUiControl = hasAny([
      "chat with everyone",
      "people",
      "activities",
      "raise hand",
      "present now",
      "turn on captions",
      "captions",
      "чат со всеми",
      "люди",
      "действия",
      "поднять руку",
      "показать",
      "субтитры"
    ]);

    const bodyText = String(document.body?.innerText || "")
      .toLowerCase()
      .replace(/\s+/g, " ");
    const authRequiredByText =
      bodyText.includes("sign in") ||
      bodyText.includes("войдите") ||
      bodyText.includes("войти");

    let status = "unknown";
    if (hasLeaveControl || hasInCallUiControl) {
      status = "joined";
    } else if (authRequiredByUrl || authRequiredByText) {
      status = "auth_required";
    } else if (hasJoinControl) {
      status = "prejoin";
    }

    return {
      status,
      url,
      matched: labels.slice(0, 30)
    };
  });
}

async function tryTypeBotName(page, botName) {
  const inputSelectors = [
    'input[aria-label*="name" i]',
    'input[placeholder*="name" i]',
    "input[type='text']"
  ];

  for (const selector of inputSelectors) {
    const input = await page.$(selector);
    if (!input) {
      continue;
    }

    try {
      await input.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
      await input.type(botName, { delay: 25 });
      return true;
    } catch (_) {
      // Ignore and continue to next selector.
    }
  }

  return false;
}

async function ensureMicOn(page) {
  return page.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll('button, [role="button"]')
    );

    const toText = (el) =>
      `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    for (const control of controls) {
      const text = toText(control);
      if (!text) {
        continue;
      }

      if (
        text.includes("turn on microphone") ||
        text.includes("включить микрофон") ||
        text.includes("unmute microphone")
      ) {
        control.click();
        return "clicked-on";
      }

      if (
        text.includes("turn off microphone") ||
        text.includes("выключить микрофон") ||
        text.includes("mute microphone")
      ) {
        return "already-on";
      }
    }

    return "unknown";
  });
}

async function ensureCameraOff(page) {
  await clickByLabel(page, [
    "turn off camera",
    "выключить камеру",
    "disable camera"
  ]);
}

async function clickJoinButton(page, { attempts = 8, retryMs = 700 } = {}) {
  const labels = [
    "join now",
    "ask to join",
    "присоединиться",
    "попросить присоединиться"
  ];

  const maxAttempts = Math.max(1, Math.min(30, Math.trunc(Number(attempts) || 8)));
  const retryDelayMs = Math.max(120, Math.min(5000, Number(retryMs) || 700));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const clicked = await clickByLabel(page, labels);
    if (clicked) {
      return true;
    }
    await sleep(retryDelayMs);
  }

  return false;
}

async function leaveMeetPage(page, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 7000;
  const retryMs = Number.isFinite(options.retryMs) ? options.retryMs : 600;
  const labels = [
    "leave call",
    "hang up",
    "end call",
    "покинуть звонок",
    "покинуть встречу",
    "завершить звонок",
    "отключиться"
  ];
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const clicked = await clickByLabel(page, labels);
      if (clicked) {
        await sleep(500);
        return true;
      }
    } catch (_) {
      // Ignore transient DOM and navigation errors.
    }

    await sleep(retryMs);
  }

  return false;
}

async function clickByLabel(page, labels) {
  return page.evaluate((phrases) => {
    const normalizedPhrases = phrases.map((value) => value.toLowerCase());
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) {
        return false;
      }
      if (
        el.closest("[hidden], [aria-hidden='true'], [inert], [style*='display: none']")
      ) {
        return false;
      }
      if (
        el.hasAttribute("disabled") ||
        el.getAttribute("aria-disabled") === "true"
      ) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (!style || style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };
    const controls = Array.from(
      document.querySelectorAll('button, [role="button"]')
    );

    for (const control of controls) {
      if (!isVisible(control)) {
        continue;
      }
      const ariaLabel = (control.getAttribute("aria-label") || "").toLowerCase();
      const text = (control.textContent || "").toLowerCase();
      const target = `${ariaLabel} ${text}`.trim();
      if (!target) {
        continue;
      }

      const matched = normalizedPhrases.some((phrase) =>
        target.includes(phrase)
      );
      if (matched) {
        control.click();
        return true;
      }
    }

    return false;
  }, labels);
}

async function keepMicUnmuted(page, durationMs = 120000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < durationMs) {
    try {
      await ensureMicOn(page);
    } catch (_) {
      // Ignore transient DOM and navigation errors.
    }
    await sleep(1200);
  }
}

module.exports = {
  launchBrowser,
  setupBridgePage,
  bridgeStartOpenAiStt,
  bridgeStopOpenAiStt,
  bridgeSpeakAudio,
  bridgePrepareTtsOutput,
  bridgeStopSpeaking,
  bridgeSetTtsDucking,
  openMeetPage,
  detectMeetJoinState,
  leaveMeetPage
};

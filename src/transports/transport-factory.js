const { MeetTransportAdapter } = require("./meet-transport-adapter");

function createTransportAdapter({
  type = "meet",
  browser,
  config,
  bridgeBindings
} = {}) {
  const normalized = String(type || "meet")
    .trim()
    .toLowerCase();

  if (normalized === "meet") {
    return new MeetTransportAdapter({
      browser,
      config,
      bridgeBindings
    });
  }

  throw new Error(`Unsupported transport adapter type: ${normalized}`);
}

module.exports = {
  createTransportAdapter
};

const express = require("express");
const path = require("path");

async function startBridgeServer(port, host = "127.0.0.1") {
  const app = express();
  app.disable("x-powered-by");

  const staticDir = path.resolve(__dirname, "..", "public");
  app.use(express.static(staticDir));

  app.get("/health", (_, res) => {
    res.json({ ok: true });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      resolve({ app, server });
    });
    server.on("error", reject);
  });
}

module.exports = {
  startBridgeServer
};

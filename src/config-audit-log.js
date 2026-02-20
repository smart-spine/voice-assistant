const fs = require("fs");
const path = require("path");
const { resolvePathFromCwd } = require("./config-overrides-store");

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function ensureMode600(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_) {
    // Ignore permission hardening failure.
  }
}

function appendAuditEntry({
  auditFile,
  entry,
  fallbackFile = ".config/config.audit.log"
} = {}) {
  const filePath = resolvePathFromCwd(auditFile, fallbackFile);
  if (!filePath) {
    throw new Error("Unable to resolve audit file path.");
  }

  ensureDir(filePath);
  const normalized = {
    ts: new Date().toISOString(),
    ...entry
  };
  fs.appendFileSync(filePath, `${JSON.stringify(normalized)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  ensureMode600(filePath);
  return filePath;
}

function readAuditEntries({
  auditFile,
  limit = 200,
  fallbackFile = ".config/config.audit.log"
} = {}) {
  const filePath = resolvePathFromCwd(auditFile, fallbackFile);
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return [];
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const sliced = lines.slice(Math.max(0, lines.length - safeLimit));
  const entries = [];
  for (const line of sliced) {
    try {
      entries.push(JSON.parse(line));
    } catch (_) {
      // Skip malformed lines.
    }
  }
  return entries;
}

module.exports = {
  appendAuditEntry,
  readAuditEntries
};

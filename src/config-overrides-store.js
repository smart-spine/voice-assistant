const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function cleanString(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function resolvePathFromCwd(inputPath, fallbackRelativePath = "") {
  const rawValue = cleanString(inputPath, fallbackRelativePath);
  if (!rawValue) {
    return "";
  }
  return path.resolve(process.cwd(), rawValue);
}

function parseEncryptionKey(rawValue) {
  const value = cleanString(rawValue);
  if (!value) {
    return null;
  }

  if (/^[a-f0-9]{64}$/i.test(value)) {
    return Buffer.from(value, "hex");
  }

  try {
    const b64 = Buffer.from(value, "base64");
    if (b64.length === 32) {
      return b64;
    }
  } catch (_) {
    // Continue.
  }

  const utf8 = Buffer.from(value, "utf8");
  if (utf8.length === 32) {
    return utf8;
  }

  throw new Error(
    "CONFIG_ENCRYPTION_KEY must be 32 bytes (hex/base64/raw UTF-8)."
  );
}

function defaultStorePayload() {
  return {
    version: 1,
    updatedAt: null,
    overrides: {},
    keyUpdatedAt: {}
  };
}

function normalizeStorePayload(input = {}) {
  const overrides = {};
  const rawOverrides = input?.overrides && typeof input.overrides === "object"
    ? input.overrides
    : {};
  for (const [key, value] of Object.entries(rawOverrides)) {
    const normalizedKey = String(key || "").trim().toUpperCase();
    if (!normalizedKey) {
      continue;
    }
    overrides[normalizedKey] = String(value ?? "");
  }

  const keyUpdatedAt = {};
  const rawUpdatedAt = input?.keyUpdatedAt && typeof input.keyUpdatedAt === "object"
    ? input.keyUpdatedAt
    : {};
  for (const [key, value] of Object.entries(rawUpdatedAt)) {
    const normalizedKey = String(key || "").trim().toUpperCase();
    const normalizedTs = cleanString(value);
    if (!normalizedKey || !normalizedTs) {
      continue;
    }
    keyUpdatedAt[normalizedKey] = normalizedTs;
  }

  return {
    version: 1,
    updatedAt: cleanString(input?.updatedAt) || null,
    overrides,
    keyUpdatedAt
  };
}

function encryptPayload(payload, encryptionKey) {
  const key = parseEncryptionKey(encryptionKey);
  if (!key) {
    throw new Error("Missing CONFIG_ENCRYPTION_KEY.");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decryptEnvelope(envelope, encryptionKey) {
  const key = parseEncryptionKey(encryptionKey);
  if (!key) {
    throw new Error("Missing CONFIG_ENCRYPTION_KEY.");
  }

  const iv = Buffer.from(String(envelope?.iv || ""), "base64");
  const tag = Buffer.from(String(envelope?.tag || ""), "base64");
  const ciphertext = Buffer.from(String(envelope?.ciphertext || ""), "base64");

  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Encrypted overrides file is malformed.");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed = JSON.parse(plaintext.toString("utf8"));
  return normalizeStorePayload(parsed);
}

function ensureParentDir(filePath) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return parent;
}

function ensureFileMode600(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_) {
    // Ignore permission hardening failures on unsupported filesystems.
  }
}

function backupExistingFileIfPresent(filePath, backupsDir) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const backupsPath = resolvePathFromCwd(backupsDir, ".config/config-backups");
  fs.mkdirSync(backupsPath, { recursive: true, mode: 0o700 });

  const fileName = `${path.basename(filePath)}.${Date.now()}.bak`;
  const destination = path.join(backupsPath, fileName);
  fs.copyFileSync(filePath, destination);
  ensureFileMode600(destination);
  return destination;
}

function atomicWriteTextFile(filePath, text) {
  ensureParentDir(filePath);

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, text, { encoding: "utf8", mode: 0o600 });

  const handle = fs.openSync(tempPath, "r");
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  fs.renameSync(tempPath, filePath);
  ensureFileMode600(filePath);
}

function loadEncryptedOverrides({
  overridesFile,
  encryptionKey,
  fallbackFile = ".config/config.overrides.enc"
} = {}) {
  const filePath = resolvePathFromCwd(overridesFile, fallbackFile);
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      filePath,
      payload: defaultStorePayload()
    };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return {
      filePath,
      payload: defaultStorePayload()
    };
  }

  const envelope = JSON.parse(raw);
  const payload = decryptEnvelope(envelope, encryptionKey);
  return {
    filePath,
    payload
  };
}

function saveEncryptedOverrides({
  overridesFile,
  backupsDir,
  encryptionKey,
  payload,
  fallbackFile = ".config/config.overrides.enc"
} = {}) {
  const filePath = resolvePathFromCwd(overridesFile, fallbackFile);
  if (!filePath) {
    throw new Error("Unable to resolve overrides file path.");
  }

  backupExistingFileIfPresent(filePath, backupsDir);
  const normalizedPayload = normalizeStorePayload(payload);
  const envelope = encryptPayload(normalizedPayload, encryptionKey);
  atomicWriteTextFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`);

  return {
    filePath,
    payload: normalizedPayload
  };
}

function loadDotEnvFile(dotEnvPath = ".env") {
  const resolvedPath = resolvePathFromCwd(dotEnvPath, ".env");
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return {};
  }

  const content = fs.readFileSync(resolvedPath, "utf8");
  const result = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Z0-9_]{2,64})\s*=\s*(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2] || "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

function applyOverridesToProcessEnv({
  overrides = {},
  previousOverrides = {},
  baseDotEnv = {},
  env = process.env
} = {}) {
  const previousKeys = Object.keys(previousOverrides || {});
  for (const key of previousKeys) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(baseDotEnv, key)) {
      env[key] = String(baseDotEnv[key]);
    } else {
      delete env[key];
    }
  }

  for (const [key, value] of Object.entries(overrides || {})) {
    env[key] = String(value ?? "");
  }
}

module.exports = {
  parseEncryptionKey,
  defaultStorePayload,
  normalizeStorePayload,
  loadEncryptedOverrides,
  saveEncryptedOverrides,
  loadDotEnvFile,
  applyOverridesToProcessEnv,
  resolvePathFromCwd
};

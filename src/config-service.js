const crypto = require("crypto");
const {
  SCHEMA,
  listSchemaForClient,
  validateKeyNameOrThrow,
  validateKeyValueOrThrow,
  isSensitiveKey,
  maskSensitiveValue
} = require("./config-schema");
const {
  loadEncryptedOverrides,
  saveEncryptedOverrides,
  loadDotEnvFile,
  applyOverridesToProcessEnv
} = require("./config-overrides-store");
const { appendAuditEntry, readAuditEntries } = require("./config-audit-log");

function safeNowIso() {
  return new Date().toISOString();
}

function truncateValue(value, max = 300) {
  const text = String(value ?? "");
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...`;
}

function sanitizeAuditValue(key, value) {
  if (isSensitiveKey(key)) {
    return maskSensitiveValue(value);
  }
  return truncateValue(value, 500);
}

function sortedUnique(values = []) {
  return [...new Set(values)].sort();
}

class ConfigService {
  constructor({
    encryptionKey,
    overridesFile,
    auditFile,
    backupsDir,
    onReload = async () => null
  } = {}) {
    this.encryptionKey = String(encryptionKey || "").trim();
    this.overridesFile = overridesFile;
    this.auditFile = auditFile;
    this.backupsDir = backupsDir;
    this.onReload = typeof onReload === "function" ? onReload : async () => null;

    this.baseDotEnv = loadDotEnvFile(".env");

    const loaded = loadEncryptedOverrides({
      overridesFile: this.overridesFile,
      encryptionKey: this.encryptionKey
    });
    this.store = loaded.payload;
    this.previousOverridesSnapshot = { ...this.store.overrides };

    applyOverridesToProcessEnv({
      overrides: this.store.overrides,
      previousOverrides: {},
      baseDotEnv: this.baseDotEnv,
      env: process.env
    });

    this.previewCache = new Map();
  }

  cleanupPreviewCache() {
    const now = Date.now();
    for (const [previewId, item] of this.previewCache.entries()) {
      if (!item || Number(item.expiresAtMs || 0) <= now) {
        this.previewCache.delete(previewId);
      }
    }
  }

  requireEncryptionKey() {
    if (!this.encryptionKey) {
      throw new Error(
        "CONFIG_ENCRYPTION_KEY is required for UI-managed config changes."
      );
    }
  }

  getCurrentOverrides() {
    return { ...this.store.overrides };
  }

  getKnownConfigKeys() {
    const schemaKeys = Object.keys(SCHEMA);
    const overrideKeys = Object.keys(this.store.overrides || {});
    const customKeys = Object.keys(this.store.overrides || {}).filter((key) =>
      key.startsWith("CUSTOM_")
    );
    return sortedUnique([...schemaKeys, ...overrideKeys, ...customKeys]);
  }

  getEffectiveValue(key) {
    const normalizedKey = String(key || "").trim().toUpperCase();
    if (!normalizedKey) {
      return "";
    }
    if (Object.prototype.hasOwnProperty.call(this.store.overrides, normalizedKey)) {
      return String(this.store.overrides[normalizedKey] ?? "");
    }
    if (Object.prototype.hasOwnProperty.call(this.baseDotEnv, normalizedKey)) {
      return String(this.baseDotEnv[normalizedKey] ?? "");
    }
    return String(process.env[normalizedKey] || "");
  }

  getConfigEntries({ search = "" } = {}) {
    const needle = String(search || "").trim().toUpperCase();
    const keys = this.getKnownConfigKeys();

    const entries = [];
    for (const key of keys) {
      if (needle && !key.includes(needle)) {
        continue;
      }

      const meta = SCHEMA[key] || {
        type: "string",
        sensitive: isSensitiveKey(key),
        restartRequired: false,
        description: "Custom environment variable"
      };

      const effectiveValue = this.getEffectiveValue(key);
      const isOverride = Object.prototype.hasOwnProperty.call(
        this.store.overrides,
        key
      );
      const sensitive = Boolean(meta.sensitive || isSensitiveKey(key));

      entries.push({
        key,
        value: sensitive ? maskSensitiveValue(effectiveValue) : effectiveValue,
        hasValue: Boolean(effectiveValue),
        source: isOverride ? "override" : "base",
        sensitive,
        restartRequired: meta.restartRequired !== false,
        type: meta.type || "string",
        description: meta.description || "",
        allowedValues: Array.isArray(meta.allowedValues)
          ? [...meta.allowedValues]
          : undefined,
        updatedAt: this.store.keyUpdatedAt?.[key] || null
      });
    }

    return entries.sort((a, b) => a.key.localeCompare(b.key));
  }

  normalizeChangeSet(changeSet = {}) {
    const set =
      changeSet && typeof changeSet.set === "object" && changeSet.set
        ? changeSet.set
        : {};
    const unset = Array.isArray(changeSet?.unset) ? changeSet.unset : [];

    const normalizedSet = {};
    const normalizedUnset = [];
    const errors = [];

    const setKeys = Object.keys(set);
    if (setKeys.length > 200) {
      errors.push("Too many keys in `set` (max 200).");
    }
    if (unset.length > 200) {
      errors.push("Too many keys in `unset` (max 200).");
    }

    for (const rawKey of setKeys) {
      try {
        const normalized = validateKeyNameOrThrow(rawKey);
        normalizedSet[normalized] = set[rawKey];
      } catch (err) {
        errors.push(`${rawKey}: ${err.message}`);
      }
    }

    for (const rawKey of unset) {
      try {
        const normalized = validateKeyNameOrThrow(rawKey);
        normalizedUnset.push(normalized);
      } catch (err) {
        errors.push(`${rawKey}: ${err.message}`);
      }
    }

    return {
      set: normalizedSet,
      unset: sortedUnique(normalizedUnset),
      errors
    };
  }

  buildDiff({ oldOverrides = {}, nextOverrides = {} } = {}) {
    const keys = sortedUnique([
      ...Object.keys(oldOverrides || {}),
      ...Object.keys(nextOverrides || {})
    ]);

    const diff = [];
    let restartRequired = false;

    for (const key of keys) {
      const oldHas = Object.prototype.hasOwnProperty.call(oldOverrides, key);
      const newHas = Object.prototype.hasOwnProperty.call(nextOverrides, key);
      const oldValue = oldHas ? String(oldOverrides[key] ?? "") : undefined;
      const newValue = newHas ? String(nextOverrides[key] ?? "") : undefined;
      if (oldHas === newHas && oldValue === newValue) {
        continue;
      }

      const meta = SCHEMA[key] || {
        restartRequired: false,
        sensitive: isSensitiveKey(key)
      };
      const sensitive = Boolean(meta.sensitive || isSensitiveKey(key));
      const action = !oldHas && newHas ? "add" : oldHas && !newHas ? "remove" : "update";
      const item = {
        key,
        action,
        from: sensitive ? maskSensitiveValue(oldValue) : String(oldValue ?? ""),
        to: sensitive ? maskSensitiveValue(newValue) : String(newValue ?? ""),
        sensitive,
        restartRequired: meta.restartRequired !== false
      };
      if (item.restartRequired) {
        restartRequired = true;
      }
      diff.push(item);
    }

    return {
      diff,
      restartRequired
    };
  }

  preview({ changeSet = {}, actor = "unknown", requestMeta = {} } = {}) {
    this.cleanupPreviewCache();

    const normalized = this.normalizeChangeSet(changeSet);
    const errors = [...normalized.errors];

    const oldOverrides = this.getCurrentOverrides();
    const nextOverrides = { ...oldOverrides };

    for (const [key, rawValue] of Object.entries(normalized.set)) {
      const isSensitive = isSensitiveKey(key);
      const maskedNoop =
        isSensitive && String(rawValue ?? "") === "********" && oldOverrides[key];
      if (maskedNoop) {
        continue;
      }

      try {
        const { value } = validateKeyValueOrThrow(key, rawValue);
        nextOverrides[key] = value;
      } catch (err) {
        errors.push(`${key}: ${err.message}`);
      }
    }

    for (const key of normalized.unset) {
      delete nextOverrides[key];
    }

    const { diff, restartRequired } = this.buildDiff({
      oldOverrides,
      nextOverrides
    });

    if (errors.length > 0) {
      return {
        ok: false,
        errors,
        diff,
        restartRequired,
        previewId: null
      };
    }

    const previewId = crypto.randomUUID();
    this.previewCache.set(previewId, {
      previewId,
      createdAt: safeNowIso(),
      expiresAtMs: Date.now() + 5 * 60 * 1000,
      actor,
      requestMeta,
      oldOverrides,
      nextOverrides,
      diff,
      restartRequired
    });

    return {
      ok: true,
      previewId,
      errors: [],
      diff,
      restartRequired
    };
  }

  async applyPreview({ previewId, actor = "unknown", requestMeta = {} } = {}) {
    this.cleanupPreviewCache();
    const record = this.previewCache.get(String(previewId || ""));
    if (!record) {
      throw new Error("Preview ID is missing or expired. Create a new preview.");
    }

    this.requireEncryptionKey();

    const nowIso = safeNowIso();
    const nextKeyUpdatedAt = { ...(this.store.keyUpdatedAt || {}) };

    for (const item of record.diff) {
      nextKeyUpdatedAt[item.key] = nowIso;
      if (item.action === "remove") {
        delete nextKeyUpdatedAt[item.key];
      }
    }

    const nextPayload = {
      version: 1,
      updatedAt: nowIso,
      overrides: record.nextOverrides,
      keyUpdatedAt: nextKeyUpdatedAt
    };

    saveEncryptedOverrides({
      overridesFile: this.overridesFile,
      backupsDir: this.backupsDir,
      encryptionKey: this.encryptionKey,
      payload: nextPayload
    });

    const previousOverrides = this.store.overrides;
    this.store = nextPayload;
    applyOverridesToProcessEnv({
      overrides: this.store.overrides,
      previousOverrides,
      baseDotEnv: this.baseDotEnv,
      env: process.env
    });

    const reloadResult = await this.onReload({
      changedKeys: record.diff.map((item) => item.key)
    });

    appendAuditEntry({
      auditFile: this.auditFile,
      entry: {
        action: "config.apply",
        actor,
        requestMeta,
        previewId: record.previewId,
        restartRequired: record.restartRequired,
        changedKeys: record.diff.map((item) => item.key),
        diff: record.diff.map((item) => ({
          key: item.key,
          action: item.action,
          from: sanitizeAuditValue(item.key, item.from),
          to: sanitizeAuditValue(item.key, item.to),
          sensitive: item.sensitive,
          restartRequired: item.restartRequired
        }))
      }
    });

    this.previewCache.delete(record.previewId);

    return {
      ok: true,
      appliedAt: nowIso,
      diff: record.diff,
      restartRequired: record.restartRequired,
      reloadResult: reloadResult || null
    };
  }

  getSchema() {
    return listSchemaForClient();
  }

  getConfigSnapshot({ search = "" } = {}) {
    return {
      updatedAt: this.store.updatedAt || null,
      overridesCount: Object.keys(this.store.overrides || {}).length,
      entries: this.getConfigEntries({ search })
    };
  }

  getAudit({ limit = 200 } = {}) {
    return readAuditEntries({
      auditFile: this.auditFile,
      limit
    });
  }
}

module.exports = {
  ConfigService
};

function nowIso() {
  return new Date().toISOString();
}

function redactSensitiveParts(input) {
  let text = String(input ?? "");
  if (!text) {
    return text;
  }

  text = text
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/Bearer\\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/\"?(OPENAI_API_KEY|CONTROL_API_TOKEN|CONFIG_ENCRYPTION_KEY)\"?\\s*[:=]\\s*\"?[^\\s\",]+\"?/gi, "$1=[REDACTED]");

  const runtimeSecrets = [
    process.env.OPENAI_API_KEY,
    process.env.CONTROL_API_TOKEN,
    process.env.CONFIG_ENCRYPTION_KEY
  ]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length >= 8);

  for (const secret of runtimeSecrets) {
    text = text.split(secret).join("[REDACTED]");
  }

  return text;
}

function log(scope, message, ...rest) {
  console.log(
    `[${nowIso()}] [${scope}] ${redactSensitiveParts(message)}`,
    ...rest.map((item) => redactSensitiveParts(item))
  );
}

function warn(scope, message, ...rest) {
  console.warn(
    `[${nowIso()}] [${scope}] ${redactSensitiveParts(message)}`,
    ...rest.map((item) => redactSensitiveParts(item))
  );
}

function error(scope, message, ...rest) {
  console.error(
    `[${nowIso()}] [${scope}] ${redactSensitiveParts(message)}`,
    ...rest.map((item) => redactSensitiveParts(item))
  );
}

module.exports = {
  log,
  warn,
  error
};

function nowIso() {
  return new Date().toISOString();
}

function log(scope, message, ...rest) {
  console.log(`[${nowIso()}] [${scope}] ${message}`, ...rest);
}

function warn(scope, message, ...rest) {
  console.warn(`[${nowIso()}] [${scope}] ${message}`, ...rest);
}

function error(scope, message, ...rest) {
  console.error(`[${nowIso()}] [${scope}] ${message}`, ...rest);
}

module.exports = {
  log,
  warn,
  error
};

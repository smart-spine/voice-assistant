async function withTimeout(promise, timeoutMs, label = "operation") {
  const timeoutValue = Number(timeoutMs);
  if (!Number.isFinite(timeoutValue) || timeoutValue <= 0) {
    return promise;
  }

  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutValue}ms`));
        }, timeoutValue);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  withTimeout
};

function truncateText(value, maxChars) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trimEnd()}...`;
}

function normalizeProjectContext(projectContext, maxChars = 6000) {
  if (projectContext === undefined || projectContext === null) {
    return "";
  }

  let value = "";
  if (typeof projectContext === "string") {
    value = projectContext;
  } else if (typeof projectContext === "object") {
    try {
      value = JSON.stringify(projectContext, null, 2);
    } catch (_) {
      value = "";
    }
  }

  return truncateText(value, maxChars);
}

function buildSystemPrompt({
  basePrompt,
  projectContext,
  responseLanguage = ""
} = {}) {
  const prompt = String(basePrompt || "").trim();
  const context = normalizeProjectContext(projectContext);
  const normalizedResponseLanguage = String(responseLanguage)
    .trim()
    .toLowerCase();

  let result = prompt;
  if (normalizedResponseLanguage.startsWith("en")) {
    result = `${result}

Language policy:
- Respond in English only.
- Do not switch to other languages, even if incoming speech contains them.`;
  }

  if (!context) {
    return result;
  }

  return `${result}

Additional project context from the intake form:
${context}`;
}

module.exports = {
  buildSystemPrompt,
  normalizeProjectContext
};

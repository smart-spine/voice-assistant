function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return 0;
  }
  return normalized.split(" ").filter(Boolean).length;
}

function normalizeComparableText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[.,!?;:]+$/g, "");
}

function normalizeLooseComparableText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isTextExpansion(baseText, nextText) {
  const base = normalizeComparableText(baseText);
  const next = normalizeComparableText(nextText);
  if (!base || !next || base === next) {
    return false;
  }
  return next.startsWith(base);
}

function isLikelySentenceComplete(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  const words = countWords(normalized);
  if (words < 3) {
    return false;
  }

  return /[.!?…]["')\]]*$/.test(normalized);
}

const TRAILING_JOINER_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "because",
  "but",
  "for",
  "from",
  "if",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "to",
  "when",
  "while",
  "with",
  "и",
  "а",
  "но",
  "если",
  "когда",
  "что",
  "чтобы",
  "для",
  "в",
  "на",
  "по",
  "с"
]);

function isLikelyIncompleteFragment(
  text,
  { minWordsForComplete = 4, avoidJoinerWordCheck = false } = {}
) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return true;
  }

  if (isLikelySentenceComplete(normalized)) {
    return false;
  }

  const words = countWords(normalized);
  if (words < minWordsForComplete) {
    return true;
  }

  if (/[,:;\-]$/.test(normalized)) {
    return true;
  }

  if (!avoidJoinerWordCheck) {
    const tokens = normalized
      .toLowerCase()
      .replace(/[^a-zа-яё0-9'\s-]/gi, " ")
      .split(" ")
      .filter(Boolean);
    const lastWord = tokens[tokens.length - 1] || "";
    if (TRAILING_JOINER_WORDS.has(lastWord)) {
      return true;
    }
  }

  return false;
}

function extractCommandByWakeWord(text, wakeWord) {
  if (!wakeWord) {
    return text;
  }

  const source = String(text || "").toLowerCase();
  const trigger = String(wakeWord || "").toLowerCase();
  const index = source.indexOf(trigger);

  if (index < 0) {
    return "";
  }

  const tail = String(text || "")
    .slice(index + String(wakeWord).length)
    .replace(/^[\s,.:;!?-]+/, "");
  return tail.trim();
}

module.exports = {
  normalizeText,
  countWords,
  normalizeComparableText,
  normalizeLooseComparableText,
  isTextExpansion,
  isLikelySentenceComplete,
  isLikelyIncompleteFragment,
  extractCommandByWakeWord
};

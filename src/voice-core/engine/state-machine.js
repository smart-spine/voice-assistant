const SESSION_STATES = {
  READY: "ready",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  INTERRUPTED: "interrupted",
  STOPPED: "stopped",
  ERROR: "error"
};

const ALLOWED_TRANSITIONS = {
  [SESSION_STATES.READY]: new Set([
    SESSION_STATES.READY,
    SESSION_STATES.LISTENING,
    SESSION_STATES.THINKING,
    SESSION_STATES.SPEAKING,
    SESSION_STATES.INTERRUPTED,
    SESSION_STATES.STOPPED,
    SESSION_STATES.ERROR
  ]),
  [SESSION_STATES.LISTENING]: new Set([
    SESSION_STATES.LISTENING,
    SESSION_STATES.THINKING,
    SESSION_STATES.SPEAKING,
    SESSION_STATES.INTERRUPTED,
    SESSION_STATES.READY,
    SESSION_STATES.STOPPED,
    SESSION_STATES.ERROR
  ]),
  [SESSION_STATES.THINKING]: new Set([
    SESSION_STATES.THINKING,
    SESSION_STATES.SPEAKING,
    SESSION_STATES.INTERRUPTED,
    SESSION_STATES.READY,
    SESSION_STATES.STOPPED,
    SESSION_STATES.ERROR
  ]),
  [SESSION_STATES.SPEAKING]: new Set([
    SESSION_STATES.SPEAKING,
    SESSION_STATES.INTERRUPTED,
    SESSION_STATES.READY,
    SESSION_STATES.LISTENING,
    SESSION_STATES.STOPPED,
    SESSION_STATES.ERROR
  ]),
  [SESSION_STATES.INTERRUPTED]: new Set([
    SESSION_STATES.INTERRUPTED,
    SESSION_STATES.LISTENING,
    SESSION_STATES.THINKING,
    SESSION_STATES.READY,
    SESSION_STATES.STOPPED,
    SESSION_STATES.ERROR
  ]),
  [SESSION_STATES.ERROR]: new Set([
    SESSION_STATES.ERROR,
    SESSION_STATES.READY,
    SESSION_STATES.LISTENING,
    SESSION_STATES.THINKING,
    SESSION_STATES.SPEAKING,
    SESSION_STATES.INTERRUPTED,
    SESSION_STATES.STOPPED
  ]),
  [SESSION_STATES.STOPPED]: new Set([SESSION_STATES.STOPPED])
};

function normalizeState(state) {
  return String(state || "")
    .trim()
    .toLowerCase();
}

function canTransition(fromState, toState) {
  const from = normalizeState(fromState);
  const to = normalizeState(toState);
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) {
    return false;
  }
  return allowed.has(to);
}

function assertTransition(fromState, toState) {
  if (!canTransition(fromState, toState)) {
    throw new Error(`Invalid session state transition: ${fromState} -> ${toState}.`);
  }
}

module.exports = {
  SESSION_STATES,
  canTransition,
  assertTransition,
  normalizeState
};

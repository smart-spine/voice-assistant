const { AudioPipeline } = require("./audio-pipeline");
const { TurnManager } = require("./turn-manager");
const {
  BaseAIProvider,
  OpenAIRealtimeAIProvider,
  createAIProvider
} = require("./ai-provider");
const { VoiceSession } = require("./voice-session");
const { SessionManager } = require("./session-manager");
const { VoiceEngine } = require("./voice-engine");
const {
  SESSION_STATES,
  canTransition,
  assertTransition,
  normalizeState
} = require("./state-machine");

module.exports = {
  AudioPipeline,
  TurnManager,
  BaseAIProvider,
  OpenAIRealtimeAIProvider,
  createAIProvider,
  VoiceSession,
  SessionManager,
  VoiceEngine,
  SESSION_STATES,
  canTransition,
  assertTransition,
  normalizeState
};

const constants = require("./constants");
const envelope = require("./envelope");
const audioFrame = require("./audio-frame");

module.exports = {
  ...constants,
  ...envelope,
  ...audioFrame
};

const { OpenAIResponder } = require("./openai-service");
const { LangChainAgentResponder } = require("./langchain-agent-service");

function createResponder({
  runtime = "langchain",
  ...options
} = {}) {
  const normalizedRuntime = String(runtime || "langchain")
    .trim()
    .toLowerCase();

  if (normalizedRuntime === "openai") {
    return new OpenAIResponder(options);
  }

  return new LangChainAgentResponder(options);
}

module.exports = {
  createResponder
};

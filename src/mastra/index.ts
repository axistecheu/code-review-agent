import { Mastra } from "@mastra/core";
import { codeReviewAgent } from "./agents/code-review-agent.js";
import { prReviewWorkflow } from "./workflows/pr-review-workflow.js";

// Create and export the Mastra instance
export const mastra = new Mastra({
  agents: {
    "code-review-agent": codeReviewAgent,
  },
  workflows: {
    "pr-review-workflow": prReviewWorkflow,
  },
});

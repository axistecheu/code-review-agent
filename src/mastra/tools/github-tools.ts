import { createTool } from "@mastra/core/tools";
import { Octokit } from "octokit";
import { z } from "zod";

// Initialize Octokit with GitHub token
const getOctokit = () => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }
  return new Octokit({ auth: token });
};

// Schema definitions
const PRFileSchema = z.object({
  filename: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number(),
  deletions: z.number(),
  changes: z.number(),
  blob_url: z.string(),
  raw_url: z.string(),
  contents_url: z.string(),
  patch: z.string().optional(),
});

// Tool: Get PR files
export const getPullRequestFiles = createTool({
  id: "get-pull-request-files",
  description:
    "Get the list of files changed in a pull request with their details",
  inputSchema: z.object({
    owner: z.string().describe("Repository owner (username or organization)"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
  }),
  outputSchema: z.object({
    files: z.array(PRFileSchema),
    totalCount: z.number(),
  }),
  execute: async ({ context }) => {
    const { owner, repo, pullNumber } = context;
    const octokit = getOctokit();

    const response = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    const files = response.data.map((file) => ({
      filename: file.filename,
      status: file.status as "added" | "modified" | "deleted" | "renamed",
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      blob_url: file.blob_url,
      raw_url: file.raw_url,
      contents_url: file.contents_url,
      patch: file.patch,
    }));

    return {
      files,
      totalCount: files.length,
    };
  },
});

// Tool: Get PR diff
export const getPullRequestDiff = createTool({
  id: "get-pull-request-diff",
  description: "Get the full diff content of a pull request",
  inputSchema: z.object({
    owner: z.string().describe("Repository owner (username or organization)"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
  }),
  outputSchema: z.object({
    diff: z.string(),
  }),
  execute: async ({ context }) => {
    const { owner, repo, pullNumber } = context;
    const octokit = getOctokit();

    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: {
        format: "diff",
      },
    });

    // When format is 'diff', the data is the raw diff string
    const diff =
      typeof response.data === "string"
        ? response.data
        : JSON.stringify(response.data);

    return { diff };
  },
});

// Tool: Create PR review
export const createPullRequestReview = createTool({
  id: "create-pull-request-review",
  description:
    "Post a review comment on a pull request. Use this to submit code review feedback.",
  inputSchema: z.object({
    owner: z.string().describe("Repository owner (username or organization)"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
    body: z.string().describe("The body of the review comment"),
    event: z
      .enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"])
      .optional()
      .default("COMMENT")
      .describe("The review event type"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    reviewId: z.number().optional(),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    const { owner, repo, pullNumber, body, event } = context;
    const octokit = getOctokit();

    try {
      const response = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        body,
        event: event || "COMMENT",
      });

      return {
        success: true,
        reviewId: response.data.id,
        message: "Review posted successfully",
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        message: `Failed to post review: ${errorMessage}`,
      };
    }
  },
});

// Export schema for use in other modules
export { PRFileSchema };

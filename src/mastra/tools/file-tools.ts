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
const DirectoryInfoSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "dir", "symlink", "submodule"]),
  sha: z.string().optional(),
  size: z.number().optional(),
  download_url: z.string().nullable().optional(),
});

// Tool: Get file content via GitHub API
export const getFileContent = createTool({
  id: "get-file-content",
  description:
    "Fetch the full content of a file from a GitHub repository. This gives you access to the complete file, not just the diff, allowing you to understand the full context of the code.",
  inputSchema: z.object({
    owner: z.string().describe("Repository owner (username or organization)"),
    repo: z.string().describe("Repository name"),
    path: z.string().describe("Path to the file in the repository"),
    ref: z
      .string()
      .optional()
      .describe("Git reference (branch, tag, or commit SHA)"),
  }),
  outputSchema: z.object({
    content: z.string(),
    encoding: z.string(),
    size: z.number(),
    path: z.string(),
    sha: z.string(),
  }),
  execute: async ({ context }) => {
    const { owner, repo, path, ref } = context;
    const octokit = getOctokit();

    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    // Check if it's a file (not a directory)
    if (Array.isArray(response.data)) {
      throw new Error(
        `Path '${path}' is a directory, not a file. Use get-directory-contents instead.`
      );
    }

    if (response.data.type !== "file") {
      throw new Error(`Path '${path}' is not a file (type: ${response.data.type})`);
    }

    // Decode content from base64
    const content = response.data.content
      ? Buffer.from(response.data.content, "base64").toString("utf-8")
      : "";

    return {
      content,
      encoding: response.data.encoding || "base64",
      size: response.data.size,
      path: response.data.path,
      sha: response.data.sha,
    };
  },
});

// Tool: Get file at PR head branch
export const getFileAtPRHead = createTool({
  id: "get-file-at-pr-head",
  description:
    "Fetch the content of a file from the head branch of a pull request (the branch with the changes). Use this to see the new version of files being changed in the PR.",
  inputSchema: z.object({
    owner: z.string().describe("Repository owner (username or organization)"),
    repo: z.string().describe("Repository name"),
    path: z.string().describe("Path to the file in the repository"),
    pullNumber: z.number().describe("Pull request number"),
  }),
  outputSchema: z.object({
    content: z.string(),
    path: z.string(),
    exists: z.boolean(),
    headRef: z.string(),
  }),
  execute: async ({ context }) => {
    const { owner, repo, path, pullNumber } = context;
    const octokit = getOctokit();

    // First, get the PR to find the head ref
    const prResponse = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    const headRef = prResponse.data.head.ref;

    try {
      const fileResponse = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: headRef,
      });

      if (Array.isArray(fileResponse.data) || fileResponse.data.type !== "file") {
        return {
          content: "",
          path,
          exists: false,
          headRef,
        };
      }

      const content = fileResponse.data.content
        ? Buffer.from(fileResponse.data.content, "base64").toString("utf-8")
        : "";

      return {
        content,
        path,
        exists: true,
        headRef,
      };
    } catch {
      // File might not exist in head (e.g., deleted in PR)
      return {
        content: "",
        path,
        exists: false,
        headRef,
      };
    }
  },
});

// Tool: Get file at base branch
export const getFileAtBaseBranch = createTool({
  id: "get-file-at-base-branch",
  description:
    "Fetch the content of a file from the base branch of a pull request (the target branch, usually main/master). Use this to compare with the head version and understand what changed.",
  inputSchema: z.object({
    owner: z.string().describe("Repository owner (username or organization)"),
    repo: z.string().describe("Repository name"),
    path: z.string().describe("Path to the file in the repository"),
    pullNumber: z.number().describe("Pull request number"),
  }),
  outputSchema: z.object({
    content: z.string(),
    path: z.string(),
    exists: z.boolean(),
    baseRef: z.string(),
  }),
  execute: async ({ context }) => {
    const { owner, repo, path, pullNumber } = context;
    const octokit = getOctokit();

    // First, get the PR to find the base ref
    const prResponse = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    const baseRef = prResponse.data.base.ref;

    try {
      const fileResponse = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: baseRef,
      });

      if (Array.isArray(fileResponse.data) || fileResponse.data.type !== "file") {
        return {
          content: "",
          path,
          exists: false,
          baseRef,
        };
      }

      const content = fileResponse.data.content
        ? Buffer.from(fileResponse.data.content, "base64").toString("utf-8")
        : "";

      return {
        content,
        path,
        exists: true,
        baseRef,
      };
    } catch {
      // File might not exist in base (e.g., new file in PR)
      return {
        content: "",
        path,
        exists: false,
        baseRef,
      };
    }
  },
});

// Tool: Get directory contents
export const getDirectoryContents = createTool({
  id: "get-directory-contents",
  description:
    "List the contents of a directory in a GitHub repository. Use this to understand the project structure and find relevant files for context.",
  inputSchema: z.object({
    owner: z.string().describe("Repository owner (username or organization)"),
    repo: z.string().describe("Repository name"),
    path: z
      .string()
      .optional()
      .describe("Path to the directory (defaults to repository root)"),
    ref: z
      .string()
      .optional()
      .describe("Git reference (branch, tag, or commit SHA)"),
  }),
  outputSchema: z.object({
    contents: z.array(DirectoryInfoSchema),
    path: z.string(),
    totalCount: z.number(),
  }),
  execute: async ({ context }) => {
    const { owner, repo, path = "", ref } = context;
    const octokit = getOctokit();

    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if (!Array.isArray(response.data)) {
      // It's a file, not a directory
      return {
        contents: [
          {
            name: response.data.name,
            path: response.data.path,
            type: response.data.type as "file",
            sha: response.data.sha,
            size: response.data.size,
            download_url: response.data.download_url,
          },
        ],
        path,
        totalCount: 1,
      };
    }

    const contents = response.data.map((item) => ({
      name: item.name,
      path: item.path,
      type: item.type as "file" | "dir" | "symlink" | "submodule",
      sha: item.sha,
      size: item.size,
      download_url: item.download_url,
    }));

    return {
      contents,
      path,
      totalCount: contents.length,
    };
  },
});

// Export schema for use in other modules
export { DirectoryInfoSchema };

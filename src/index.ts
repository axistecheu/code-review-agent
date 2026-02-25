// Load environment variables first
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import crypto from "crypto";
import { mastra } from "./mastra/index.js";
import { WebhookPayloadSchema } from "./mastra/workflows/pr-review-workflow.js";

const app = express();
const PORT = process.env.PORT || 4111;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";

// Middleware
app.use(cors());
app.use(
  express.json({
    verify: (req: any, _res: any, buf: Buffer) => {
      req.rawBody = buf;
    },
  })
);

// Verify GitHub webhook signature
function verifyGitHubSignature(req: any): boolean {
  if (!GITHUB_WEBHOOK_SECRET) {
    console.warn("WARNING: GITHUB_WEBHOOK_SECRET not set, skipping signature verification");
    return true;
  }

  const signature = req.headers["x-hub-signature-256"] as string;
  if (!signature) {
    return false;
  }

  const payload = req.rawBody;
  const expectedSignature = `sha256=${crypto
    .createHmac("sha256", GITHUB_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex")}`;

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Health check endpoint
app.get("/health", (_req: any, res: any) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// GitHub webhook endpoint
app.post("/webhook/github", async (req: any, res: any) => {
  try {
    // Verify signature
    if (!verifyGitHubSignature(req)) {
      console.error("Invalid webhook signature");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const event = req.headers["x-github-event"] as string;
    const payload = req.body;

    console.log(`Received GitHub event: ${event}`);

    // Handle ping event
    if (event === "ping") {
      res.json({ message: "pong" });
      return;
    }

    // Handle pull request events
    if (event === "pull_request") {
      const action = payload.action;

      // Only process relevant PR actions
      const relevantActions = ["opened", "synchronize", "reopened"];
      if (!relevantActions.includes(action)) {
        console.log(`Ignoring PR action: ${action}`);
        res.json({ message: `Action ${action} ignored` });
        return;
      }

      // Extract PR data
      const pr = payload.pull_request;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const pullNumber = pr.number;

      console.log(
        `Processing PR #${pullNumber} in ${owner}/${repo}: ${pr.title}`
      );

      // Prepare workflow input
      const workflowInput = {
        owner,
        repo,
        pullNumber,
        prTitle: pr.title,
        prUrl: pr.html_url,
        prAuthor: pr.user.login,
        baseBranch: pr.base.ref,
        headBranch: pr.head.ref,
        action,
      };

      // Validate input
      const validatedInput = WebhookPayloadSchema.parse(workflowInput);

      // Start the workflow
      const workflow = mastra.getWorkflow("pr-review-workflow");
      if (!workflow) {
        throw new Error("PR review workflow not found");
      }

      // Create and start workflow run
      const run = await workflow.createRunAsync();
      const result = await run.start({ inputData: validatedInput });

      if (result.status === "success") {
        console.log("Workflow completed successfully:", result.result);
        res.json({
          message: "Review workflow completed",
          result: result.result,
        });
      } else if (result.status === "suspended") {
        console.log("Workflow suspended:", result.suspended);
        res.json({
          message: "Review workflow suspended",
          suspended: result.suspended,
        });
      } else if (result.status === "failed") {
        console.error("Workflow failed:", result.error);
        res.status(500).json({
          error: "Workflow failed",
          details: result.error?.message || "Unknown error",
        });
      } else {
        // Handle tripwire status
        const tripwireResult = result as { status: string; tripwire?: { reason?: string } };
        res.status(500).json({
          error: "Workflow terminated",
          status: tripwireResult.status,
          reason: tripwireResult.tripwire?.reason || "Unknown reason",
        });
      }
      return;
    }

    // Ignore other events
    res.json({ message: `Event ${event} not handled` });
  } catch (error) {
    console.error("Error processing webhook:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: errorMessage });
  }
});

// Manual trigger endpoint for testing
app.post("/trigger-review", async (req: any, res: any) => {
  try {
    const { owner, repo, pullNumber } = req.body;

    if (!owner || !repo || !pullNumber) {
      res.status(400).json({
        error: "Missing required fields: owner, repo, pullNumber",
      });
      return;
    }

    // Fetch PR details from GitHub
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("GITHUB_TOKEN not configured");
    }

    const prResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Code-Review-Agent",
        },
      }
    );

    if (!prResponse.ok) {
      throw new Error(`Failed to fetch PR: ${prResponse.statusText}`);
    }

    const pr = (await prResponse.json()) as {
      title: string;
      html_url: string;
      user: { login: string };
      base: { ref: string };
      head: { ref: string };
    };

    const workflowInput = {
      owner,
      repo,
      pullNumber,
      prTitle: pr.title,
      prUrl: pr.html_url,
      prAuthor: pr.user.login,
      baseBranch: pr.base.ref,
      headBranch: pr.head.ref,
      action: "opened" as const,
    };

    const validatedInput = WebhookPayloadSchema.parse(workflowInput);

    const workflow = mastra.getWorkflow("pr-review-workflow");
    if (!workflow) {
      throw new Error("PR review workflow not found");
    }

    const run = await workflow.createRunAsync();
    const result = await run.start({ inputData: validatedInput });

    if (result.status === "success") {
      res.json({
        message: "Review completed",
        result: result.result,
      });
    } else if (result.status === "failed") {
      res.status(500).json({
        error: "Workflow failed",
        details: result.error?.message || "Unknown error",
      });
    } else {
      // Handle tripwire or suspended status
      const otherResult = result as { status: string; tripwire?: { reason?: string }; suspended?: unknown[] };
      res.status(500).json({
        error: "Workflow ended with unexpected status",
        status: otherResult.status,
      });
    }
  } catch (error) {
    console.error("Error in manual trigger:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: errorMessage });
  }
});

// Error handling middleware
app.use((err: Error, _req: any, res: any, _next: any) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Code Review Agent server running on port ${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook/github`);
  console.log(`Manual trigger: POST http://localhost:${PORT}/trigger-review`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Load environment variables first
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { MastraServer } from "@mastra/express";
import crypto from "crypto";
import { mastra } from "./mastra/index.js";
import { WebhookPayloadSchema } from "./mastra/workflows/pr-review-workflow.js";

const app = express();
const PORT = process.env.PORT || 4111;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";

// Create Mastra server adapter
const server = new MastraServer({ app, mastra });

// Add raw body for webhook signature verification
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
    console.warn("[Webhook] WARNING: GITHUB_WEBHOOK_SECRET not set, skipping signature verification");
    return true;
  }

  const signature = req.headers["x-hub-signature-256"] as string;
  console.log("[Webhook] Signature header:", signature ? "present" : "missing");

  if (!signature) {
    console.error("[Webhook] No signature header found");
    return false;
  }

  const payload = req.rawBody;
  console.log("[Webhook] Raw body length:", payload?.length || 0);

  if (!payload) {
    console.error("[Webhook] No raw body found - verify middleware order");
    return false;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac("sha256", GITHUB_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex")}`;

  console.log("[Webhook] Expected signature:", expectedSignature.substring(0, 20) + "...");
  console.log("[Webhook] Received signature:", signature.substring(0, 20) + "...");

  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
    console.log("[Webhook] Signature valid:", isValid);
    return isValid;
  } catch (error) {
    console.error("[Webhook] Signature comparison error:", error);
    return false;
  }
}

// Health check endpoint (before Mastra init for quick access)
app.get("/health", (_req: any, res: any) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// GitHub webhook endpoint (before Mastra init - doesn't need Mastra context)
app.post("/webhook/github", async (req: any, res: any) => {
  console.log("[Webhook] ===== Received GitHub webhook =====");
  console.log("[Webhook] Headers:", JSON.stringify(req.headers, null, 2));

  try {
    // Verify signature
    if (!verifyGitHubSignature(req)) {
      console.error("[Webhook] Invalid signature - rejecting request");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
    console.log("[Webhook] Signature verified successfully");

    const event = req.headers["x-github-event"] as string;
    const payload = req.body;

    console.log(`[Webhook] Event type: ${event}`);

    // Handle ping event
    if (event === "ping") {
      console.log("[Webhook] Ping received - responding with pong");
      res.json({ message: "pong" });
      return;
    }

    // Handle pull request events
    if (event === "pull_request") {
      const action = payload.action;
      console.log(`[Webhook] PR action: ${action}`);

      // Only process relevant PR actions
      const relevantActions = ["opened", "synchronize", "reopened"];
      if (!relevantActions.includes(action)) {
        console.log(`[Webhook] Ignoring PR action: ${action}`);
        res.json({ message: `Action ${action} ignored` });
        return;
      }

      // Extract PR data
      const pr = payload.pull_request;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const pullNumber = pr.number;

      console.log(`[Webhook] Processing PR #${pullNumber} in ${owner}/${repo}: ${pr.title}`);

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

      console.log("[Webhook] Workflow input:", JSON.stringify(workflowInput, null, 2));

      // Validate input
      const validatedInput = WebhookPayloadSchema.parse(workflowInput);
      console.log("[Webhook] Input validated successfully");

      // Start the workflow
      console.log("[Webhook] Getting workflow: pr-review-workflow");
      const workflow = mastra.getWorkflow("pr-review-workflow");
      if (!workflow) {
        console.error("[Webhook] ERROR: PR review workflow not found");
        throw new Error("PR review workflow not found");
      }
      console.log("[Webhook] Workflow found, creating run...");

      // Create and start workflow run
      const run = await workflow.createRun();
      console.log("[Webhook] Run created, starting with input data...");

      const result = await run.start({ inputData: validatedInput });
      console.log("[Webhook] Workflow result status:", result.status);

      if (result.status === "success") {
        console.log("[Webhook] Workflow completed successfully");
        res.json({
          message: "Review workflow completed",
          result: result.result,
        });
      } else if (result.status === "suspended") {
        console.log("[Webhook] Workflow suspended:", result.suspended);
        res.json({
          message: "Review workflow suspended",
          suspended: result.suspended,
        });
      } else if (result.status === "failed") {
        console.error("[Webhook] Workflow failed:", result.error);
        res.status(500).json({
          error: "Workflow failed",
          details: result.error?.message || "Unknown error",
        });
      } else {
        // Handle tripwire status
        const tripwireResult = result as { status: string; tripwire?: { reason?: string } };
        console.error("[Webhook] Workflow terminated:", tripwireResult.status);
        res.status(500).json({
          error: "Workflow terminated",
          status: tripwireResult.status,
          reason: tripwireResult.tripwire?.reason || "Unknown reason",
        });
      }
      return;
    }

    // Ignore other events
    console.log(`[Webhook] Event ${event} not handled`);
    res.json({ message: `Event ${event} not handled` });
  } catch (error) {
    console.error("[Webhook] ERROR processing webhook:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: errorMessage });
  }
});

// Manual trigger endpoint (before Mastra init - uses mastra directly)
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

    const run = await workflow.createRun();
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

// Initialize Mastra server (registers all Mastra routes and middleware)
await server.init();

// Start server
app.listen(PORT, () => {
  console.log(`Code Review Agent server running on port ${PORT}`);
  console.log(`Mastra API endpoints available at /api/*`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook/github`);
  console.log(`Manual trigger: POST http://localhost:${PORT}/trigger-review`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

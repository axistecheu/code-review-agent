import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { Octokit } from "octokit";

// Input schema for webhook payload
const WebhookPayloadSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  pullNumber: z.number(),
  prTitle: z.string(),
  prUrl: z.string(),
  prAuthor: z.string(),
  baseBranch: z.string(),
  headBranch: z.string(),
  action: z.enum(["opened", "synchronize", "reopened"]),
});

// PR Context schema
const PRContextSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  pullNumber: z.number(),
  prTitle: z.string(),
  prUrl: z.string(),
  prAuthor: z.string(),
  baseBranch: z.string(),
  headBranch: z.string(),
  files: z.array(
    z.object({
      filename: z.string(),
      status: z.enum(["added", "modified", "deleted", "renamed"]),
      additions: z.number(),
      deletions: z.number(),
      changes: z.number(),
    })
  ),
  diff: z.string(),
  totalAdditions: z.number(),
  totalDeletions: z.number(),
});

// Review result schema
const ReviewResultSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  pullNumber: z.number(),
  reviewContent: z.string(),
  verdict: z.enum(["approved", "changes_requested", "commented"]),
});

// Final result schema
const FinalResultSchema = z.object({
  success: z.boolean(),
  prUrl: z.string(),
  reviewPosted: z.boolean(),
  notificationSent: z.boolean(),
  message: z.string(),
});

// Helper to get Octokit
const getOctokit = () => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }
  return new Octokit({ auth: token });
};

// Step 1: Fetch PR context
const fetchPRContext = createStep({
  id: "fetch-pr-context",
  description: "Fetch PR files, diff, and metadata from GitHub",
  inputSchema: WebhookPayloadSchema,
  outputSchema: PRContextSchema,
  execute: async ({ inputData }) => {
    const { owner, repo, pullNumber, prTitle, prUrl, prAuthor, baseBranch, headBranch } =
      inputData;

    console.log(`[fetchPRContext] Fetching context for PR #${pullNumber} in ${owner}/${repo}`);

    const octokit = getOctokit();

    // Fetch PR files
    console.log("[fetchPRContext] Fetching PR files...");
    const filesResponse = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    const files = filesResponse.data.map((file) => ({
      filename: file.filename,
      status: file.status as "added" | "modified" | "deleted" | "renamed",
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    console.log(`[fetchPRContext] Found ${files.length} files`);

    // Fetch diff
    console.log("[fetchPRContext] Fetching diff...");
    const diffResponse = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: {
        format: "diff",
      },
    });

    const diff =
      typeof diffResponse.data === "string"
        ? diffResponse.data
        : JSON.stringify(diffResponse.data);
    console.log(`[fetchPRContext] Diff length: ${diff.length} characters`);

    // Calculate totals
    const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

    return {
      owner,
      repo,
      pullNumber,
      prTitle,
      prUrl,
      prAuthor,
      baseBranch,
      headBranch,
      files,
      diff,
      totalAdditions,
      totalDeletions,
    };
  },
});

// Step 2: Perform code review with agent
const performReview = createStep({
  id: "perform-review",
  description: "Use the code review agent to analyze the PR",
  inputSchema: PRContextSchema,
  outputSchema: ReviewResultSchema,
  execute: async ({ inputData, mastra }) => {
    const { owner, repo, pullNumber, prTitle, prUrl, prAuthor, files, diff, totalAdditions, totalDeletions } =
      inputData;

    console.log(`[performReview] Starting review for PR #${pullNumber} in ${owner}/${repo}`);
    console.log(`[performReview] Files to review: ${files.length}`);

    // Get the code review agent
    const agent = mastra?.getAgent("code-review-agent");
    if (!agent) {
      console.error("[performReview] ERROR: Code review agent not found");
      throw new Error("Code review agent not found");
    }
    console.log("[performReview] Agent found, generating review...");

    // Build the review prompt
    const fileSummary = files
      .map(
        (f) =>
          `- ${f.filename} (${f.status}): +${f.additions}/-${f.deletions}`
      )
      .join("\n");

    const prompt = `Please review this pull request:

**PR Title:** ${prTitle}
**Author:** ${prAuthor}
**URL:** ${prUrl}

**Files Changed (${files.length} files, +${totalAdditions}/-${totalDeletions} lines):**
${fileSummary}

**Diff:**
\`\`\`diff
${diff}
\`\`\`

Please analyze these changes thoroughly. Use your tools to read the full content of any files you need to understand the context. Provide a comprehensive review following your guidelines.`;

    // Generate the review
    console.log("[performReview] Calling agent.generate()...");
    console.log("[performReview] Prompt length:", prompt.length, "characters");

    let reviewContent: string;
    try {
      // Use generateLegacy for AI SDK v4 compatibility with ollama-ai-provider
      const result = await agent.generateLegacy([{ role: "user", content: prompt }]);
      console.log("[performReview] Agent generate completed, result text length:", result.text?.length || 0);
      reviewContent = result.text;
    } catch (error) {
      console.error("[performReview] ERROR during agent.generate():", error);
      throw error;
    }

    // Determine verdict based on review content
    let verdict: "approved" | "changes_requested" | "commented" = "commented";

    const lowerReview = reviewContent.toLowerCase();
    if (
      lowerReview.includes("critical issue") ||
      lowerReview.includes("security vulnerability") ||
      lowerReview.includes("must fix") ||
      lowerReview.includes("blocking")
    ) {
      verdict = "changes_requested";
    } else if (
      lowerReview.includes("looks good") ||
      lowerReview.includes("approved") ||
      lowerReview.includes("ready to merge")
    ) {
      verdict = "approved";
    }

    return {
      owner,
      repo,
      pullNumber,
      reviewContent,
      verdict,
    };
  },
});

// Helper function to extract syntax and logical errors from review
function extractIssues(reviewContent: string): { syntaxErrors: string[]; logicalErrors: string[]; criticalIssues: string[] } {
  const syntaxErrors: string[] = [];
  const logicalErrors: string[] = [];
  const criticalIssues: string[] = [];

  const lines = reviewContent.split('\n');
  let currentSection = '';

  for (const line of lines) {
    const lowerLine = line.toLowerCase();

    // Detect section headers
    if (lowerLine.includes('critical') || lowerLine.includes('syntax error') || lowerLine.includes('syntax issue')) {
      currentSection = 'critical';
    } else if (lowerLine.includes('logical') || lowerLine.includes('logic error') || lowerLine.includes('bug')) {
      currentSection = 'logical';
    } else if (lowerLine.includes('suggestion') || lowerLine.includes('improvement')) {
      currentSection = 'suggestion';
    }

    // Extract issues (lines starting with - or * that contain error keywords)
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('-') || trimmedLine.startsWith('*') || trimmedLine.match(/^\d+\./)) {
      // Check for syntax-related keywords
      if (lowerLine.includes('syntax') ||
          lowerLine.includes('undefined') ||
          lowerLine.includes('null reference') ||
          lowerLine.includes('type error') ||
          lowerLine.includes('missing ') ||
          lowerLine.includes('unexpected') ||
          lowerLine.includes('unreachable') ||
          lowerLine.includes('declaration') ||
          lowerLine.includes('import') && lowerLine.includes('error')) {
        syntaxErrors.push(trimmedLine.replace(/^[-*\d.]\s*/, ''));
      }
      // Check for logical error keywords
      else if (lowerLine.includes('logic') ||
               lowerLine.includes('bug') ||
               lowerLine.includes('incorrect') ||
               lowerLine.includes('wrong') ||
               lowerLine.includes('error') ||
               lowerLine.includes('issue') ||
               lowerLine.includes('problem') ||
               lowerLine.includes('fail') ||
               lowerLine.includes('infinite loop') ||
               lowerLine.includes('race condition') ||
               lowerLine.includes('deadlock') ||
               lowerLine.includes('memory leak') ||
               lowerLine.includes('off-by-one') ||
               lowerLine.includes('sql injection') ||
               lowerLine.includes('security')) {
        if (currentSection === 'critical') {
          criticalIssues.push(trimmedLine.replace(/^[-*\d.]\s*/, ''));
        } else {
          logicalErrors.push(trimmedLine.replace(/^[-*\d.]\s*/, ''));
        }
      }
      // Critical section items
      else if (currentSection === 'critical') {
        criticalIssues.push(trimmedLine.replace(/^[-*\d.]\s*/, ''));
      }
    }
  }

  return {
    syntaxErrors: [...new Set(syntaxErrors)].slice(0, 5),
    logicalErrors: [...new Set(logicalErrors)].slice(0, 5),
    criticalIssues: [...new Set(criticalIssues)].slice(0, 5),
  };
}

// Step 3: Post review to GitHub and send notification
const postReview = createStep({
  id: "post-review",
  description: "Post the review to GitHub PR and send Telegram notification",
  inputSchema: ReviewResultSchema,
  outputSchema: FinalResultSchema,
  execute: async ({ inputData, getInitData }) => {
    const { owner, repo, pullNumber, reviewContent, verdict } = inputData;

    console.log(`[postReview] Posting review to PR #${pullNumber} in ${owner}/${repo}`);
    console.log(`[postReview] Verdict: ${verdict}, Review length: ${reviewContent?.length || 0}`);

    // Get initial data for PR info
    const initData = getInitData() as z.infer<typeof WebhookPayloadSchema>;
    const prUrl = initData?.prUrl || "";
    const prTitle = initData?.prTitle || "";
    const repoName = `${owner}/${repo}`;

    const octokit = getOctokit();
    let reviewPosted = false;
    let notificationSent = false;
    let message = "";

    // Post review to GitHub
    console.log("[postReview] Posting review to GitHub...");
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        body: reviewContent,
        event: verdict === "approved" ? "APPROVE" : "COMMENT",
      });
      reviewPosted = true;
      message = "Review posted to GitHub";
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      message = `Failed to post review: ${errorMsg}`;
      console.error("Failed to post GitHub review:", error);
    }

    // Send Telegram notification
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;

      if (botToken && chatId) {
        // Extract issues for highlighted summary
        const issues = extractIssues(reviewContent);

        const verdictEmoji: Record<string, string> = {
          approved: "✅",
          changes_requested: "⚠️",
          commented: "💬",
        };
        const emoji = verdictEmoji[verdict] || "🔍";

        // Build focused Telegram message
        let telegramMessage = `${emoji} *Code Review Complete*

📦 *Repository:* ${repoName}
📝 *PR:* ${prTitle}
📊 *Verdict:* ${verdict.replace("_", " ").toUpperCase()}
`;

        // Add critical issues (highest priority)
        if (issues.criticalIssues.length > 0) {
          telegramMessage += `\n🔴 *CRITICAL ISSUES:*\n`;
          for (const issue of issues.criticalIssues) {
            const escapedIssue = issue.replace(/[*_`\[\]]/g, '\\$&').slice(0, 100);
            telegramMessage += `• ${escapedIssue}\n`;
          }
        }

        // Add syntax errors
        if (issues.syntaxErrors.length > 0) {
          telegramMessage += `\n🟠 *SYNTAX ERRORS:*\n`;
          for (const issue of issues.syntaxErrors) {
            const escapedIssue = issue.replace(/[*_`\[\]]/g, '\\$&').slice(0, 100);
            telegramMessage += `• ${escapedIssue}\n`;
          }
        }

        // Add logical errors
        if (issues.logicalErrors.length > 0) {
          telegramMessage += `\n🟡 *LOGICAL ERRORS:*\n`;
          for (const issue of issues.logicalErrors) {
            const escapedIssue = issue.replace(/[*_`\[\]]/g, '\\$&').slice(0, 100);
            telegramMessage += `• ${escapedIssue}\n`;
          }
        }

        // If no specific issues found, show brief summary
        if (issues.criticalIssues.length === 0 && issues.syntaxErrors.length === 0 && issues.logicalErrors.length === 0) {
          const briefSummary = reviewContent.replace(/[#*`\[\]]/g, '').slice(0, 300);
          telegramMessage += `\n📋 *Summary:*\n${briefSummary}...`;
        }

        telegramMessage += `\n\n[View Full Review](${prUrl})`;

        const response = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              chat_id: chatId,
              text: telegramMessage,
              parse_mode: "Markdown",
              disable_web_page_preview: true,
            }),
          }
        );

        const data = (await response.json()) as { ok: boolean };
        notificationSent = data.ok;
      }
    } catch (error) {
      console.error("Failed to send Telegram notification:", error);
    }

    return {
      success: reviewPosted,
      prUrl,
      reviewPosted,
      notificationSent,
      message,
    };
  },
});

// Create the workflow
export const prReviewWorkflow = createWorkflow({
  id: "pr-review-workflow",
  inputSchema: WebhookPayloadSchema,
  outputSchema: FinalResultSchema,
})
  .then(fetchPRContext)
  .then(performReview)
  .then(postReview)
  .commit();

// Export schemas for use in other modules
export { WebhookPayloadSchema, PRContextSchema, ReviewResultSchema, FinalResultSchema };

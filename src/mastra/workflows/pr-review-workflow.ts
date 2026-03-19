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
    console.log("[performReview] Calling agent.generateLegacy()...");
    console.log("[performReview] Prompt length:", prompt.length, "characters");

    let reviewContent: string;
    try {
      // Use generate() with AI SDK v5 model for full tool support
      // The agent will automatically execute tools and continue until done
      const result = await agent.generate([{ role: "user", content: prompt }], {
        maxSteps: 20, // Allow multiple steps for tool calls
      });
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

// Helper function to extract issues from review with better categorization
function extractIssues(reviewContent: string): {
  syntaxErrors: Array<{ file?: string; line?: string; message: string }>;
  criticalIssues: Array<{ file?: string; line?: string; message: string }>;
  warnings: Array<{ file?: string; line?: string; message: string }>;
  suggestions: string[];
  positiveNotes: string[];
} {
  const syntaxErrors: Array<{ file?: string; line?: string; message: string }> = [];
  const criticalIssues: Array<{ file?: string; line?: string; message: string }> = [];
  const warnings: Array<{ file?: string; line?: string; message: string }> = [];
  const suggestions: string[] = [];
  const positiveNotes: string[] = [];

  const lines = reviewContent.split('\n');
  let currentSection = '';

  // Parse file:line references
  const parseFileRef = (line: string): { file?: string; line?: string; message: string } => {
    const fileLineMatch = line.match(/\[?([^\s\]:]+):(\d+)\]?:?\s*(.+)/);
    if (fileLineMatch) {
      return {
        file: fileLineMatch[1],
        line: fileLineMatch[2],
        message: fileLineMatch[3] || line,
      };
    }
    const fileMatch = line.match(/\[?([^\s\]:]+)\]?:?\s*(.+)/);
    if (fileMatch && fileMatch[1].includes('.')) {
      return {
        file: fileMatch[1],
        message: fileMatch[2] || line,
      };
    }
    return { message: line };
  };

  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    const trimmedLine = line.trim();

    // Detect section headers
    if (lowerLine.includes('syntax error') || lowerLine.includes('syntax issue') || lowerLine.includes('blocking')) {
      currentSection = 'syntax';
    } else if (lowerLine.includes('critical issue') || lowerLine.includes('other critical')) {
      currentSection = 'critical';
    } else if (lowerLine.includes('security') || lowerLine.includes('vulnerability')) {
      currentSection = 'critical';
    } else if (lowerLine.includes('suggestion') || lowerLine.includes('improvement')) {
      currentSection = 'suggestion';
    } else if (lowerLine.includes('positive') || lowerLine.includes('good') || lowerLine.includes('nice')) {
      currentSection = 'positive';
    } else if (lowerLine.includes('warning') || lowerLine.includes('caution')) {
      currentSection = 'warning';
    }

    // Skip empty lines and headers
    if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith('```')) {
      continue;
    }

    // Extract issues from bullet points
    if (trimmedLine.startsWith('-') || trimmedLine.startsWith('*') || trimmedLine.match(/^\d+\./)) {
      const cleanMessage = trimmedLine.replace(/^[-*\d.]\s*/, '');

      if (currentSection === 'syntax') {
        syntaxErrors.push(parseFileRef(cleanMessage));
      } else if (currentSection === 'critical') {
        criticalIssues.push(parseFileRef(cleanMessage));
      } else if (currentSection === 'warning') {
        warnings.push(parseFileRef(cleanMessage));
      } else if (currentSection === 'suggestion') {
        suggestions.push(cleanMessage);
      } else if (currentSection === 'positive') {
        positiveNotes.push(cleanMessage);
      } else {
        // Auto-categorize based on keywords
        if (lowerLine.includes('syntax') || lowerLine.includes('missing ') ||
            lowerLine.includes('unexpected') || lowerLine.includes('undeclared')) {
          syntaxErrors.push(parseFileRef(cleanMessage));
        } else if (lowerLine.includes('security') || lowerLine.includes('vulnerability') ||
                   lowerLine.includes('injection') || lowerLine.includes('xss') ||
                   lowerLine.includes('critical') || lowerLine.includes('must fix')) {
          criticalIssues.push(parseFileRef(cleanMessage));
        } else if (lowerLine.includes('bug') || lowerLine.includes('error') ||
                   lowerLine.includes('incorrect') || lowerLine.includes('wrong') ||
                   lowerLine.includes('memory leak') || lowerLine.includes('crash')) {
          warnings.push(parseFileRef(cleanMessage));
        } else if (lowerLine.includes('consider') || lowerLine.includes('could') ||
                   lowerLine.includes('should') || lowerLine.includes('might')) {
          suggestions.push(cleanMessage);
        }
      }
    }
  }

  return {
    syntaxErrors: syntaxErrors.slice(0, 4),
    criticalIssues: criticalIssues.slice(0, 4),
    warnings: warnings.slice(0, 4),
    suggestions: suggestions.slice(0, 3),
    positiveNotes: positiveNotes.slice(0, 2),
  };
}

// Helper to escape HTML special characters
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Format issue with file reference
function formatIssueHtml(issue: { file?: string; line?: string; message: string }): string {
  let formatted = escapeHtml(issue.message);
  if (issue.file) {
    const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
    formatted = `<code>${escapeHtml(location)}</code> ${formatted}`;
  }
  return formatted;
}

// Build modern Telegram notification
function buildTelegramNotification(params: {
  repoName: string;
  prTitle: string;
  prUrl: string;
  prAuthor: string;
  headBranch: string;
  baseBranch: string;
  filesCount: number;
  additions: number;
  deletions: number;
  verdict: string;
  issues: ReturnType<typeof extractIssues>;
  reviewLength: number;
}): string {
  const {
    repoName,
    prTitle,
    prUrl,
    prAuthor,
    headBranch,
    baseBranch,
    filesCount,
    additions,
    deletions,
    verdict,
    issues,
  } = params;

  // Verdict styling
  const verdictConfig: Record<string, { emoji: string; label: string; color: string }> = {
    approved: { emoji: '✅', label: 'APPROVED', color: '🟢' },
    changes_requested: { emoji: '⚠️', label: 'CHANGES REQUESTED', color: '🔴' },
    commented: { emoji: '💬', label: 'REVIEWED', color: '🟡' },
  };
  const { emoji: verdictEmoji, label: verdictLabel, color: statusColor } = verdictConfig[verdict] || verdictConfig.commented;

  // Count issues
  const totalIssues = issues.syntaxErrors.length + issues.criticalIssues.length + issues.warnings.length;

  // Build message parts
  const parts: string[] = [];

  // Header
  parts.push(`<b>🤖 AI Code Review</b>`);
  parts.push(`<pre language="plain">${statusColor} ${verdictLabel}</pre>`);
  parts.push('');

  // PR Info
  parts.push(`<b>📝 Pull Request</b>`);
  parts.push(`<a href="${prUrl}">${escapeHtml(prTitle)}</a>`);
  parts.push('');

  // Meta info
  parts.push(`<b>📦 Repository:</b> <code>${escapeHtml(repoName)}</code>`);
  parts.push(`<b>👤 Author:</b> ${escapeHtml(prAuthor)}`);
  parts.push(`<b>🔀 Branch:</b> <code>${escapeHtml(headBranch)}</code> → <code>${escapeHtml(baseBranch)}</code>`);
  parts.push('');

  // Stats (using emojis for visual distinction since Telegram HTML doesn't support font colors)
  const statsLine = `<b>📊 Changes:</b> ${filesCount} files  🟢+${additions}  🔴-${deletions}`;
  parts.push(statsLine);
  parts.push('');

  // Issues section
  if (totalIssues > 0) {
    parts.push(`<b>🔍 Findings</b> (${totalIssues} issues)`);
    parts.push('<blockquote>');

    // Syntax errors (highest priority)
    if (issues.syntaxErrors.length > 0) {
      parts.push(`<b>🚨 Syntax Errors</b> <i>(blocking)</i>`);
      for (const issue of issues.syntaxErrors) {
        parts.push(`  ⛔ ${formatIssueHtml(issue)}`);
      }
      parts.push('');
    }

    // Critical issues
    if (issues.criticalIssues.length > 0) {
      parts.push(`<b>🔴 Critical Issues</b>`);
      for (const issue of issues.criticalIssues) {
        parts.push(`  🔸 ${formatIssueHtml(issue)}`);
      }
      parts.push('');
    }

    // Warnings
    if (issues.warnings.length > 0) {
      parts.push(`<b>🟡 Warnings</b>`);
      for (const issue of issues.warnings) {
        parts.push(`  ⚡ ${formatIssueHtml(issue)}`);
      }
    }

    parts.push('</blockquote>');
    parts.push('');
  }

  // Suggestions
  if (issues.suggestions.length > 0) {
    parts.push(`<b>💡 Suggestions</b>`);
    for (const suggestion of issues.suggestions.slice(0, 2)) {
      parts.push(`  • ${escapeHtml(suggestion)}`);
    }
    parts.push('');
  }

  // Positive notes
  if (issues.positiveNotes.length > 0) {
    parts.push(`<b>✨ Good Practices</b>`);
    for (const note of issues.positiveNotes) {
      parts.push(`  ✓ ${escapeHtml(note)}`);
    }
    parts.push('');
  }

  return parts.join('\n');
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
    const prAuthor = initData?.prAuthor || "Unknown";
    const headBranch = initData?.headBranch || "unknown";
    const baseBranch = initData?.baseBranch || "main";
    const repoName = `${owner}/${repo}`;

    const octokit = getOctokit();
    let reviewPosted = false;
    let notificationSent = false;
    let message = "";

    // Get PR stats for notification
    let filesCount = 0;
    let additions = 0;
    let deletions = 0;
    try {
      const prFiles = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      filesCount = prFiles.data.length;
      additions = prFiles.data.reduce((sum, f) => sum + f.additions, 0);
      deletions = prFiles.data.reduce((sum, f) => sum + f.deletions, 0);
    } catch {
      console.log("[postReview] Could not fetch PR stats");
    }

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
        // Extract issues for summary
        const issues = extractIssues(reviewContent);

        // Build modern notification
        const telegramMessage = buildTelegramNotification({
          repoName,
          prTitle,
          prUrl,
          prAuthor,
          headBranch,
          baseBranch,
          filesCount,
          additions,
          deletions,
          verdict,
          issues,
          reviewLength: reviewContent?.length || 0,
        });

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
              parse_mode: "HTML",
              disable_web_page_preview: true,
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🔍 View Full Review on GitHub",
                      url: prUrl,
                    },
                  ],
                ],
              },
            }),
          }
        );

        const data = (await response.json()) as { ok: boolean; description?: string };
        notificationSent = data.ok;
        if (!data.ok) {
          console.error("[postReview] Telegram error:", data.description);
        }
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

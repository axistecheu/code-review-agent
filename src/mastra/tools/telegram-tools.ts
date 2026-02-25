import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// Tool: Send Telegram notification
export const sendReviewNotification = createTool({
  id: "send-review-notification",
  description:
    "Send a code review summary notification to Telegram. Use this to notify about completed reviews.",
  inputSchema: z.object({
    reviewSummary: z
      .string()
      .describe("Brief summary of the code review findings"),
    prUrl: z.string().describe("URL to the pull request"),
    prTitle: z.string().describe("Title of the pull request"),
    repoName: z.string().describe("Name of the repository"),
    verdict: z
      .enum(["approved", "changes_requested", "commented"])
      .optional()
      .describe("Overall review verdict"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    messageId: z.number().optional(),
    message: z.string(),
  }),
  execute: async (inputData) => {
    const { reviewSummary, prUrl, prTitle, repoName, verdict } = inputData;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      return {
        success: false,
        message:
          "Telegram configuration missing. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables.",
      };
    }

    // Build the message
    const verdictEmoji: Record<string, string> = {
      approved: "✅",
      changes_requested: "⚠️",
      commented: "💬",
    };

    const emoji = verdict ? verdictEmoji[verdict] : "🔍";

    const message = `${emoji} *Code Review Complete*

📦 *Repository:* ${repoName}
📝 *PR:* ${prTitle}
${verdict ? `📊 *Verdict:* ${verdict.replace("_", " ").toUpperCase()}` : ""}

*Summary:*
${reviewSummary}

[View Pull Request](${prUrl})`;

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          }),
        }
      );

      const data = (await response.json()) as {
        ok: boolean;
        result?: { message_id: number };
        description?: string;
      };

      if (!data.ok) {
        return {
          success: false,
          message: `Telegram API error: ${data.description || "Unknown error"}`,
        };
      }

      return {
        success: true,
        messageId: data.result?.message_id,
        message: "Notification sent successfully",
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        message: `Failed to send notification: ${errorMessage}`,
      };
    }
  },
});

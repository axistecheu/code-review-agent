# Code Review Agent

An AI-powered code review agent built with the [Mastra](https://mastra.ai) framework. This agent reviews GitHub pull requests using a local/remote Ollama LLM, providing comprehensive code analysis with full repository context access.

## Key Features

- **Full File Context** - Unlike traditional diff-only reviews, this agent can read complete files via GitHub API to understand the broader codebase context
- **Local LLM Support** - Uses Ollama for privacy and zero API costs
- **GitHub Integration** - Automatically posts reviews as PR comments
- **Telegram Notifications** - Optional notifications for review summaries
- **Webhook Support** - Real-time triggers on PR events

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Mastra Application                           │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │   Webhook        │    │   PR Review      │    │  Notification│  │
│  │   Server         │───▶│   Workflow       │───▶│  Service     │  │
│  │   (Express)      │    │   (Mastra)       │    │  (Telegram)  │  │
│  └──────────────────┘    └──────────────────┘    └──────────────┘  │
│           │                      │                                  │
│           ▼                      ▼                                  │
│  ┌──────────────────┐    ┌──────────────────┐                      │
│  │   GitHub API     │    │   Code Review    │                      │
│  │   Tools          │    │   Agent (Ollama) │                      │
│  └──────────────────┘    └──────────────────┘                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
code-review-agent/
├── src/
│   ├── index.ts                      # Express webhook server entry point
│   └── mastra/
│       ├── index.ts                  # Mastra configuration
│       ├── agents/
│       │   └── code-review-agent.ts  # Main code review agent
│       ├── workflows/
│       │   └── pr-review-workflow.ts # 3-step PR review workflow
│       └── tools/
│           ├── index.ts              # Tool exports
│           ├── github-tools.ts       # GitHub API tools (Octokit)
│           ├── file-tools.ts         # Full file access via GitHub API
│           └── telegram-tools.ts     # Telegram notifications
├── package.json
├── tsconfig.json
└── .env.example
```

## Agents

### Code Review Agent (`code-review-agent`)

The main agent that performs comprehensive code reviews.

**Capabilities:**
- Reads complete files via GitHub API (not just diffs)
- Compares before/after versions of modified files
- Explores project structure for architectural context
- Identifies security vulnerabilities, performance issues, and code quality problems

**Review Checklist:**
- **Security**: SQL injection, XSS, CSRF, authentication issues, sensitive data exposure
- **Code Quality**: DRY principle, complexity, naming conventions, error handling
- **Performance**: N+1 queries, memory leaks, inefficient algorithms
- **Architecture**: Separation of concerns, SOLID principles, design patterns
- **Best Practices**: Documentation, commit quality, breaking changes

## Tools

### GitHub Tools (`github-tools.ts`)

| Tool | Description |
|------|-------------|
| `getPullRequestFiles` | Get list of files changed in a PR with additions/deletions |
| `getPullRequestDiff` | Get the full diff content of a PR |
| `createPullRequestReview` | Post a review comment on a PR |

### File Tools (`file-tools.ts`) - KEY IMPROVEMENT

These tools give the agent access to full file content, not just diffs:

| Tool | Description |
|------|-------------|
| `getFileContent` | Fetch complete file content from GitHub |
| `getFileAtPRHead` | Get file from the PR's head branch (new version) |
| `getFileAtBaseBranch` | Get file from base branch (old version for comparison) |
| `getDirectoryContents` | List directory contents to understand project structure |

### Telegram Tools (`telegram-tools.ts`)

| Tool | Description |
|------|-------------|
| `sendReviewNotification` | Send review summary to Telegram with verdict |

## Workflow

The PR Review Workflow (`pr-review-workflow`) has 3 steps:

1. **fetchPRContext** - Fetch PR files, diff, and metadata from GitHub
2. **performReview** - Use the code review agent to analyze the changes
3. **postReview** - Post review to GitHub and send Telegram notification

## Prerequisites

- Node.js v22.13.0 or later
- Ollama running locally or on a remote server
- GitHub Personal Access Token with `repo` scope
- (Optional) Telegram bot for notifications

## Installation

```bash
# Clone the repository
git clone https://github.com/axistecheu/code-review-agent.git
cd code-review-agent

# Install dependencies
npm install
```

## Configuration

1. Copy the example environment file:

```bash
cp .env.example .env
```

2. Configure your environment variables:

```env
# Ollama Configuration
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b

# GitHub Configuration
GITHUB_TOKEN=ghp_your_token_here
GITHUB_WEBHOOK_SECRET=your_webhook_secret

# Telegram (Optional)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Server
PORT=4111
NODE_ENV=development
```

### Getting Credentials

**GitHub Token:**
1. Go to https://github.com/settings/tokens
2. Generate new token (classic) with `repo` scope
3. Copy to `GITHUB_TOKEN`

**Ollama:**
1. Install Ollama: https://ollama.ai
2. Pull a model: `ollama pull qwen3:8b`
3. Ensure it supports tool calling (qwen3, llama3.2, etc.)

**Telegram (Optional):**
1. Create bot via [@BotFather](https://t.me/botfather)
2. Get your chat ID by messaging the bot and visiting:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`

## Running Locally

### Start the Server

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm run start
```

The server will start on port 4111 (or `PORT` from .env).

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/webhook/github` | POST | GitHub webhook endpoint |
| `/trigger-review` | POST | Manual trigger for testing |

### Testing with Manual Trigger

```bash
curl -X POST http://localhost:4111/trigger-review \
  -H "Content-Type: application/json" \
  -d '{"owner": "your-username", "repo": "your-repo", "pullNumber": 1}'
```

### Testing with Webhooks (ngrok)

For GitHub webhooks to reach your local server:

```bash
# Start ngrok
ngrok http 4111

# Add the ngrok URL to your GitHub webhook settings:
# https://your-ngrok-url.ngrok.io/webhook/github
```

**GitHub Webhook Configuration:**
- Payload URL: `https://your-ngrok-url.ngrok.io/webhook/github`
- Content type: `application/json`
- Secret: Same as `GITHUB_WEBHOOK_SECRET` in .env
- Events: Select "Pull requests"

## Deploying to Mastra Cloud

Mastra Cloud provides managed hosting for your agents.

### Setup

1. Create an account at [Mastra Cloud](https://cloud.mastra.ai)
2. Create a new project and connect your GitHub repository
3. Enable deployments in the project settings

### Configuration

1. Add your environment variables in the Mastra Cloud dashboard:
   - `OLLAMA_BASE_URL` - Your Ollama server URL
   - `OLLAMA_MODEL` - Model to use
   - `GITHUB_TOKEN` - GitHub PAT
   - `GITHUB_WEBHOOK_SECRET` - Webhook secret
   - `TELEGRAM_BOT_TOKEN` (optional)
   - `TELEGRAM_CHAT_ID` (optional)

2. Update your webhook URL in GitHub to point to your Mastra Cloud deployment

### Deployment

Pushes to your main branch trigger automatic deployments.

```bash
git push origin master
```

### Alternative Deployment Options

- **Mastra Server**: Build and deploy to any Node.js hosting
- **Vercel/Netlify**: Use built-in deployers
- **Docker**: Containerize and deploy anywhere

See [Mastra Deployment Docs](https://mastra.ai/docs/deployment/overview) for details.

## Troubleshooting

### Common Issues

**"Model not found" error:**
- Ensure the model is available in Ollama: `ollama list`
- Pull the model if needed: `ollama pull qwen3:8b`
- Verify `OLLAMA_MODEL` matches exactly

**Connection refused to Ollama:**
- Check Ollama is running: `curl http://localhost:11434/api/tags`
- For remote Ollama, ensure `OLLAMA_BASE_URL` is correct

**GitHub API errors:**
- Verify `GITHUB_TOKEN` has `repo` scope
- Check token hasn't expired

**Webhook not receiving events:**
- Verify ngrok is running (for local testing)
- Check webhook secret matches
- Ensure PR events are selected in webhook settings

### Debug Mode

The workflow includes debug logging. Check console output for:
- `[fetchPRContext]` - PR data fetching
- `[performReview]` - Agent review generation
- `[postReview]` - GitHub posting

## API Reference

### POST /trigger-review

Manually trigger a review for a PR.

**Request:**
```json
{
  "owner": "string",
  "repo": "string",
  "pullNumber": number
}
```

**Response:**
```json
{
  "message": "Review completed",
  "result": {
    "success": true,
    "prUrl": "string",
    "reviewPosted": true,
    "notificationSent": false,
    "message": "string"
  }
}
```

### POST /webhook/github

Receives GitHub webhook events. Automatically processes PR events:
- `opened`
- `synchronize`
- `reopened`

## License

MIT

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Resources

- [Mastra Documentation](https://mastra.ai/docs)
- [Ollama](https://ollama.ai)
- [GitHub Webhooks](https://docs.github.com/en/developers/webhooks-and-events/webhooks)

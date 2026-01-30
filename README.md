# Linear Claude Webhook

A webhook server that connects Linear issues to Claude Code for automated implementation. When you mention `@Claude` in a Linear comment, this server will:

1. Fetch the full context of the issue (description, comments, labels)
2. Clone the associated repository
3. Run Claude Code to implement the requested changes
4. Create a new branch and open a Pull Request
5. Comment back on Linear with the PR link and implementation details

## Quick Start

### Prerequisites

- Node.js 20+
- Git
- GitHub CLI (`gh`)
- A Linear account with API access
- An Anthropic API key
- A GitHub Personal Access Token

### Local Development

```bash
# Clone the repository
git clone https://github.com/michaeljelly/CLinear-Code.git
cd CLinear-Code

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your credentials (see Configuration section)
nano .env

# Build and run
npm run build
npm start

# Or run in development mode with hot reload
npm run dev
```

### Using Docker

```bash
# Copy environment template
cp .env.example .env
# Edit .env with your credentials

# Build and run
docker compose up --build
```

## Configuration

All configuration is done via environment variables. Copy `.env.example` to `.env` and fill in:

### Required Variables

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `LINEAR_API_KEY` | Linear API key | [Linear Settings > API](https://linear.app/settings/api) |
| `GITHUB_TOKEN` | GitHub Personal Access Token with `repo` scope | [GitHub Settings > Tokens](https://github.com/settings/tokens) |
| `ANTHROPIC_API_KEY` | Anthropic API key | [Anthropic Console](https://console.anthropic.com/) |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LINEAR_WEBHOOK_SECRET` | - | Webhook signature secret (recommended for production) |
| `GITHUB_DEFAULT_REPO` | - | Default repository if not specified in issue |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Claude model to use |
| `CLAUDE_MAX_TURNS` | `200` | Maximum API calls per task |
| `PORT` | `3000` | Server port |
| `LOG_LEVEL` | `info` | Logging level (error, warn, info, debug) |

## Setting Up Linear Webhook

1. Go to [Linear Settings > API > Webhooks](https://linear.app/settings/api)
2. Click "New Webhook"
3. Configure:
   - **URL**: `https://your-server.com/webhook/linear`
   - **Events**: Select "Comments" (create)
   - **Secret**: Generate a random secret and add it to your `.env` as `LINEAR_WEBHOOK_SECRET`
4. Save the webhook

## Usage

### Mentioning @Claude in Comments

Once deployed and connected, mention `@Claude` in any Linear issue comment:

```
@Claude Please implement a function that validates email addresses
and add unit tests for it.
```

Claude will:
1. Acknowledge the request with a comment
2. Clone the repository
3. Implement the changes
4. Create a PR
5. Comment back with the PR link

### Specifying the Repository

The webhook determines which repository to use in this order:

1. **GitHub URL in issue description**: If the issue contains `https://github.com/owner/repo`, that repo is used
2. **Label**: Add a label `repo:owner/name` to the issue
3. **Default**: Falls back to `GITHUB_DEFAULT_REPO` environment variable

## Deployment

### Deploy to Fly.io (Recommended)

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Login
fly auth login

# Launch the app
fly launch --no-deploy

# Set secrets
fly secrets set LINEAR_API_KEY=your_key
fly secrets set LINEAR_WEBHOOK_SECRET=your_secret
fly secrets set GITHUB_TOKEN=your_token
fly secrets set ANTHROPIC_API_KEY=your_key

# Deploy
fly deploy
```

Your webhook URL will be: `https://your-app.fly.dev/webhook/linear`

### Deploy to Modal

```bash
# Install Modal
pip install modal

# Create secrets
modal secret create linear-claude-webhook-secrets \
  LINEAR_API_KEY=your_key \
  LINEAR_WEBHOOK_SECRET=your_secret \
  GITHUB_TOKEN=your_token \
  ANTHROPIC_API_KEY=your_key

# Deploy
modal deploy modal_app.py
```

### Deploy with Docker (Any VPS)

```bash
# Build the image
docker build -t linear-claude-webhook .

# Run with environment variables
docker run -d \
  --name linear-claude-webhook \
  -p 3000:3000 \
  --env-file .env \
  linear-claude-webhook
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│     Linear      │────▶│  Webhook Server │────▶│   Claude Code   │
│                 │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        │                       │                       │
        ▼                       ▼                       ▼
   Comment with            Fetches issue           Implements
   @Claude mention         context, clones         changes, creates
                          repository              PR on GitHub
```

### Components

- **`src/index.ts`**: Express server with health check and webhook endpoint
- **`src/linear/webhook-handler.ts`**: Validates webhooks, detects @Claude mentions
- **`src/linear/api-client.ts`**: Fetches issue context from Linear API
- **`src/claude/executor.ts`**: Runs Claude Code CLI to implement tasks

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/webhook/linear` | POST | Linear webhook receiver |

## Development

```bash
# Run in development mode
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint

# Build for production
npm run build
```

## Troubleshooting

### Webhook not receiving events

1. Check the webhook is active in Linear Settings
2. Verify the URL is publicly accessible
3. Check server logs for incoming requests

### Claude not completing tasks

1. Verify `ANTHROPIC_API_KEY` is valid
2. Check `CLAUDE_MAX_TURNS` is sufficient
3. Review server logs for error messages

### Repository not found

1. Ensure the repository is accessible with your `GITHUB_TOKEN`
2. Add a GitHub URL to the issue description
3. Set `GITHUB_DEFAULT_REPO` in your environment

## License

MIT

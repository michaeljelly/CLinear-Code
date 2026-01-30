"""
Modal deployment for Linear Claude Webhook

Deploy with:
    modal deploy modal_app.py

Run locally:
    modal serve modal_app.py
"""

import modal
import os

# Define the container image
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "curl", "ca-certificates", "gnupg")
    # Install Node.js
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
    )
    # Install GitHub CLI
    .run_commands(
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg",
        'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
        "apt-get update && apt-get install -y gh",
    )
    # Install Claude Code CLI
    .run_commands("npm install -g @anthropic-ai/claude-code")
    # Copy and build the app
    .copy_local_dir(".", "/app", exclude=["node_modules", "dist", ".git"])
    .run_commands("cd /app && npm ci && npm run build")
)

app = modal.App("linear-claude-webhook", image=image)

# Define secrets
secrets = modal.Secret.from_name("linear-claude-webhook-secrets")


@app.function(
    secrets=[secrets],
    timeout=1800,  # 30 minutes max
    cpu=1,
    memory=1024,
)
@modal.web_endpoint(method="POST", label="webhook-linear")
def webhook_linear(request: dict):
    """Handle Linear webhook"""
    import subprocess
    import json

    # Start the Node.js server temporarily to handle the request
    # In production, you'd want to keep this running
    env = os.environ.copy()
    env["COMPUTE_PROVIDER"] = "modal"

    # For now, just acknowledge and process async
    # Full implementation would use Modal's async capabilities
    return {"status": "accepted", "message": "Processing request"}


@app.function(secrets=[secrets])
@modal.web_endpoint(method="GET", label="health")
def health():
    """Health check endpoint"""
    return {"status": "ok", "provider": "modal"}


# For running the full server (use with modal serve)
@app.local_entrypoint()
def main():
    print("Starting Linear Claude Webhook on Modal...")
    print("Webhook endpoint: /webhook-linear")
    print("Health check: /health")

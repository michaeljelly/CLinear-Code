#!/bin/bash
# =============================================================================
# Deploy to Fly.io
# =============================================================================
set -e

echo "================================================"
echo "  Deploying to Fly.io"
echo "================================================"
echo ""

# Check Fly CLI
if ! command -v fly &> /dev/null; then
    echo "Fly CLI not found. Installing..."
    curl -L https://fly.io/install.sh | sh
    export PATH="$HOME/.fly/bin:$PATH"
fi

# Check if logged in
if ! fly auth whoami &> /dev/null; then
    echo "Please log in to Fly.io:"
    fly auth login
fi

# Check if app exists
APP_NAME="linear-claude-webhook"
if ! fly apps list | grep -q "$APP_NAME"; then
    echo "Creating new Fly app..."
    fly apps create "$APP_NAME"
fi

# Check if .env exists for secrets
if [ -f .env ]; then
    echo ""
    echo "Found .env file. Setting secrets..."

    # Read each line and set as secret
    while IFS= read -r line || [ -n "$line" ]; do
        # Skip comments and empty lines
        if [[ "$line" =~ ^[[:space:]]*# ]] || [[ -z "$line" ]]; then
            continue
        fi

        # Extract key=value
        key=$(echo "$line" | cut -d'=' -f1)
        value=$(echo "$line" | cut -d'=' -f2-)

        # Skip if key is empty or starts with common non-secret vars
        if [[ -z "$key" ]] || [[ "$key" =~ ^(PORT|HOST|LOG_LEVEL|COMPUTE_PROVIDER)$ ]]; then
            continue
        fi

        echo "Setting secret: $key"
        fly secrets set "$key=$value" --app "$APP_NAME" 2>/dev/null || true
    done < .env
else
    echo ""
    echo "WARNING: No .env file found."
    echo "You'll need to set secrets manually with:"
    echo "  fly secrets set LINEAR_API_KEY=your_key"
    echo "  fly secrets set GITHUB_TOKEN=your_token"
    echo "  fly secrets set ANTHROPIC_API_KEY=your_key"
fi

echo ""
echo "Deploying..."
fly deploy --app "$APP_NAME"

echo ""
echo "================================================"
echo "  Deployment Complete!"
echo "================================================"
echo ""
echo "Your webhook URL is:"
echo "  https://$APP_NAME.fly.dev/webhook/linear"
echo ""
echo "Add this URL to your Linear webhook settings."
echo ""

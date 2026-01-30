#!/bin/bash
# =============================================================================
# Linear Claude Webhook - Setup Script
# =============================================================================
set -e

echo "================================================"
echo "  Linear Claude Webhook - Setup"
echo "================================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed."
    echo "Please install Node.js 20+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "ERROR: Node.js 20+ is required. Found: $(node -v)"
    exit 1
fi
echo "✓ Node.js $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "ERROR: npm is not installed."
    exit 1
fi
echo "✓ npm $(npm -v)"

# Check git
if ! command -v git &> /dev/null; then
    echo "ERROR: git is not installed."
    exit 1
fi
echo "✓ git $(git --version | cut -d' ' -f3)"

# Check GitHub CLI
if ! command -v gh &> /dev/null; then
    echo "WARNING: GitHub CLI (gh) is not installed."
    echo "Install from: https://cli.github.com/"
else
    echo "✓ gh $(gh --version | head -n1 | cut -d' ' -f3)"
fi

echo ""
echo "Installing dependencies..."
npm install

echo ""
echo "Building TypeScript..."
npm run build

echo ""
echo "================================================"
echo "  Setup Complete!"
echo "================================================"
echo ""
echo "Next steps:"
echo "1. Copy .env.example to .env"
echo "2. Fill in your API keys and secrets"
echo "3. Run 'npm start' to start the server"
echo ""
echo "For development, use 'npm run dev' for hot reload."
echo ""

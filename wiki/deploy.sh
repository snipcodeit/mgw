#!/usr/bin/env bash
# Deploy MGW wiki pages to the GitHub wiki repository.
#
# Prerequisites:
#   1. The wiki must be initialized on GitHub (create one page via the web UI first)
#   2. You must have push access to the repository
#
# Usage:
#   cd wiki/
#   bash deploy.sh
#
# This script clones the wiki repo, copies all .md files, commits, and pushes.

set -euo pipefail

WIKI_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_URL="https://github.com/snipcodeit/mgw.wiki.git"
TEMP_DIR=$(mktemp -d)

echo "Cloning wiki repository..."
if ! git clone "$REPO_URL" "$TEMP_DIR" 2>/dev/null; then
    echo ""
    echo "ERROR: Could not clone the wiki repository."
    echo ""
    echo "The wiki must be initialized first. To do this:"
    echo "  1. Go to https://github.com/snipcodeit/mgw/wiki"
    echo "  2. Click 'Create the first page'"
    echo "  3. Save any content (it will be overwritten)"
    echo "  4. Re-run this script"
    echo ""
    rm -rf "$TEMP_DIR"
    exit 1
fi

echo "Copying wiki pages..."
# Remove existing content (except .git)
find "$TEMP_DIR" -maxdepth 1 -not -name '.git' -not -name '.' -delete 2>/dev/null || true

# Copy all .md files (excluding this deploy script's README if any)
for f in "$WIKI_DIR"/*.md; do
    [ -f "$f" ] && cp "$f" "$TEMP_DIR/"
done

cd "$TEMP_DIR"

echo "Committing changes..."
git add -A
if git diff --cached --quiet; then
    echo "No changes to commit. Wiki is up to date."
else
    git commit -m "docs: update MGW wiki with full documentation"
    echo "Pushing to wiki..."
    git push origin master || git push origin main
    echo ""
    echo "Wiki deployed successfully!"
    echo "View at: https://github.com/snipcodeit/mgw/wiki"
fi

# Cleanup
rm -rf "$TEMP_DIR"

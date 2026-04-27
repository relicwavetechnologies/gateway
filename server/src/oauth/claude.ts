import fs from 'fs';
import path from 'path';

const HOMES_DIR = process.env.CLAUDE_HOMES_DIR ?? '/var/gateway/accounts';

export function saveCredentialBlob(accountId: string, blob: string | object): string {
    const homeDir = path.join(HOMES_DIR, accountId);
    const claudeDir = path.join(homeDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    const creds = typeof blob === 'string' ? JSON.parse(blob) : blob;
    fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify(creds, null, 2));
    return homeDir;
}

export function getHomeDir(accountId: string): string {
    return path.join(HOMES_DIR, accountId);
}

export function credentialsExist(accountId: string): boolean {
    return fs.existsSync(path.join(HOMES_DIR, accountId, '.claude', '.credentials.json'));
}

export function removeCredentials(accountId: string): void {
    const homeDir = path.join(HOMES_DIR, accountId);
    if (fs.existsSync(homeDir)) fs.rmSync(homeDir, { recursive: true, force: true });
}

export function getExtractionScript(): string {
    return `#!/usr/bin/env bash
# Run this on a machine with Claude Desktop installed and logged in.
# Paste the output back into the gateway UI.

set -e

CREDS_FILE="$HOME/.claude/.credentials.json"

if [ -f "$CREDS_FILE" ]; then
  cat "$CREDS_FILE"
elif command -v security &>/dev/null; then
  RAW=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
  if [ -n "$RAW" ]; then
    echo "$RAW"
  else
    echo "ERROR: No Claude credentials found. Make sure Claude Code is installed and you are logged in." >&2
    exit 1
  fi
else
  echo "ERROR: No credentials file found at $CREDS_FILE" >&2
  exit 1
fi`;
}

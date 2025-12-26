#!/bin/bash
# Sync Claude Code OAuth credentials between macOS Keychain and local file
#
# Usage: ./sync-credentials.sh [output-file]
#
# Logic:
#   - Compare expiry times between Keychain and local file
#   - Use whichever has the newer (longer-lived) token
#   - Sync the winner back to both locations
#
# Default output: ./.claude-code-credentials.json

set -euo pipefail

OUTPUT_FILE="${1:-./.claude-code-credentials.json}"
SERVICE="Claude Code-credentials"
ACCOUNT="${USER}"

get_expiry() {
  echo "$1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('claudeAiOauth',{}).get('expiresAt',0))" 2>/dev/null || echo "0"
}

format_expiry() {
  local exp_ms="$1"
  if [ "$exp_ms" != "0" ] && [ "$exp_ms" != "unknown" ]; then
    local exp_secs=$((exp_ms / 1000))
    date -r "$exp_secs" 2>/dev/null || date -d "@$exp_secs" 2>/dev/null || echo "unknown"
  else
    echo "unknown"
  fi
}

# Try to get credentials from Keychain
KEYCHAIN_CREDS=""
KEYCHAIN_EXPIRY=0
if KEYCHAIN_CREDS=$(security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w 2>/dev/null); then
  if echo "$KEYCHAIN_CREDS" | python3 -m json.tool > /dev/null 2>&1; then
    KEYCHAIN_EXPIRY=$(get_expiry "$KEYCHAIN_CREDS")
    echo "[sync-credentials] Keychain token expires: $(format_expiry "$KEYCHAIN_EXPIRY")"
  else
    echo "[sync-credentials] Keychain data is not valid JSON, ignoring"
    KEYCHAIN_CREDS=""
  fi
else
  echo "[sync-credentials] No credentials in Keychain"
fi

# Try to get credentials from local file
LOCAL_CREDS=""
LOCAL_EXPIRY=0
if [ -f "$OUTPUT_FILE" ]; then
  if LOCAL_CREDS=$(cat "$OUTPUT_FILE") && echo "$LOCAL_CREDS" | python3 -m json.tool > /dev/null 2>&1; then
    LOCAL_EXPIRY=$(get_expiry "$LOCAL_CREDS")
    echo "[sync-credentials] Local file token expires: $(format_expiry "$LOCAL_EXPIRY")"
  else
    echo "[sync-credentials] Local file is not valid JSON, ignoring"
    LOCAL_CREDS=""
  fi
fi

# Decide which to use (prefer the one with later expiry)
if [ "$KEYCHAIN_EXPIRY" -gt "$LOCAL_EXPIRY" ]; then
  echo "[sync-credentials] Using Keychain credentials (newer)"
  BEST_CREDS="$KEYCHAIN_CREDS"
  BEST_EXPIRY="$KEYCHAIN_EXPIRY"
  # Write to local file
  echo "$BEST_CREDS" > "$OUTPUT_FILE"
  chmod 600 "$OUTPUT_FILE"
  echo "[sync-credentials] Credentials written to: $OUTPUT_FILE"
elif [ "$LOCAL_EXPIRY" -gt "$KEYCHAIN_EXPIRY" ]; then
  echo "[sync-credentials] Using local file credentials (newer)"
  BEST_CREDS="$LOCAL_CREDS"
  BEST_EXPIRY="$LOCAL_EXPIRY"
  # Update Keychain with the newer token
  if [ -n "$BEST_CREDS" ]; then
    security delete-generic-password -s "$SERVICE" -a "$ACCOUNT" 2>/dev/null || true
    security add-generic-password -s "$SERVICE" -a "$ACCOUNT" -w "$BEST_CREDS" 2>/dev/null && \
      echo "[sync-credentials] Updated Keychain with newer token" || \
      echo "[sync-credentials] Warning: Could not update Keychain"
  fi
elif [ -n "$KEYCHAIN_CREDS" ]; then
  echo "[sync-credentials] Tokens have same expiry, using Keychain"
  BEST_CREDS="$KEYCHAIN_CREDS"
  BEST_EXPIRY="$KEYCHAIN_EXPIRY"
  echo "$BEST_CREDS" > "$OUTPUT_FILE"
  chmod 600 "$OUTPUT_FILE"
elif [ -n "$LOCAL_CREDS" ]; then
  echo "[sync-credentials] Only local file has credentials"
  BEST_CREDS="$LOCAL_CREDS"
  BEST_EXPIRY="$LOCAL_EXPIRY"
else
  echo "[sync-credentials] ERROR: No valid credentials found in Keychain or local file." >&2
  echo "[sync-credentials] Please run: claude /login" >&2
  exit 1
fi

echo "[sync-credentials] Token expires: $(format_expiry "$BEST_EXPIRY")"


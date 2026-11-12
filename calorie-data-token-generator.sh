#!/usr/bin/env bash
# calorie-data-token-generator.sh
# Opens GitHub's token page pre-filled for a fine-grained token (Contents: read/write),
# then optionally verifies the token you paste. The token is never written to disk.
# GitHub does not allow creating fine-grained tokens via API, so the final click is yours.
set -euo pipefail

read -r -p "GitHub username: " OWNER
read -r -p "Data repo name [calorie-data]: " REPO
REPO="${REPO:-calorie-data}"
read -r -p "Expiration in days (1-366) [90]: " DAYS
DAYS="${DAYS:-90}"
[[ "$DAYS" =~ ^[0-9]+$ ]] && (( DAYS >= 1 && DAYS <= 366 )) || { echo "Invalid days."; exit 1; }

URL="https://github.com/settings/personal-access-tokens/new?name=calorie-data-app&description=Read+and+write+daily+calorie+logs&target_name=${OWNER}&expires_in=${DAYS}&contents=write"

cat <<EOF

On the GitHub page that opens:
  1. Under "Repository access" choose "Only select repositories" and select: ${OWNER}/${REPO}
  2. Confirm the only permission is Contents: Read and write (Metadata: read is automatic).
  3. Click "Generate token" and copy it.

EOF

if command -v open >/dev/null 2>&1; then open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
else echo "Open this URL manually:"; echo "$URL"; fi

read -r -s -p "Paste the token to verify it (or press Enter to skip): " TOKEN; echo
[[ -z "$TOKEN" ]] && { echo "Skipped verification. Paste the token into the app's Settings screen."; exit 0; }

code() { curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$1"; }

R=$(code "https://api.github.com/repos/${OWNER}/${REPO}")
[[ "$R" == "200" ]] || { echo "FAIL: cannot access ${OWNER}/${REPO} (HTTP $R). Check repo selection."; exit 1; }
echo "OK: token can access ${OWNER}/${REPO}"

PRIV=$(curl -s -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/${OWNER}/${REPO}" | grep -o '"private": *[a-z]*' | head -1 || true)
echo "Repo visibility check -> ${PRIV:-unknown} (should be true)"

OTHER=$(curl -s -H "Authorization: Bearer $TOKEN" "https://api.github.com/user/repos?per_page=100&affiliation=owner" | grep -c '"full_name"' || true)
echo "Repos visible to token via listing: ${OTHER} (ideally 1)"
echo "Done. Paste the token into the app's Settings. It was not saved anywhere."

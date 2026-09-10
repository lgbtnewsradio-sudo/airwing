#!/usr/bin/env bash
# Creates (or reuses) a GitHub release for the current package.json version and uploads
# the installer + portable zip from release/. Uses the token stored in the git credential
# helper for github.com (or GH_TOKEN if set).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${REPO:-lgbtnewsradio-sudo/airwing}"
VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
TOKEN="${GH_TOKEN:-$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | grep '^password=' | cut -d= -f2-)}"
API="https://api.github.com/repos/${REPO}"
AUTH=(-H "Authorization: token ${TOKEN}" -H "Accept: application/vnd.github+json")

NOTES_FILE="${NOTES_FILE:-RELEASE_NOTES.md}"
if [ -f "$NOTES_FILE" ]; then
  BODY="$(node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync(process.argv[1],'utf8')))" "$NOTES_FILE")"
else
  BODY="\"AirWing ${VERSION}\""
fi

RELEASE_JSON="$(curl -s "${AUTH[@]}" "${API}/releases/tags/${TAG}" || true)"
RELEASE_ID="$(node -e "try{const j=JSON.parse(process.argv[1]);process.stdout.write(String(j.id||''))}catch{}" "$RELEASE_JSON")"
if [ -z "$RELEASE_ID" ]; then
  RELEASE_JSON="$(curl -s "${AUTH[@]}" "${API}/releases" -d "{\"tag_name\":\"${TAG}\",\"name\":\"AirWing ${VERSION}\",\"body\":${BODY},\"draft\":false,\"prerelease\":false}")"
  RELEASE_ID="$(node -e "const j=JSON.parse(process.argv[1]);if(!j.id){console.error(j);process.exit(1)}process.stdout.write(String(j.id))" "$RELEASE_JSON")"
  echo "created release ${TAG} (id ${RELEASE_ID})"
else
  echo "reusing release ${TAG} (id ${RELEASE_ID})"
fi

for f in release/AirWing-${VERSION}-win-x64.exe release/AirWing-${VERSION}-win-x64.exe.blockmap release/AirWing-${VERSION}-win-x64.zip; do
  [ -f "$f" ] || { echo "missing $f"; continue; }
  NAME="$(basename "$f")"
  echo "uploading ${NAME} ($(du -h "$f" | cut -f1))"
  CODE="$(curl -s -o /tmp/upload.json -w '%{http_code}' "${AUTH[@]}" -H "Content-Type: application/octet-stream" --data-binary @"$f" "https://uploads.github.com/repos/${REPO}/releases/${RELEASE_ID}/assets?name=${NAME}")"
  if [ "$CODE" != "201" ]; then
    echo "  upload returned ${CODE}: $(head -c 300 /tmp/upload.json)"
  else
    echo "  ok"
  fi
done
echo "https://github.com/${REPO}/releases/tag/${TAG}"

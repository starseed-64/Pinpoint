#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE_DIR="$PROJECT_ROOT/feedback-capture"
ARTIFACTS_DIR="$CAPTURE_DIR/artifacts"
SIGNING_NOTICE="$ARTIFACTS_DIR/.pinpoint-signing-opened"
INSTALL_CONFIRMED="$ARTIFACTS_DIR/.pinpoint-install-confirmed"
INBOX_URL="http://127.0.0.1:4321/"
HEALTH_URL="${INBOX_URL}api/feedback?health=1"
AMO_URL="https://addons.mozilla.org/developers/addon/submit/distribution/"
OPEN_BROWSER_PID=""
SERVER_ENTRY="$CAPTURE_DIR/dist/server/entry.mjs"

if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' \
    "Double-click this file to prepare Pinpoint and start Pinbox." \
    "The first run installs dependencies and packages the Firefox add-on." \
    "Mozilla signing is required once for a persistent Firefox installation."
  exit 0
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' "Pinpoint requires Node.js 22.23.4 or newer and npm 9.6.5 or newer. Opening the Node.js download page."
  open "https://nodejs.org/"
  exit 1
fi
if ! node -e 'const { execFileSync } = require("node:child_process"); const meets = (actual, minimum) => { const version = actual.trim().split(".").map(Number); for (let i = 0; i < 3; i++) { if (version[i] !== minimum[i]) return version[i] > minimum[i]; } return true; }; process.exit(meets(process.versions.node, [22, 23, 4]) && meets(execFileSync("npm", ["--version"], { encoding: "utf8" }), [9, 6, 5]) ? 0 : 1);'; then
  printf '%s\n' "Your runtime is too old. Pinpoint requires Node.js 22.23.4 or newer and npm 9.6.5 or newer."
  open "https://nodejs.org/"
  exit 1
fi

cd "$PROJECT_ROOT"
PROJECT_ID="$(cd "$CAPTURE_DIR" && node -e 'const { createHash } = require("node:crypto"); const { resolve } = require("node:path"); console.log(createHash("sha256").update(resolve(process.env.FEEDBACK_PROJECT_ROOT ?? resolve(process.cwd(), ".."), "Pinbox")).digest("hex"));')"

inbox_matches_project() {
  curl --silent --fail --max-time 2 "$HEALTH_URL" | node -e '
    let body = "";
    process.stdin.on("data", chunk => body += chunk);
    process.stdin.on("end", () => {
      try {
        const health = JSON.parse(body);
        process.exitCode = health?.app === "Pinbox" && health.projectId === process.argv[1] ? 0 : 1;
      } catch {
        process.exitCode = 1;
      }
    });
  ' "$PROJECT_ID"
}

EXTENSION_VERSION="$(node -p "require(process.argv[1]).version" "$CAPTURE_DIR/extension/manifest.json")"
PACKAGE_ZIP="$ARTIFACTS_DIR/Pinpoint_v$EXTENSION_VERSION.zip"
SIGNED_XPI="$ARTIFACTS_DIR/Pinpoint_v$EXTENSION_VERSION.xpi"
mkdir -p "$PROJECT_ROOT/Pinbox" "$ARTIFACTS_DIR"

if [[ ! -x "$CAPTURE_DIR/node_modules/.bin/astro" || ! -x "$CAPTURE_DIR/node_modules/.bin/web-ext" ]]; then
  printf '\n%s\n' "Installing Pinbox dependencies..."
  npm --prefix "$CAPTURE_DIR" ci
fi

package_needed=0
if [[ ! -f "$PACKAGE_ZIP" ]]; then
  package_needed=1
elif find "$CAPTURE_DIR/extension" -type f -newer "$PACKAGE_ZIP" -print -quit | grep -q .; then
  package_needed=1
fi

if [[ "$package_needed" == "1" ]]; then
  printf '\n%s\n' "Preparing the Firefox add-on package..."
  npm --prefix "$CAPTURE_DIR" run package:firefox
else
  npm --prefix "$CAPTURE_DIR" run name:firefox
fi

signed_version=""
if [[ -f "$SIGNED_XPI" ]]; then
  if ! signed_version="$(unzip -p "$SIGNED_XPI" manifest.json | node -e 'let json = ""; process.stdin.on("data", chunk => json += chunk); process.stdin.on("end", () => { try { console.log(JSON.parse(json).version); } catch (error) { console.error("Could not read the signed add-on manifest.", error.message); process.exitCode = 1; } });')"; then
    printf '%s\n' "The signed add-on package could not be read. Replace it with a newly signed XPI."
  fi
fi
if [[ "$signed_version" != "$EXTENSION_VERSION" ]]; then
  printf '\n%s\n' \
    "Firefox signing required for Pinpoint $EXTENSION_VERSION (the existing signed package is missing or outdated):" \
    "Upload this ZIP as an unlisted add-on through Mozilla Add-ons:" \
    "$PACKAGE_ZIP" \
    "Save the signed XPI as:" \
    "$SIGNED_XPI" \
    "Mozilla signing needs a developer account, but no Mac admin rights."
  if [[ ! -f "$SIGNING_NOTICE" ]] || [[ "$(cat "$SIGNING_NOTICE")" != "$EXTENSION_VERSION" ]]; then
    open -a Firefox "$AMO_URL" || open "$AMO_URL"
    open -R "$PACKAGE_ZIP"
    printf '%s\n' "$EXTENSION_VERSION" > "$SIGNING_NOTICE"
  fi
elif [[ ! -f "$INSTALL_CONFIRMED" ]] || [[ "$(cat "$INSTALL_CONFIRMED")" != "$EXTENSION_VERSION" ]]; then
  printf '\n%s\n' \
    "Install the signed Pinpoint add-on in Firefox:" \
    "Drag the revealed XPI into Firefox's Add-ons Manager, or use its gear menu > Install Add-on From File..."
  open -a Firefox "about:addons" || printf '%s\n' "Open Firefox's Add-ons Manager manually to install the XPI."
  open -R "$SIGNED_XPI"
  read -r -p "After Firefox confirms installation, press Return. Type skip to defer: " install_choice
  if [[ "$install_choice" != "skip" ]]; then
    printf '%s\n' "$EXTENSION_VERSION" > "$INSTALL_CONFIRMED"
  fi
fi

if inbox_matches_project; then
  printf '\n%s\n' "Pinbox is already running for this project. Opening the existing inbox."
  open -a Firefox "$INBOX_URL" || open "$INBOX_URL"
  exit 0
elif curl --silent --max-time 2 "$INBOX_URL" >/dev/null 2>&1; then
  printf '\n%s\n' \
    "Port 4321 is responding, but it is not a verified Pinbox for this project." \
    "Stop the existing service before launching this project's Pinbox." \
    "If it is an older Pinbox without a project health check, stop it and relaunch it with the updated kit."
  exit 1
fi

if [[ ! -f "$SERVER_ENTRY" ]] || find "$CAPTURE_DIR/src" "$CAPTURE_DIR/extension/pinpoint-icon.png" "$CAPTURE_DIR/extension/pinpoint-logo-dark.png" "$CAPTURE_DIR/extension/pinpoint-logo-light.png" "$CAPTURE_DIR/astro.config.mjs" "$CAPTURE_DIR/tsconfig.json" "$CAPTURE_DIR/package.json" "$CAPTURE_DIR/package-lock.json" "$CAPTURE_DIR/scripts/start.mjs" -type f -newer "$SERVER_ENTRY" -print -quit | grep -q .; then
  printf '\n%s\n' "Building the production Pinbox inbox..."
  npm --prefix "$CAPTURE_DIR" run build
fi

cleanup() {
  if [[ -n "$OPEN_BROWSER_PID" ]]; then
    kill "$OPEN_BROWSER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

(
  for ((attempt = 0; attempt < 30; attempt++)); do
    if inbox_matches_project; then
      open -a Firefox "$INBOX_URL" || open "$INBOX_URL"
      exit 0
    fi
    sleep 1
  done
  printf '%s\n' "Pinbox did not become ready. Check this Terminal window for startup errors."
  exit 1
) &
OPEN_BROWSER_PID=$!

printf '\n%s\n' "Starting Pinbox. Keep this Terminal window open while you use it." \
  "Press Ctrl+C here when you are finished."
PORT=4321 npm --prefix "$CAPTURE_DIR" start

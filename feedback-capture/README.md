# Pinpoint Runtime

The standalone kit setup and reuse instructions are in the [Pinpoint README](../README.md). This folder contains the local Pinbox application and Firefox extension.

## Double-click Launcher (macOS)

Double-click `../Pinpoint.command` from the kit root. It installs locked dependencies if needed, creates or refreshes the Pinpoint Firefox package, builds Pinbox when sources change, and starts its production server in Firefox. Node.js 22.23.4 or newer and npm 9.6.5 or newer are required. Keep the Terminal window it opens running while you use Pinpoint; press **Ctrl+C** there to stop the server.

The launcher checks `/api/feedback?health=1` before reusing an inbox and before opening a newly started one. The response identifies Pinbox and includes a SHA-256 identifier of the resolved feedback folder, not its raw path. This is a project-matching check, not authentication. `FEEDBACK_PROJECT_ROOT` is included in that identity; relative values resolve from `feedback-capture/`. A different project, unrelated HTTP service, or older Pinbox without the health response on port 4321 causes the launcher to stop with instructions rather than open the wrong inbox. Stop that service yourself and relaunch the desired kit. The launcher always starts on port 4321 to match the extension, even if `PORT` is set in its environment.

The current release is `artifacts/Pinpoint_v1.1.3.zip`. It does not yet have a Mozilla-signed XPI, so submit the ZIP as an unlisted add-on before installing the updated extension persistently. The older signed packages are historical releases; renaming their files does not change their internal branding.

When the signed XPI is missing or its version is outdated, the launcher opens the Mozilla Add-ons developer page and reveals the current package ZIP. Submit it as an unlisted add-on, download the signed XPI into `feedback-capture/artifacts/`, then run `Pinpoint.command` again. The launcher reads the downloaded XPI's manifest and names it `Pinpoint_v<version>.xpi` without changing its bytes or signature. It opens Firefox's Add-ons Manager and reveals the XPI for the current release; drag the XPI into Firefox or install it using the gear menu. This persistent installation survives Firefox restarts. Each changed extension release needs a manifest version increment, new Mozilla signing, and installation; this does not require Mac admin rights. The bundled old signed XPI retains its actual version and is not the current Pinpoint release.

## Use Pinpoint

1. From the project root, install dependencies once, then start Pinbox whenever you use Pinpoint. Keep the server running:

```bash
npm --prefix feedback-capture ci
npm --prefix feedback-capture run build
npm --prefix feedback-capture start
```

2. Package the Firefox add-on:

```bash
npm --prefix feedback-capture run package:firefox
```

This creates `feedback-capture/artifacts/Pinpoint_v<version>.zip`, with `<version>` read directly from `extension/manifest.json` (currently `Pinpoint_v1.1.3.zip`). The launcher uses the same filename automatically. Each manifest version gets its own ZIP; rebuilding that version updates only its matching ZIP.

Returned signed packages use `Pinpoint_v<version>.xpi`, with the version read from the XPI itself. Packaging and the launcher name downloaded XPIs automatically; to name them without building or starting the inbox, run `npm --prefix feedback-capture run name:firefox`. Conflicting signed packages with the same version are reported instead of overwritten.

3. For a permanent install in regular Firefox, submit that ZIP as an **unlisted** add-on at <https://addons.mozilla.org/developers/> and download the signed XPI. Mozilla signing is required for each release; the developer account is a one-time setup, not a macOS admin install.

4. In Firefox 140 or newer, open `about:addons`, open the gear menu, and choose **Install Add-on From File…**. Select the signed XPI. Pin Pinpoint to the toolbar if desired. This installation persists across Firefox restarts. Open Pinpoint's **Preferences** from its add-on details to grant Pinbox access, view the Mac and Windows shortcut defaults, see your active shortcut, change it in Firefox, and open Pinbox.

5. Open the website you want to report. Press the shortcut shown by Pinpoint to start selecting immediately, or click the Pinpoint toolbar icon and choose **Select Element**. Change the shortcut in Firefox's **Manage Extension Shortcuts** settings if needed.

6. Click the target element to select it without activating it, describe the desired change, and choose **Save to Pinbox**. Repeat for each report. Press Escape while selecting to cancel.

7. Review saved bugs in Pinbox at <http://127.0.0.1:4321/>. Returning focus to Pinbox refreshes the list. The Markdown files are in `Pinbox/` at the project root; multiline descriptions and blank lines are retained.

8. When ready, choose **Fix Everything** and paste `/Pinpoint` into the AI Agent chat. The `/pinpoint` skill treats it as the handoff trigger, asks about ambiguities, runs focused checks, and deletes only notes whose fixes pass. The extension cannot start or submit work to an existing Copilot conversation by itself.

Install dependencies once per project with `npm --prefix feedback-capture ci`. The inbox is local to your machine at `127.0.0.1:4321`. Use `npm --prefix feedback-capture run dev` for development with live reload.

Run `npm --prefix feedback-capture test`, `npm --prefix feedback-capture run check`, and `npm --prefix feedback-capture run lint:firefox` before rebuilding a changed release. Packaging uses the locked `web-ext` version rather than downloading the latest tool on each run.

## Browser Regression Tests

Install Playwright's dedicated Firefox browser once after installing npm dependencies:

```bash
npm --prefix feedback-capture exec -- playwright install firefox
npm --prefix feedback-capture run test:browser
```

The separate browser command builds the inbox, then runs Node's test runner against headless Firefox on an ephemeral loopback port with temporary report storage. It covers selection without triggering page handlers or native link/form navigation, saving after an explicit failure, and inbox focus-event refresh, multiline rendering, and removal. Test contexts, server connections, and report folders are closed or removed after the run; your normal inbox and Firefox profile are not used.

The tests load the unchanged capture and background scripts with mocked WebExtension messaging and permission APIs. The fixed collector URL is mapped to the isolated test server, and the harness retains a reference to the closed shadow root without opening it. Headless Firefox does not emit native window-focus events when switching Playwright pages, so the inbox test dispatches a focus event to verify the handler and ensuing real API refresh. These tests do not cover OS-level focus transitions, actual toolbar injection, permission prompts, extension shortcuts, signing, or add-on installation. `npm test` remains the fast, browser-free suite.

## Reuse In Another Project

Copy the `feedback-capture/` folder and `Pinpoint.command` into the target project's root. Copy `feedback-capture/skills/pinpoint/SKILL.md` to `.github/skills/pinpoint/SKILL.md`. Run the launcher there to install dependencies and start the inbox. Reports are written to `Pinbox/` next to the launcher. Add `/Pinbox/` to the target project's `.gitignore` if notes should stay local. To save notes somewhere else, set `FEEDBACK_PROJECT_ROOT` to the target project directory before starting the server.

The `/pinpoint` Copilot skill can be installed in the user profile to work across projects. It processes notes as a batch, asks about ambiguous items before editing, and follows the current project's conventions.

The portable skill is bundled at `feedback-capture/skills/pinpoint/SKILL.md` and installs to `.github/skills/pinpoint/SKILL.md`. It documents the compact note schema, conditional page context, ambiguity handling, and privacy boundaries.

The collector binds only to `127.0.0.1:4321`; the extension posts feedback only to that local address.

The feedback API accepts JSON bodies up to 16,000 UTF-8 bytes, including metadata, and descriptions up to 5,000 characters. It counts streamed body bytes independently of `Content-Length` and returns HTTP 413 when the byte limit is exceeded, without saving a note.

Targets retain the selected element's `data-testid` when available. Otherwise they preserve the nearest ancestor test ID and complete relative selector, or the full captured selector, with accessible labels added without losing ancestor or positional context.

Page-metadata rewrites use same-directory temporary files and atomic replacement for existing notes and the page index, preserving access permissions and cleaning up temporary files on handled failures. Rewrites run sequentially within the inbox queue so a failed operation cannot leave background rewrites running after the queue advances. This is per-file atomicity, not a transaction or a guarantee against power loss. A failed synchronization can leave a newly saved note and some updated metadata behind; the API returns an explicit error, and the next successful inbox mutation resynchronizes page context.
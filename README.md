<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="_Logos/Logo_Pinbox_white.png">
    <img src="_Logos/Logo_Pinbox_dark.png" alt="Pinbox" width="360">
  </picture>
</p>

# Pinpoint

Pinpoint is a standalone Firefox extension, local Pinbox inbox, and Copilot skill for selecting a web page element and handing its requested fix to a coding agent. Page content and reports stay on your machine.

## Requirements

- Firefox 140 or newer
- Node.js 22.23.4 or newer and npm 9.6.5 or newer
- macOS for the double-click launcher; the inbox commands also work on other platforms

## Run Pinpoint

Install the inbox dependencies once:

```sh
npm --prefix feedback-capture ci
```

Double-click `Pinpoint.command` to build the local Pinbox when needed, start its production server, and open it in Firefox. The launcher reuses a running inbox only when its project health check matches the requested feedback folder. If port 4321 belongs to another service, another project, or an older Pinbox without the health check, stop that service and relaunch; the launcher will not open an unverified inbox or stop another process for you. Keep the Terminal window open while using the inbox. Alternatively, build and start the inbox directly:

```sh
npm --prefix feedback-capture run build
npm --prefix feedback-capture start
```

For development with live reload, use `npm --prefix feedback-capture run dev`.

The Firefox extension is in `feedback-capture/extension/`. Its ZIP is generated as `feedback-capture/artifacts/Pinpoint_v<version>.zip`, using the version embedded in its manifest (currently `Pinpoint_v1.1.3.zip`). The launcher selects that same versioned filename. Submit the ZIP for Mozilla signing before installing it persistently in Firefox.

```sh
npm --prefix feedback-capture run package:firefox
```

Firefox requires Mozilla signing for a persistent installation. Submit the generated ZIP to Mozilla Add-ons as an unlisted add-on and save the returned XPI in `feedback-capture/artifacts/`. Run `npm --prefix feedback-capture run name:firefox` (or the launcher) to name it `Pinpoint_v<version>.xpi` using the signed archive's own manifest, then install it from Firefox's Add-ons Manager. For this release, the ZIP is `Pinpoint_v1.1.3.zip`; a returned signed XPI is named `Pinpoint_v1.1.3.xpi`. Naming preserves the XPI's bytes and signature; it does not sign a package or replace a different signed release. Older signed builds are retained as historical artifacts and are not the current release. The launcher detects missing or outdated signed versions and asks you to install each new version.

Pinbox refreshes when its window regains focus. Multiline descriptions are preserved. Feedback requests are limited to 16,000 UTF-8 bytes, including JSON metadata, and descriptions to 5,000 characters. Oversized bodies are rejected even without an accurate `Content-Length` header. Listing or counting reports never rewrites files; saving and removing reports synchronize page metadata.

## Validate Changes

```sh
npm --prefix feedback-capture test
npm --prefix feedback-capture run check
npm --prefix feedback-capture run lint:firefox
npm --prefix feedback-capture run build
```

For repeatable browser interaction checks, install the dedicated test browser once and run the separate Firefox suite:

```sh
npm --prefix feedback-capture exec -- playwright install firefox
npm --prefix feedback-capture run test:browser
```

Browser tests use isolated report storage and an ephemeral local port, not your regular Pinbox or Firefox profile. Extension messaging and permissions are mocked; toolbar installation and real permission prompts remain outside this suite.

## Add Pinpoint To A Copilot Project

Copy `Pinpoint.command` and the `feedback-capture/` folder into the target project's root. Copy `feedback-capture/skills/pinpoint/SKILL.md` to `.github/skills/pinpoint/SKILL.md` in that project. Then install dependencies and run the launcher from the project root.

Bug reports are written to `Pinbox/` in the folder containing `Pinpoint.command`. Add `/Pinbox/` to the project's `.gitignore` if reports should remain local. The `/pinpoint` skill handles the `/Pinpoint` handoff command copied from the inbox and processes those notes with explicit per-note choices.

The extension sends reports only to the local inbox at `127.0.0.1:4321`; it does not connect to a remote service or submit work into a Copilot conversation. Use **Fix Everything** in Pinbox to copy `/Pinpoint`, then paste it into the AI Agent chat.
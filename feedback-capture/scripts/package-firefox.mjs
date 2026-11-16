import { rename } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { cmd } from "web-ext";

const { extensionPath } = await cmd.build({
  sourceDir: resolve("extension"),
  artifactsDir: resolve("artifacts"),
  filename: "Pinpoint_v{version}.zip",
  // The full-size icon is only a design master; the manifest uses the 48/96 px versions.
  ignoreFiles: ["pinpoint-icon.png"],
  overwriteDest: true,
}, { showReadyMessage: false });

// web-ext lowercases filenames; restore the requested release prefix.
const filename = basename(extensionPath).replace(/^pinpoint_v/, "Pinpoint_v");
const outputPath = resolve(dirname(extensionPath), filename);
await rename(extensionPath, outputPath);
console.log(`Your web extension is ready: ${outputPath}`);
await import("./name-firefox-xpi.mjs");

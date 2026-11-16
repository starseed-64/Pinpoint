import { copyFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import JSZip from "jszip";

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const version = manifest.version;
const filename = `Pinpoint_v${version}.xpi`;
const source = resolve("artifacts", filename);
const releasesDirectory = resolve("..", "releases");

const bytes = await readFile(source).catch(() => {
  throw new Error(`Missing ${source}. Sign Pinpoint_v${version}.zip at Mozilla, save the XPI in artifacts/, and run "npm run name:firefox" first.`);
});
const archive = await JSZip.loadAsync(bytes);
if (!archive.file("META-INF/mozilla.rsa")) throw new Error(`${filename} is not Mozilla-signed.`);
const signedManifest = JSON.parse(await archive.file("manifest.json").async("string"));
if (signedManifest.version !== version) throw new Error(`${filename} contains version ${signedManifest.version}, expected ${version}.`);

await mkdir(releasesDirectory, { recursive: true });
await copyFile(source, resolve(releasesDirectory, filename));
const git = (...args) => execFileSync("git", args, { cwd: resolve(".."), encoding: "utf8" }).trim();
git("add", `releases/${filename}`);
git("commit", "-m", `Release Pinpoint v${version}`, "-m", "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>");
git("tag", "-a", `v${version}`, "-m", `Pinpoint v${version}`);
console.log(`Committed releases/${filename} and tagged v${version}. Publish with: git push origin main --follow-tags`);

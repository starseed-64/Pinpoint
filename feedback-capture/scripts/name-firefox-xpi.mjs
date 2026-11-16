import { link, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";

const artifactsDirectory = resolve("artifacts");
const sourceManifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const expectedId = sourceManifest.browser_specific_settings?.gecko?.id;
if (typeof expectedId !== "string" || !expectedId) throw new Error("Pinpoint's manifest is missing its Firefox add-on ID.");
await mkdir(artifactsDirectory, { recursive: true });
const entries = await readdir(artifactsDirectory, { withFileTypes: true });

for (const entry of entries.filter((entry) => entry.isFile() && /\.xpi$/i.test(entry.name))) {
  const sourcePath = resolve(artifactsDirectory, entry.name);
  const bytes = await readFile(sourcePath);
  const archive = await JSZip.loadAsync(bytes);
  const manifestEntry = archive.file("manifest.json");
  if (!manifestEntry) throw new Error(`${entry.name} does not contain a manifest.`);
  const manifest = JSON.parse(await manifestEntry.async("string"));
  if (manifest.browser_specific_settings?.gecko?.id !== expectedId) throw new Error(`${entry.name} belongs to a different Firefox add-on.`);
  if (typeof manifest.version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
    throw new Error(`${entry.name} has an invalid release version.`);
  }
  const filename = `Pinpoint_v${manifest.version}.xpi`;
  if (entry.name === filename) continue;
  const destinationPath = resolve(artifactsDirectory, filename);

  try {
    // A hard link reserves the new name without overwriting another signed release.
    await link(sourcePath, destinationPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const [sourceStat, destinationStat] = await Promise.all([stat(sourcePath), stat(destinationPath)]);
    if (sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino) {
      await rename(sourcePath, destinationPath);
      console.log(`Signed package: ${filename}`);
      continue;
    }
    if (!(await readFile(destinationPath)).equals(bytes)) {
      throw new Error(`Cannot rename ${entry.name}: ${filename} already contains a different package.`, { cause: error });
    }
  }
  await unlink(sourcePath);
  console.log(`Signed package: ${filename}`);
}

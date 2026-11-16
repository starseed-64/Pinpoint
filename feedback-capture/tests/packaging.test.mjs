import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";

const run = promisify(exec);

test("packaging follows manifest version changes and preserves older release ZIPs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinpoint-packaging-test-"));
  try {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true,
      scripts: { "package:firefox": packageJson.scripts["package:firefox"] },
    }));
    await mkdir(join(root, "scripts"));
    await copyFile(new URL("../scripts/package-firefox.mjs", import.meta.url), join(root, "scripts", "package-firefox.mjs"));
    await copyFile(new URL("../scripts/name-firefox-xpi.mjs", import.meta.url), join(root, "scripts", "name-firefox-xpi.mjs"));
    await symlink(fileURLToPath(new URL("../node_modules/", import.meta.url)), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await cp(new URL("../extension/", import.meta.url), join(root, "extension"), { recursive: true });
    const manifestPath = join(root, "extension", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const originalVersion = manifest.version;
    const nextVersion = originalVersion.split(".");
    nextVersion[nextVersion.length - 1] = String(Number(nextVersion.at(-1)) + 1);
    const versions = [originalVersion, nextVersion.join(".")];
    for (const version of versions) {
      manifest.version = version;
      await writeFile(manifestPath, JSON.stringify(manifest));
      await run("npm run package:firefox", { cwd: root });
      const filenames = await readdir(join(root, "artifacts"));
      assert(filenames.includes(`Pinpoint_v${version}.zip`));
      const archive = await JSZip.loadAsync(await readFile(join(root, "artifacts", `Pinpoint_v${version}.zip`)));
      assert.equal(JSON.parse(await archive.file("manifest.json").async("string")).version, version);
      assert(!filenames.includes("pinpoint-web-ui-feedback.zip"));
    }
    assert.deepEqual((await readdir(join(root, "artifacts"))).sort(), versions.map((version) => `Pinpoint_v${version}.zip`).sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("XPI naming uses the signed manifest and preserves bytes without overwriting a conflicting release", async () => {
  const root = await mkdtemp(join(tmpdir(), "pinpoint-xpi-test-"));
  try {
    await mkdir(join(root, "extension"));
    await mkdir(join(root, "artifacts"));
    await mkdir(join(root, "scripts"));
    const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
    await writeFile(join(root, "extension", "manifest.json"), JSON.stringify(manifest));
    await copyFile(new URL("../scripts/name-firefox-xpi.mjs", import.meta.url), join(root, "scripts", "name-firefox-xpi.mjs"));
    await symlink(fileURLToPath(new URL("../node_modules/", import.meta.url)), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const archive = new JSZip();
    archive.file("manifest.json", JSON.stringify({ ...manifest, version: "1.0.0" }));
    archive.file("META-INF/test-signature", "unchanged bytes");
    const bytes = await archive.generateAsync({ type: "nodebuffer" });
    const source = join(root, "artifacts", "downloaded-addon.xpi");
    const destination = join(root, "artifacts", "Pinpoint_v1.0.0.xpi");
    await writeFile(source, bytes);
    const name = () => promisify(execFile)(process.execPath, ["scripts/name-firefox-xpi.mjs"], { cwd: root });
    await name();
    assert((await readFile(destination)).equals(bytes));
    assert.deepEqual(await readdir(join(root, "artifacts")), ["Pinpoint_v1.0.0.xpi"]);
    await writeFile(source, bytes);
    await name();
    assert.deepEqual(await readdir(join(root, "artifacts")), ["Pinpoint_v1.0.0.xpi"]);
    archive.file("META-INF/test-signature", "different bytes");
    const conflicting = await archive.generateAsync({ type: "nodebuffer" });
    await writeFile(source, conflicting);
    await assert.rejects(name(), (error) => error.stderr.includes("already contains a different package"));
    assert((await readFile(destination)).equals(bytes));
    assert((await readFile(source)).equals(conflicting));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function launcherFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pinpoint-launcher-test-")));
  try {
    const capture = join(root, "feedback-capture");
    const bin = join(root, "bin");
    const tools = join(capture, "node_modules", ".bin");
    await mkdir(join(capture, "extension"), { recursive: true });
    await mkdir(join(capture, "artifacts"));
    await mkdir(tools, { recursive: true });
    await mkdir(bin);
    await copyFile(new URL("../../Pinpoint.command", import.meta.url), join(root, "Pinpoint.command"));
    const version = "1.0.10";
    await writeFile(join(capture, "extension", "manifest.json"), JSON.stringify({ version }));
    const zip = join(capture, "artifacts", `Pinpoint_v${version}.zip`);
    await writeFile(zip, "test package");
    for (const name of ["astro", "web-ext"]) await writeFile(join(tools, name), "", { mode: 0o755 });
    await writeFile(join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PINPOINT_TEST_LOG"\nif [ "$1" = "--version" ]; then printf "9.6.5\\n"; fi\n', { mode: 0o755 });
    await writeFile(join(bin, "open"), '#!/bin/sh\nprintf "open %s\\n" "$*" >> "$PINPOINT_TEST_LOG"\n', { mode: 0o755 });
    await writeFile(join(bin, "curl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(join(bin, "sleep"), "#!/bin/sh\nexec /bin/sleep 0.05\n", { mode: 0o755 });
    const log = join(root, "commands.log");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PINPOINT_TEST_LOG: log };
    delete env.FEEDBACK_PROJECT_ROOT;
    const launch = (overrides = {}) => promisify(execFile)("bash", [join(root, "Pinpoint.command")], {
      env: { ...env, ...overrides },
      timeout: 10_000,
    });
    return { root, bin, zip, log, launch };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("the launcher selects the manifest-versioned ZIP and builds without a signed extension", { skip: process.platform === "win32" }, async () => {
  const { root, zip, log, launch } = await launcherFixture();
  try {
    const { stdout } = await launch();
    assert(stdout.includes(zip));
    const commands = await readFile(log, "utf8");
    assert(commands.includes("run build"));
    assert(commands.includes("start"));
    assert(!commands.includes("run package:firefox"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the launcher reuses only the requested project's Pinbox", { skip: process.platform === "win32" }, async (t) => {
  const cases = [
    { name: "matching project", matches: true },
    { name: "matching relative feedback-root override", matches: true, feedbackRoot: "reports" },
    { name: "another project's Pinbox", matches: false },
    { name: "an unrelated HTTP service", matches: false, health: "<html>Not Pinbox</html>" },
    { name: "an older Pinbox without health support", matches: false, health: "" },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { root, bin, log, launch } = await launcherFixture();
      try {
        const inbox = resolve(root, "feedback-capture", scenario.feedbackRoot ?? "..", "Pinbox");
        const health = scenario.health ?? JSON.stringify({
          app: "Pinbox",
          projectId: createHash("sha256").update(scenario.matches ? inbox : `${inbox}-other`).digest("hex"),
        });
        await writeFile(join(bin, "curl"), `#!/bin/sh
case "$*" in
  *"/api/feedback?health=1"*)
    if [ -z "$PINPOINT_TEST_HEALTH" ]; then exit 22; fi
    printf '%s\\n' "$PINPOINT_TEST_HEALTH"
    ;;
esac
exit 0
`, { mode: 0o755 });
        const env = { PINPOINT_TEST_HEALTH: health };
        if (scenario.feedbackRoot) env.FEEDBACK_PROJECT_ROOT = scenario.feedbackRoot;
        if (scenario.matches) {
          const { stdout } = await launch(env);
          assert.match(stdout, /already running for this project/);
        } else {
          await assert.rejects(launch(env), (error) => {
            assert.equal(error.code, 1);
            assert.match(error.stdout, /Stop the existing service/);
            return true;
          });
        }
        const commands = await readFile(log, "utf8");
        assert.equal(commands.includes("open -a Firefox http://127.0.0.1:4321/"), scenario.matches);
        assert(!commands.includes("run build"));
        assert(!commands.includes(" start"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("the launcher waits for project health before opening and uses the extension's fixed port", { skip: process.platform === "win32" }, async () => {
  const { root, bin, log, launch } = await launcherFixture();
  try {
    const started = join(root, "started");
    const opened = join(root, "opened");
    const health = JSON.stringify({ app: "Pinbox", projectId: createHash("sha256").update(join(root, "Pinbox")).digest("hex") });
    await writeFile(join(bin, "npm"), `#!/bin/sh
printf '%s\\n' "$*" >> "$PINPOINT_TEST_LOG"
if [ "$1" = "--version" ]; then printf '9.6.5\\n'; fi
if [ "$3" = "start" ]; then
  printf '%s\\n' "$PORT" > "$PINPOINT_TEST_STARTED"
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if [ -f "$PINPOINT_TEST_OPENED" ]; then exit 0; fi
    /bin/sleep 0.1
  done
  exit 1
fi
`, { mode: 0o755 });
    await writeFile(join(bin, "curl"), `#!/bin/sh
if [ ! -f "$PINPOINT_TEST_STARTED" ]; then exit 7; fi
case "$*" in
  *"/api/feedback?health=1"*) printf '%s\\n' "$PINPOINT_TEST_HEALTH" ;;
  *) exit 22 ;;
esac
`, { mode: 0o755 });
    await writeFile(join(bin, "open"), `#!/bin/sh
printf "open %s\\n" "$*" >> "$PINPOINT_TEST_LOG"
case "$*" in
  *"http://127.0.0.1:4321/"*) printf 'opened\\n' > "$PINPOINT_TEST_OPENED" ;;
esac
`, { mode: 0o755 });
    await launch({ PORT: "9876", PINPOINT_TEST_STARTED: started, PINPOINT_TEST_OPENED: opened, PINPOINT_TEST_HEALTH: health });
    assert.equal(await readFile(started, "utf8"), "4321\n");
    assert.equal(await readFile(opened, "utf8"), "opened\n");
    assert((await readFile(log, "utf8")).includes("run build"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

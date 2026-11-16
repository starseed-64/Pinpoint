import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { after, beforeEach, test } from "node:test";
import { chmod, mkdtemp, open, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = await mkdtemp(join(tmpdir(), "pinpoint-api-test-"));
process.env.FEEDBACK_PROJECT_ROOT = projectRoot;
const { GET, POST, DELETE } = await import("../src/pages/api/feedback.ts");
const inbox = join(projectRoot, "Pinbox");
const indexPath = join(inbox, ".pinbox-pages.json");
after(() => rm(projectRoot, { recursive: true, force: true }));
beforeEach(async () => {
  const response = await DELETE({ request: new Request("http://127.0.0.1/api/feedback?all=1", { method: "DELETE" }) });
  assert.equal(response.status, 200);
});

async function save(url, comment = "Fix this button", element = { tag: "button", selector: "#save" }) {
  const response = await POST({
    request: new Request("http://127.0.0.1/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: { url }, element, comment }),
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).name;
}

function feedbackBody(bytes, comment = "Fix this button") {
  const payload = { page: { url: "https://example.com/a" }, element: { tag: "button", selector: "#save" }, comment, padding: "" };
  payload.padding = " ".repeat(bytes - Buffer.byteLength(JSON.stringify(payload)));
  return JSON.stringify(payload);
}

test("feedback accepts exactly 16,000 bytes and rejects larger bodies regardless of Content-Length", async () => {
  const accepted = await POST({
    request: new Request("http://127.0.0.1/api/feedback", { method: "POST", body: feedbackBody(16_000) }),
  });
  assert.equal(accepted.status, 201);
  const before = await readdir(inbox);
  for (const headers of [{}, { "Content-Length": "1" }]) {
    const response = await POST({
      request: new Request("http://127.0.0.1/api/feedback", { method: "POST", headers, body: feedbackBody(16_001) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "Feedback is too large." });
  }
  assert.deepEqual(await readdir(inbox), before);
});

test("the streamed byte limit cancels oversized input before reading the rest or parsing JSON", async () => {
  let cancelled = false;
  let reads = 0;
  const body = new ReadableStream({
    pull(controller) {
      reads++;
      if (reads === 1) controller.enqueue(new Uint8Array(8_000));
      else if (reads === 2) controller.enqueue(new Uint8Array(8_001));
      else throw new Error("The oversized request should have been cancelled.");
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = await POST({
    request: new Request("http://127.0.0.1/api/feedback", { method: "POST", body, duplex: "half" }),
  });
  assert.equal(response.status, 413);
  assert(cancelled);
  assert.equal(reads, 2);
  assert.deepEqual(await (await GET({ request: new Request("http://127.0.0.1/api/feedback?count=1") })).json(), { count: 0 });
});

test("streamed UTF-8 feedback retains split characters and the limit counts bytes, not characters", async () => {
  const comment = "\u{1F41B} needs fixing";
  const bytes = Buffer.from(feedbackBody(16_000, comment));
  const split = bytes.indexOf(Buffer.from("\u{1F41B}")) + 2;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, split));
      controller.enqueue(bytes.subarray(split));
      controller.close();
    },
  });
  const accepted = await POST({
    request: new Request("http://127.0.0.1/api/feedback", { method: "POST", body, duplex: "half" }),
  });
  assert.equal(accepted.status, 201);
  const { name } = await accepted.json();
  assert.equal(await readFile(join(inbox, name), "utf8"), `**Target:** #save\n**Fix:** ${comment}\n`);
  const oversized = feedbackBody(16_001, comment);
  assert(oversized.length < 16_000);
  const rejected = await POST({
    request: new Request("http://127.0.0.1/api/feedback", { method: "POST", body: oversized }),
  });
  assert.equal(rejected.status, 413);
});

test("health identifies the feedback root without creating the inbox", async () => {
  await rm(inbox, { recursive: true, force: true });
  const response = await GET({ request: new Request("http://127.0.0.1/api/feedback?health=1") });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { app: "Pinbox", projectId: createHash("sha256").update(inbox).digest("hex") });
  await assert.rejects(stat(inbox), { code: "ENOENT" });
});

test("targets retain identifying ancestors, positional context, and escaped test IDs", async () => {
  const cases = [
    {
      selector: "#billing > div > div:nth-of-type(2) > button:nth-of-type(1)",
      attributes: {},
      target: "#billing > div > div:nth-of-type(2) > button:nth-of-type(1)",
    },
    {
      selector: "#billing > div > button:nth-of-type(2)",
      attributes: { "aria-label": "Save" },
      target: '#billing > div > button:nth-of-type(2)[aria-label="Save"]',
    },
    {
      selector: String.raw`section[data-testid="outer"] > div[data-testid="card\"\\details"] > div > button:nth-of-type(2)`,
      attributes: { "aria-label": "Save" },
      target: String.raw`[data-testid="card\"\\details"] > div > button:nth-of-type(2)[aria-label="Save"]`,
    },
    {
      selector: '#billing > button[data-testid="save"]',
      attributes: { "data-testid": "save", "aria-label": "Save" },
      target: '[data-testid="save"]',
    },
  ];
  for (const { selector, attributes, target } of cases) {
    const name = await save("https://example.com/a", "Fix this button", { tag: "button", selector, attributes });
    assert.equal(await readFile(join(inbox, name), "utf8"), `**Target:** ${target}\n**Fix:** Fix this button\n`);
  }
});

test("legacy notes retain their captured ancestor when compacted without rewriting the original", async () => {
  const name = await save("https://example.com/a");
  const legacy = "Page: https://example.com/a\nElement: button\nSelector: `#billing > div > div > button`\n## Requested changes\nFix this button\n";
  await writeFile(join(inbox, name), legacy);
  const response = await GET({ request: new Request("http://127.0.0.1/api/feedback") });
  assert.deepEqual(await response.json(), {
    items: [{ name, content: "**Target:** #billing > div > div > button\n**Fix:** Fix this button\n" }],
  });
  assert.equal(await readFile(join(inbox, name), "utf8"), legacy);
});

test("metadata rewrites replace a complete note atomically and preserve its access permissions", async () => {
  const name = await save("https://example.com/a", "First line\n\nSecond line");
  const path = join(inbox, name);
  const original = await readFile(path, "utf8");
  await chmod(path, 0o600);
  const permissions = (await stat(path)).mode & 0o777;
  const handle = await open(path, "r");
  try {
    await save("https://example.com/b");
    assert.equal(await handle.readFile("utf8"), original);
    assert.equal(await readFile(path, "utf8"), `Page: https://example.com/a\n${original}`);
    assert.equal((await stat(path)).mode & 0o777, permissions);
    assert(!(await readdir(inbox)).some((filename) => filename.endsWith(".tmp")));
  } finally {
    await handle.close();
  }
});

test("failed note rewrites preserve the original, clean up partial files, and allow a retry", async (t) => {
  const name = await save("https://example.com/a", "First line\n\nSecond line");
  const path = join(inbox, name);
  const original = await readFile(path, "utf8");
  const originalWriteFile = fs.writeFile;
  const errors = [];
  try {
    t.mock.method(fs, "writeFile", async (destination, content, options) => {
      if (destination === path || (typeof destination === "string" && destination.startsWith(`${path}.`))) {
        await originalWriteFile(destination, "Partial write", options);
        throw Object.assign(new Error("Simulated disk-full failure."), { code: "ENOSPC" });
      }
      return originalWriteFile(destination, content, options);
    });
    syncBuiltinESMExports();
    t.mock.method(console, "error", (...args) => errors.push(args));
    const response = await POST({
      request: new Request("http://127.0.0.1/api/feedback", {
        method: "POST",
        body: JSON.stringify({ page: { url: "https://example.com/b" }, element: { tag: "button", selector: "#save" }, comment: "Fix this button" }),
      }),
    });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /Could not access/);
    assert.equal(errors.length, 1);
    assert.equal(await readFile(path, "utf8"), original);
    assert(!(await readdir(inbox)).some((filename) => filename.endsWith(".tmp")));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  await save("https://example.com/b");
  assert.equal(await readFile(path, "utf8"), `Page: https://example.com/a\n${original}`);
});

test("multiline descriptions retain blank lines, Markdown, and context-like labels", async () => {
  const comment = "First line\n\n\nPage: keep this instruction\nText: keep this too\n- Last line";
  const name = await save("https://example.com/a?private=1#details", comment);
  const expected = `**Target:** #save\n**Fix:** ${comment}\n`;
  assert.equal(await readFile(join(inbox, name), "utf8"), expected);
  await save("https://example.com/b");
  assert.equal(await readFile(join(inbox, name), "utf8"), `Page: https://example.com/a\n${expected}`);
});

test("concurrent saves retain every route and normalize page identity", async () => {
  const names = await Promise.all([
    save("https://example.com/a/?query=1"),
    save("https://example.com/b#section"),
    save("https://example.com/a?query=2"),
  ]);
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  assert.deepEqual(names.map((name) => index[name]), ["https://example.com/a", "https://example.com/b", "https://example.com/a"]);
  for (const name of names) assert((await readFile(join(inbox, name), "utf8")).startsWith(`Page: ${index[name]}\n`));
  assert(!(await readdir(inbox)).some((name) => name.endsWith(".tmp")));
});

test("count and listing do not rewrite notes or metadata; externally deleted notes disappear", async () => {
  const first = await save("https://example.com/a");
  const second = await save("https://example.com/b");
  await unlink(join(inbox, second));
  const paths = [join(inbox, first), indexPath];
  const before = await Promise.all(paths.map(async (path) => ({ content: await readFile(path, "utf8"), mtime: (await stat(path)).mtimeMs })));
  const count = await GET({ request: new Request("http://127.0.0.1/api/feedback?count=1") });
  assert.deepEqual(await count.json(), { count: 1 });
  const response = await GET({ request: new Request("http://127.0.0.1/api/feedback") });
  const { items } = await response.json();
  assert.equal(items.length, 1);
  assert(!items[0].content.startsWith("Page:"));
  const afterRead = await Promise.all(paths.map(async (path) => ({ content: await readFile(path, "utf8"), mtime: (await stat(path)).mtimeMs })));
  assert.deepEqual(afterRead, before);
});

test("deleting the other page removes redundant page context without truncating the remaining fix", async () => {
  const first = await save("https://example.com/a", "First\nSecond");
  const second = await save("https://example.com/b");
  const response = await DELETE({ request: new Request(`http://127.0.0.1/api/feedback?name=${second}`, { method: "DELETE" }) });
  assert.equal(response.status, 204);
  assert.equal(await readFile(join(inbox, first), "utf8"), "**Target:** #save\n**Fix:** First\nSecond\n");
});

test("a corrupt index produces an explicit error without rewriting notes; the queue recovers", async () => {
  const name = await save("https://example.com/a");
  const original = await readFile(join(inbox, name), "utf8");
  await writeFile(indexPath, "{broken");
  const count = await GET({ request: new Request("http://127.0.0.1/api/feedback?count=1") });
  assert.deepEqual(await count.json(), { count: 1 });
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const response = await GET({ request: new Request("http://127.0.0.1/api/feedback") });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /Could not access/);
    assert.equal(errors.length, 1);
    assert.equal(await readFile(join(inbox, name), "utf8"), original);
  } finally {
    console.error = originalError;
  }
  await writeFile(indexPath, JSON.stringify({ [name]: "https://example.com/a" }));
  assert.equal((await GET({ request: new Request("http://127.0.0.1/api/feedback") })).status, 200);
});

test("reading an empty inbox does not create its directory", async () => {
  await rm(inbox, { recursive: true, force: true });
  const response = await GET({ request: new Request("http://127.0.0.1/api/feedback") });
  assert.deepEqual(await response.json(), { items: [] });
  const count = await GET({ request: new Request("http://127.0.0.1/api/feedback?count=1") });
  assert.deepEqual(await count.json(), { count: 0 });
  await assert.rejects(stat(inbox), { code: "ENOENT" });
});

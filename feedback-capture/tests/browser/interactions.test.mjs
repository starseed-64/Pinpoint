import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { firefox } from "playwright";

const fixture = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Capture fixture</title></head>
  <body>
    <form action="/activated"><button id="submit" data-testid="submit" type="submit">Submit</button></form>
    <a id="link" href="/activated">Follow link</a>
    <script>
      window.activationEvents = [];
      for (const element of document.querySelectorAll("button, a")) {
        for (const name of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          element.addEventListener(name, () => window.activationEvents.push(name));
        }
      }
    </script>
  </body>
</html>`;

let projectRoot;
let server;
let browser;
let baseUrl;

before(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "pinpoint-browser-test-"));
  process.env.FEEDBACK_PROJECT_ROOT = projectRoot;
  process.env.ASTRO_NODE_AUTOSTART = "disabled";
  const { handler } = await import("../../dist/server/entry.mjs");
  server = createServer((request, response) => {
    const pathname = request.url?.split("?")[0];
    if (pathname === "/capture-fixture" || pathname === "/activated") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(pathname === "/capture-fixture" ? fixture : "<h1>Activated</h1>");
    } else {
      handler(request, response);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await firefox.launch({ headless: true });
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
    }
  }
});

beforeEach(async () => {
  const response = await fetch(`${baseUrl}/api/feedback?all=1`, { method: "DELETE" });
  assert.equal(response.status, 200);
});

async function newPage(t) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, []);
  });
  return page;
}

async function capturePage(t) {
  const page = await newPage(t);
  await page.goto(`${baseUrl}/capture-fixture`);
  await page.evaluate((collectorUrl) => {
    const listeners = new Set();
    window.captureMessages = [];
    window.browser = {
      permissions: { contains: async () => true },
      commands: { onCommand: { addListener() {} } },
      runtime: {
        onMessage: {
          addListener: (listener) => listeners.add(listener),
          removeListener: (listener) => listeners.delete(listener),
        },
        sendMessage: async (message) => {
          window.captureMessages.push(message);
          for (const listener of listeners) {
            const result = await listener(message);
            if (result !== undefined) return result;
          }
          throw new Error("No extension message handler responded.");
        },
      },
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => nativeFetch(
      input === "http://127.0.0.1:4321/api/feedback" ? collectorUrl : input,
      init,
    );
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = attachShadow.call(this, init);
      // Retain the closed root for interaction without changing its mode.
      if (this.id === "__pinpoint-capture-host") window.captureShadow = root;
      return root;
    };
  }, `${baseUrl}/api/feedback`);
  for (const filename of ["background.js", "content.js"]) {
    await page.addScriptTag({ path: fileURLToPath(new URL(`../../extension/${filename}`, import.meta.url)) });
  }
  return page;
}

async function captureControl(page, selector) {
  const handle = await page.evaluateHandle((selector) => window.captureShadow.querySelector(selector), selector);
  const element = handle.asElement();
  assert(element, `Missing capture control: ${selector}`);
  return element;
}

test("selection suppresses page gestures and native navigation; cancelling restores normal clicks", async (t) => {
  for (const selector of ["#submit", "#link"]) {
    const page = await capturePage(t);
    await page.locator(selector).click();
    const note = await captureControl(page, "textarea");
    await note.waitForElementState("visible");
    assert.equal(page.url(), `${baseUrl}/capture-fixture`);
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, "activationEvents")), []);
    const cancel = await captureControl(page, ".cancel");
    await cancel.click();
    await page.locator("#__pinpoint-capture-host").waitFor({ state: "detached" });
    await Promise.all([
      page.waitForURL(/\/activated(?:\?|$)/),
      page.locator(selector).click(),
    ]);
  }
});

test("save failures retain the description and allow a retry that saves one complete report", async (t) => {
  const page = await capturePage(t);
  let attempts = 0;
  await page.route(`${baseUrl}/api/feedback`, async (route) => {
    attempts++;
    if (attempts === 1) {
      await route.fulfill({ status: 500, json: { error: "Simulated Pinbox save failure." } });
    } else {
      await route.continue();
    }
  });
  await page.locator("#submit").click();
  const comment = "First line\n\nSecond line";
  const note = await captureControl(page, "textarea");
  const save = await captureControl(page, ".save");
  await note.fill(comment);
  await save.click();
  await page.waitForFunction(() => window.captureShadow.querySelector(".notice").textContent === "Simulated Pinbox save failure.");
  assert.equal(await note.inputValue(), comment);
  assert.equal(await save.isEnabled(), true);
  const count = await fetch(`${baseUrl}/api/feedback?count=1`);
  assert.deepEqual(await count.json(), { count: 0 });
  await save.click();
  await page.locator("#__pinpoint-capture-host").waitFor({ state: "detached" });
  assert.equal(attempts, 2);
  const inbox = join(projectRoot, "Pinbox");
  const notes = (await readdir(inbox)).filter((name) => name.endsWith(".md"));
  assert.equal(notes.length, 1);
  assert.equal(await readFile(join(inbox, notes[0]), "utf8"), `**Target:** [data-testid="submit"]\n**Fix:** ${comment}\n`);
});

test("the inbox reacts to focus events, preserves multiline text, and removes the report from disk", async (t) => {
  const page = await newPage(t);
  await page.addInitScript(() => {
    window.copiedBrief = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => { window.copiedBrief = text; } },
    });
  });
  await page.goto(baseUrl);
  await page.getByText("No fixes yet", { exact: true }).waitFor();
  assert.equal(await page.locator("#item-count").textContent(), "0 Fixes");
  assert.equal(await page.locator("#copy-brief").textContent(), "Fix Everything");
  assert.equal(await page.locator(".empty-state > span:last-child").textContent(), "Use Pinpoint to select an element and describe the fix.");
  const logo = page.locator(".brand-logo");
  const darkLogo = page.locator(".brandline source");
  assert.equal(await logo.getAttribute("alt"), "Pinbox");
  assert.notEqual(await logo.getAttribute("src"), await darkLogo.getAttribute("srcset"));
  assert.equal(await logo.evaluate((image) => Math.round(image.getBoundingClientRect().width)), 220);
  assert.equal(await page.locator("#page-title").evaluate((heading) => getComputedStyle(heading).fontWeight), "500");
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(await logo.evaluate((image) => image.currentSrc), await darkLogo.evaluate((source) => new URL(source.srcset, document.baseURI).href));
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(await logo.evaluate((image) => image.currentSrc), await logo.evaluate((image) => image.src));
  assert.equal(await page.locator("footer").evaluate((footer) => getComputedStyle(footer).color), "rgb(255, 255, 255)");
  assert.equal(await page.locator("footer code").evaluate((code) => getComputedStyle(code).color), "rgb(255, 79, 104)");
  assert.equal(await page.locator("#copy-brief").evaluate((button) => {
    const list = document.querySelector("#feedback-list");
    return button.parentElement?.classList.contains("bottom-actions")
      && Boolean(list && (list.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING));
  }), true);
  const comment = "First line\n\nSecond line";
  const response = await fetch(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page: { url: "https://example.com/checkout" }, element: { tag: "button", selector: "#checkout" }, comment }),
  });
  assert.equal(response.status, 201);
  const { name } = await response.json();
  await Promise.all([
    page.waitForResponse((response) => response.url() === `${baseUrl}/api/feedback` && response.request().method() === "GET"),
    page.evaluate(() => window.dispatchEvent(new Event("focus"))),
  ]);
  await page.locator(".feedback-item").waitFor();
  assert.equal(await page.locator(".feedback-item pre").textContent(), `Target: #checkout\nFix: ${comment}`);
  assert.equal(await page.locator(".fix-detail").evaluate((detail) => getComputedStyle(detail).color), "rgb(255, 79, 104)");
  assert.equal(await page.locator("#item-count").textContent(), "1 Fix");
  await page.locator("#copy-brief").click();
  await page.getByText("/Pinpoint command copied.", { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.copiedBrief), "/Pinpoint");
  const [clearBox, fixAllBox] = await Promise.all([
    page.locator("#clear-inbox").boundingBox(),
    page.locator("#copy-brief").boundingBox(),
  ]);
  assert(clearBox.x < fixAllBox.x);
  await page.getByRole("button", { name: `Remove ${name}`, exact: true }).click();
  await page.getByText("No fixes yet", { exact: true }).waitFor();
  assert.equal(await page.locator("#item-count").textContent(), "0 Fixes");
  await assert.rejects(stat(join(projectRoot, "Pinbox", name)), { code: "ENOENT" });
});

test("the extension popup has three actions, red Pinbox change count, and a copy-paste notification", async (t) => {
  const page = await newPage(t);
  const popupHtml = await readFile(new URL("../../extension/popup.html", import.meta.url), "utf8");
  const popupCss = await readFile(new URL("../../extension/popup.css", import.meta.url), "utf8");
  await page.setContent(popupHtml
    .replace(/<link[^>]+popup\.css[^>]*>/, "")
    .replace(/<script[^>]+popup\.js[^>]*><\/script>/, ""));
  await page.addStyleTag({ content: popupCss });
  await page.evaluate(() => {
    window.openedTabs = [];
    window.popupClosed = false;
    window.close = () => {};
    window.browser = {
      permissions: { contains: async () => true, request: async () => true },
      commands: { getAll: async () => [] },
      tabs: {
        create: (tab) => window.openedTabs.push(tab),
        query: async () => [{ id: 1 }],
        sendMessage: async () => {},
      },
      scripting: { executeScript: async () => {} },
    };
    window.fetch = async () => ({ ok: true, json: async () => ({ count: 2 }) });
    window.copiedText = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => window.copiedText.push(text) } });
  });
  await page.addScriptTag({ path: fileURLToPath(new URL("../../extension/popup.js", import.meta.url)) });
  await page.getByText("2 changes saved in Pinbox", { exact: true }).waitFor();

  assert.equal(await page.locator(".eyebrow").count(), 0);
  assert.equal(await page.locator(".brand-logo").getAttribute("alt"), "Pinbox");
  assert.equal(await page.locator(".brand-logo").getAttribute("src"), "pinbox-logo-light.png");
  assert.equal(await page.locator(".brand-logo").evaluate((image) => Math.round(image.getBoundingClientRect().width)), 190);
  assert.equal(await page.locator(".popup-brand source").getAttribute("srcset"), "pinbox-logo-dark.png");
  assert.equal(await page.locator("#inbox-count").evaluate((count) => getComputedStyle(count).color), "rgb(255, 79, 104)");
  assert.equal((await page.locator("#select-element").textContent()).trim(), "+");
  assert.equal(await page.locator("#select-element").getAttribute("data-tooltip"), "Select an Element");
  assert.equal((await page.locator("#open-inbox").textContent()).trim(), "");
  assert.equal(await page.locator("#open-inbox").getAttribute("data-tooltip"), "Open Pinbox");
  assert.equal(await page.locator("#open-inbox svg").count(), 1);
  assert.equal(await page.locator("#fix-everything").textContent(), "Fix Everything");
  const [selectBox, inboxBox, fixBox] = await Promise.all([
    page.locator("#select-element").boundingBox(),
    page.locator("#open-inbox").boundingBox(),
    page.locator("#fix-everything").boundingBox(),
  ]);
  assert.equal(selectBox.y, inboxBox.y);
  assert(inboxBox.x > selectBox.x + selectBox.width);
  assert.equal(fixBox.y, inboxBox.y);
  assert(fixBox.x > inboxBox.x + inboxBox.width);
  await page.locator("#select-element").hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#select-element"), "::after").opacity === "1");
  assert.equal(await page.locator("#select-element").evaluate((button) => getComputedStyle(button, "::after").opacity), "1");

  await page.locator("#fix-everything").click();
  assert.match(await page.locator("#message").textContent(), /\/Pinpoint is copied: paste it into your AI Agent chat/);
  assert.deepEqual(await page.evaluate(() => window.copiedText), ["/Pinpoint"]);
  assert.deepEqual(await page.evaluate(() => window.openedTabs), []);
  await page.locator("#open-inbox").click();
  assert.deepEqual(await page.evaluate(() => window.openedTabs), [{ url: "http://127.0.0.1:4321/" }]);
});

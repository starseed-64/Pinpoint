import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");

class Element {
  constructor() {
    this.style = {};
    this.hidden = true;
    this.listeners = new Map();
    this.measurements = 0;
  }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  dispatch(name, event = {}) { for (const callback of this.listeners.get(name) ?? []) callback(event); }
  attachShadow() {
    const nodes = new Map();
    this.shadow = {
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, new Element());
        return nodes.get(selector);
      },
      contains(target) { return [...nodes.values()].includes(target); },
    };
    return this.shadow;
  }
  contains(target) { return this === target; }
  append(child) { this.lastChild = child; }
  remove() { this.removed = true; }
  getBoundingClientRect() { this.measurements++; return { left: 1, top: 2, width: 30, height: 40 }; }
}

function capture() {
  const document = new Element();
  document.documentElement = new Element();
  document.createElement = () => new Element();
  const window = new Element();
  const frames = new Map();
  let frameId = 0;
  window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.clearTimeout = () => {};
  const listeners = new Set();
  const context = vm.createContext({
    window, document, HTMLElement: Element,
    browser: { runtime: { onMessage: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) } } },
  });
  return { document, window, frames, listeners, start: () => vm.runInContext(source, context) };
}

test("cancel and restart do not retain a detached capture listener or document handlers", () => {
  const app = capture();
  for (let i = 0; i < 3; i++) {
    app.start();
    for (const listener of app.listeners) listener({ type: "START_SELECTION" });
    assert.equal(app.listeners.size, 1);
    assert.equal(app.document.listeners.get("pointerdown").size, 1);
    app.document.documentElement.lastChild.shadow.querySelector(".cancel").dispatch("click");
    assert.equal(app.listeners.size, 0);
    for (const listeners of app.document.listeners.values()) assert.equal(listeners.size, 0);
    assert.equal(app.window.listeners.get("resize").size, 0);
  }
});

test("hovering measures at most once per frame and ignores unchanged targets", () => {
  const app = capture();
  app.start();
  const first = new Element();
  const second = new Element();
  app.document.dispatch("mousemove", { target: first });
  app.document.dispatch("mousemove", { target: second });
  assert.equal(app.frames.size, 1);
  for (const callback of app.frames.values()) callback();
  app.frames.clear();
  assert.equal(first.measurements, 0);
  assert.equal(second.measurements, 1);
  app.document.dispatch("mousemove", { target: second });
  assert.equal(app.frames.size, 0);
  app.document.dispatch("scroll");
  assert.equal(app.frames.size, 1);
  app.document.documentElement.lastChild.shadow.querySelector(".cancel").dispatch("click");
  assert.equal(app.frames.size, 0);
});

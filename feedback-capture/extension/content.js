(() => {
  if (window.__pinpointCapture) return;
  window.__pinpointCapture = true;

  const host = document.createElement("div");
  host.id = "__pinpoint-capture-host";
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { color-scheme: light dark; }
      * { box-sizing:border-box; }
      .outline { position:fixed; display:none; border:2px solid #ff4f68; background:rgba(255,79,104,.09); border-radius:6px; pointer-events:none; }
      .panel { --panel-bg:#fff; --panel-text:#1d1d1f; --panel-secondary:#6e6e73; --panel-border:#dedee3; position:fixed; top:16px; right:16px; width:min(380px,calc(100vw - 32px)); padding:20px; color:var(--panel-text); background:var(--panel-bg); border:1px solid var(--panel-border); border-radius:18px; box-shadow:0 10px 40px rgba(0,0,0,.16); pointer-events:auto; font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      .brand { display:flex; align-items:center; justify-content:space-between; color:var(--panel-secondary); font-size:12px; font-weight:600; }
      .mode { color:#e9435b; font-size:11px; font-weight:600; }
      h2 { margin:16px 0 6px; font:600 21px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:-.02em; }
      .target { overflow:hidden; margin:0 0 14px; color:var(--panel-secondary); font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; text-overflow:ellipsis; white-space:nowrap; }
      label { display:block; margin-bottom:7px; color:var(--panel-text); font-size:13px; font-weight:600; }
      textarea { display:block; width:100%; min-height:104px; resize:vertical; padding:10px 12px; color:var(--panel-text); background:var(--panel-bg); border:1px solid var(--panel-border); border-radius:12px; outline:none; font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      textarea:focus { border-color:#007aff; box-shadow:0 0 0 3px rgba(0,122,255,.18); }
      .actions { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
      button { min-height:42px; padding:0 14px; color:var(--panel-text); background:#f5f5f7; border:1px solid var(--panel-border); border-radius:12px; font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; cursor:pointer; }
      button:hover { background:#e9e9eb; }
      button:focus-visible { outline:3px solid rgba(0,122,255,.4); outline-offset:2px; }
      .cancel:hover { color:#c5222a; background:#fff1f0; border-color:#ffb5af; }
      .save { color:#fff; background:linear-gradient(135deg,#ff3e73,#ff7354); border-color:#f34d65; }
      .save:hover { background:linear-gradient(135deg,#e93665,#ee6247); }
      .save:disabled { opacity:.58; cursor:wait; }
      .notice { min-height:16px; margin:9px 0 0; color:var(--panel-secondary); font-size:12px; }
      @media (prefers-color-scheme: dark) {
        .panel { --panel-bg:#1c1c1e; --panel-text:#f5f5f7; --panel-secondary:#98989d; --panel-border:#3a3a3c; }
        button { background:#2c2c2e; }
        button:hover { background:#3a3a3c; }
        .cancel:hover { color:#ff6961; background:#3a2524; border-color:#70403d; }
      }
    </style>
    <div class="outline"></div>
    <section class="panel" hidden>
      <div class="brand"><span>Pinpoint</span><span class="mode">ELEMENT SELECTED</span></div>
      <h2>Report a change</h2>
      <p class="target"></p>
      <label for="feedback-note">Describe the bug</label>
      <textarea id="feedback-note" maxlength="5000" placeholder="What happened, and what should change?"></textarea>
      <div class="actions"><button class="cancel" type="button">Cancel</button><button class="save" type="button">Save to Pinbox</button></div>
      <p class="notice" role="status"></p>
    </section>`;
  document.documentElement.append(host);

  const outline = shadow.querySelector(".outline");
  const panel = shadow.querySelector(".panel");
  const targetLabel = shadow.querySelector(".target");
  const note = shadow.querySelector("textarea");
  const notice = shadow.querySelector(".notice");
  const saveButton = shadow.querySelector(".save");
  let selectedElement = null;
  let selectionGuardTimer = 0;
  let savedTimer = 0;
  let outlineFrame = 0;
  let hoveredElement = null;
  let disposed = false;
  const guardedEvents = ["mousedown", "pointerup", "mouseup", "click", "auxclick", "dblclick", "contextmenu"];

  for (const eventName of ["click", "keydown", "keypress", "keyup", "pointerdown", "pointerup", "mousedown", "mouseup"]) {
    panel.addEventListener(eventName, (event) => event.stopPropagation());
  }

  function isOverlay(target) {
    return target === host || host.contains(target) || shadow.contains(target);
  }

  function showOutline(element) {
    const rect = element.getBoundingClientRect();
    outline.style.display = "block";
    outline.style.left = `${rect.left}px`;
    outline.style.top = `${rect.top}px`;
    outline.style.width = `${rect.width}px`;
    outline.style.height = `${rect.height}px`;
  }

  function stopSelecting() {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("pointerdown", onPagePointerDown, true);
    document.removeEventListener("mousedown", onPagePointerDown, true);
    document.removeEventListener("keydown", onEscape, true);
    document.removeEventListener("scroll", refreshOutline, true);
    window.removeEventListener("resize", refreshOutline);
    if (outlineFrame) window.cancelAnimationFrame(outlineFrame);
    outlineFrame = 0;
    hoveredElement = null;
    stopSelectionGuard();
    outline.style.display = "none";
  }

  function onMouseMove(event) {
    const element = event.target;
    if (!(element instanceof HTMLElement) || isOverlay(element) || element === hoveredElement) return;
    hoveredElement = element;
    refreshOutline();
  }

  function refreshOutline() {
    if (outlineFrame || !hoveredElement) return;
    outlineFrame = window.requestAnimationFrame(() => {
      outlineFrame = 0;
      if (hoveredElement) showOutline(hoveredElement);
    });
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    stopSelecting();
    if (savedTimer) window.clearTimeout(savedTimer);
    browser.runtime.onMessage.removeListener(onMessage);
    host.remove();
    window.__pinpointCapture = false;
  }

  function stopSelectionGuard() {
    if (selectionGuardTimer) window.clearTimeout(selectionGuardTimer);
    selectionGuardTimer = 0;
    for (const eventName of guardedEvents) document.removeEventListener(eventName, guardSelectedGesture, true);
  }

  function guardSelectedGesture(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (["click", "auxclick", "dblclick", "contextmenu"].includes(event.type)) stopSelectionGuard();
  }

  function guardCurrentGesture() {
    stopSelectionGuard();
    for (const eventName of guardedEvents) document.addEventListener(eventName, guardSelectedGesture, true);
    selectionGuardTimer = window.setTimeout(stopSelectionGuard, 800);
  }

  function onPagePointerDown(event) {
    if (event.button !== 0) return;
    const element = event.composedPath().find((target) => target instanceof HTMLElement && !isOverlay(target));
    if (!(element instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    selectedElement = element;
    stopSelecting();
    guardCurrentGesture();
    if (targetLabel) targetLabel.textContent = `${element.tagName.toLowerCase()} ${buildSelector(element)}`;
    panel.hidden = false;
    document.addEventListener("keydown", onEscape, true);
    note.focus();
  }

  function onEscape(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cleanup();
  }

  function buildSelector(element) {
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 8) {
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      let segment = current.tagName.toLowerCase();
      const testId = current.getAttribute("data-testid");
      if (testId) {
        segment += `[data-testid="${testId.replace(/["\\]/g, "\\$&")}"]`;
      } else {
        const sameTagSiblings = current.parentElement
          ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName)
          : [];
        if (sameTagSiblings.length > 1) segment += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
      }
      parts.unshift(segment);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function getElementData(element) {
    const rect = element.getBoundingClientRect();
    const attributes = {};
    for (const name of ["aria-label", "name", "role", "data-testid", "href", "type"]) {
      const value = element.getAttribute(name);
      if (value) attributes[name] = value.slice(0, 300);
    }
    return {
      tag: element.tagName.toLowerCase(),
      selector: buildSelector(element),
      text: (element.innerText || element.getAttribute("aria-label") || "").trim().slice(0, 300),
      attributes,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }

  shadow.querySelector(".cancel").addEventListener("click", cleanup);

  saveButton.addEventListener("click", async () => {
    const comment = note.value.trim();
    if (!comment) {
      notice.textContent = "Describe the bug before saving.";
      note.focus();
      return;
    }
    saveButton.disabled = true;
    notice.textContent = "Saving to Pinbox…";
    try {
      const result = await browser.runtime.sendMessage({
        type: "SAVE_FEEDBACK",
        payload: {
          comment,
          page: { url: location.href, title: document.title },
          element: getElementData(selectedElement),
        },
      });
      if (disposed) return;
      notice.textContent = `Saved to Pinbox as ${result.name}`;
      saveButton.textContent = "Report Saved";
      savedTimer = window.setTimeout(cleanup, 1100);
    } catch (error) {
      if (disposed) return;
      notice.textContent = error.message ?? "Could not reach Pinbox.";
      saveButton.disabled = false;
    }
  });

  function startSelecting() {
    if (disposed || !panel.hidden) return;
    panel.hidden = true;
    notice.textContent = "Select an element without activating it. Press Escape to cancel.";
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("pointerdown", onPagePointerDown, true);
    document.addEventListener("mousedown", onPagePointerDown, true);
    document.addEventListener("keydown", onEscape, true);
    document.addEventListener("scroll", refreshOutline, true);
    window.addEventListener("resize", refreshOutline);
  }

  function onMessage(message) {
    if (message?.type === "START_SELECTION") startSelecting();
  }
  browser.runtime.onMessage.addListener(onMessage);
  startSelecting();
})();
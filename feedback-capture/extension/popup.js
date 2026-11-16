const selectButton = document.getElementById("select-element");
const inboxButton = document.getElementById("open-inbox");
const fixEverythingButton = document.getElementById("fix-everything");
const message = document.getElementById("message");
const shortcutHint = document.getElementById("shortcut-hint");
const inboxCount = document.getElementById("inbox-count");
const inboxOrigins = ["http://127.0.0.1/*", "http://localhost/*"];
const isMac = /Mac|iPhone|iPad/i.test(`${navigator.platform} ${navigator.userAgent}`);

function formatShortcut(shortcut) {
  return shortcut.split("+").map((key) => {
    if (isMac && key === "Alt") return "Option";
    if (isMac && key === "Ctrl") return "Command";
    if (isMac && key === "MacCtrl") return "Control";
    if (!isMac && key === "MacCtrl") return "Ctrl";
    return key;
  }).join(" + ");
}

const defaultShortcut = isMac ? "Option + Shift + P" : "Alt + Shift + P";

browser.permissions.contains({ origins: inboxOrigins }).then(async (hasAccess) => {
  if (!hasAccess) {
    inboxCount.textContent = "Grant Pinbox access in Pinpoint settings";
    return;
  }
  const response = await fetch("http://127.0.0.1:4321/api/feedback?count=1", { cache: "no-store" });
  if (!response.ok) throw new Error("Inbox unavailable");
  const result = await response.json();
  if (!Number.isSafeInteger(result.count) || result.count < 0) throw new Error("Invalid inbox count");
  inboxCount.textContent = `${result.count} ${result.count === 1 ? "change" : "changes"} saved in Pinbox`;
}).catch(() => {
  inboxCount.textContent = "Pinbox count unavailable";
});

browser.commands.getAll().then((commands) => {
  const shortcut = commands.find((command) => command.name === "start-element-selection")?.shortcut;
  shortcutHint.textContent = `Shortcut: ${formatShortcut(shortcut || "Alt+Shift+P")}`;
}).catch(() => {
  shortcutHint.textContent = `Shortcut: ${defaultShortcut}`;
});

selectButton.addEventListener("click", async () => {
  try {
    const hasInboxAccess = await browser.permissions.request({ origins: inboxOrigins });
    if (!hasInboxAccess) throw new Error("Pinbox access is needed to save reports. Grant it in Pinpoint settings.");
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active page found.");
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await browser.tabs.sendMessage(tab.id, { type: "START_SELECTION" });
    window.close();
  } catch (error) {
    message.textContent = error.message ?? "This page does not allow element selection.";
  }
});

function openPinbox() {
  browser.tabs.create({ url: "http://127.0.0.1:4321/" });
  window.close();
}

inboxButton.addEventListener("click", openPinbox);
fixEverythingButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("/Pinpoint");
    message.textContent = "Your changes are ready for the Agent. /Pinpoint is copied: paste it into your AI Agent chat.";
  } catch {
    message.textContent = "Your changes are ready for the Agent. Copy and paste /Pinpoint into your AI Agent chat.";
  }
});

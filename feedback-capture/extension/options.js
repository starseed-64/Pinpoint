const currentShortcut = document.getElementById("current-shortcut");
const shortcutMessage = document.getElementById("shortcut-message");
const changeShortcutButton = document.getElementById("change-shortcut");
const inboxAccessStatus = document.getElementById("inbox-access-status");
const grantInboxAccessButton = document.getElementById("grant-inbox-access");
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

browser.permissions.contains({ origins: inboxOrigins }).then((hasAccess) => {
  inboxAccessStatus.textContent = hasAccess
    ? "Pinbox access is enabled."
    : "Grant access so Pinpoint can save and count reports in Pinbox.";
  grantInboxAccessButton.textContent = hasAccess ? "Pinbox Access Enabled" : "Grant Pinbox Access";
  grantInboxAccessButton.disabled = hasAccess;
}).catch(() => {
  inboxAccessStatus.textContent = "Could not check Pinbox access.";
});

grantInboxAccessButton.addEventListener("click", async () => {
  inboxAccessStatus.textContent = "";
  try {
    const granted = await browser.permissions.request({ origins: inboxOrigins });
    inboxAccessStatus.textContent = granted
      ? "Pinbox access is enabled."
      : "Access was not granted. Pinpoint cannot save reports without it.";
    if (granted) {
      grantInboxAccessButton.textContent = "Pinbox Access Enabled";
      grantInboxAccessButton.disabled = true;
    }
  } catch {
    inboxAccessStatus.textContent = "Firefox could not request Pinbox access. Try again from these settings.";
  }
});

browser.commands.getAll().then((commands) => {
  const shortcut = commands.find((command) => command.name === "start-element-selection")?.shortcut;
  currentShortcut.textContent = shortcut ? formatShortcut(shortcut) : "Not assigned";
}).catch(() => {
  currentShortcut.textContent = "Unavailable";
  shortcutMessage.textContent = "Could not read the shortcut. You can still change it in Firefox settings.";
});

changeShortcutButton.addEventListener("click", async () => {
  shortcutMessage.textContent = "";
  try {
    await browser.commands.openShortcutSettings();
  } catch {
    shortcutMessage.textContent = "Open Firefox Add-ons and choose Manage Extension Shortcuts.";
  }
});
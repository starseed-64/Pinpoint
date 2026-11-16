const inboxOrigins = ["http://127.0.0.1/*", "http://localhost/*"];

browser.runtime.onMessage.addListener(async (message) => {
  if (message?.type !== "SAVE_FEEDBACK") return undefined;
  const hasInboxAccess = await browser.permissions.contains({ origins: inboxOrigins });
  if (!hasInboxAccess) throw new Error("Grant Pinbox access in Pinpoint settings, then try saving again.");

  return fetch("http://127.0.0.1:4321/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message.payload),
  }).then(async (response) => {
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? "Could not save the report to Pinbox.");
    return result;
  });
});

browser.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "start-element-selection" || !tab?.id) return;

  try {
    const hasInboxAccess = await browser.permissions.contains({ origins: inboxOrigins });
    if (!hasInboxAccess) {
      await browser.runtime.openOptionsPage();
      return;
    }
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await browser.tabs.sendMessage(tab.id, { type: "START_SELECTION" });
  } catch (error) {
    console.error("Pinpoint could not start element selection.", error);
  }
});
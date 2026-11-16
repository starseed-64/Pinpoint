import type { APIRoute } from "astro";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const prerender = false;

const inboxDirectory = resolve(
  process.env.FEEDBACK_PROJECT_ROOT ?? resolve(process.cwd(), ".."),
  "Pinbox",
);
const pageIndexPath = resolve(inboxDirectory, ".pinbox-pages.json");
const maxFeedbackBytes = 16_000;
type Note = { name: string; content: string };
let inboxOperation: Promise<void> = Promise.resolve();

function withInboxLock<T>(operation: () => Promise<T>) {
  const current = inboxOperation.then(operation);
  inboxOperation = current.then(() => undefined, () => undefined);
  return current;
}

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function storageError(error: unknown) {
  console.error("Pinbox could not access its feedback files.", error);
  return Response.json({ error: "Could not access the saved bugs. Check the server logs and folder permissions." }, { status: 500 });
}

async function listFilenames() {
  try {
    return (await readdir(inboxDirectory)).filter((filename) => filename.endsWith(".md")).sort().reverse();
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

async function readNotes(filenames: string[]) {
  const notes = await Promise.all(filenames.map(async (name) => {
    try {
      return { name, content: await readFile(resolve(inboxDirectory, name), "utf8") };
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }));
  return notes.filter((note): note is Note => note !== undefined);
}

async function writeAtomicFile(path: string, content: string) {
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { flag: "wx", mode });
    if (mode !== undefined) await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function normalizePageRoute(rawUrl: string) {
  const url = new URL(rawUrl);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.origin}${pathname}`;
}

function getPageRouteFromNote(content: string) {
  const rawUrl = content.match(/^Page:\s*(https?:\/\/\S+)\s*$/m)?.[1]
    ?? content.match(/^Page:\s+.*\((https?:\/\/[^)\s]+)\)\s*$/m)?.[1]
    ?? content.match(/^- URL:\s*(https?:\/\/\S+)/m)?.[1];
  if (!rawUrl) return undefined;
  try {
    return normalizePageRoute(rawUrl);
  } catch {
    return undefined;
  }
}

async function readPageIndex(notes: Note[]) {
  let storedIndex: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(pageIndexPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      storedIndex = parsed as Record<string, unknown>;
    } else {
      throw new Error("The Pinbox page index is not a JSON object.");
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const pageIndex: Record<string, string> = {};
  for (const note of notes) {
    const storedRoute = storedIndex[note.name];
    if (typeof storedRoute === "string" && storedRoute) {
      pageIndex[note.name] = normalizePageRoute(storedRoute);
      continue;
    }
    pageIndex[note.name] = getPageRouteFromNote(note.content) ?? "";
  }
  return pageIndex;
}

function compactText(value: string, limit: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function compactTarget(element: Record<string, unknown>) {
  const tag = typeof element.tag === "string" ? element.tag : "element";
  const selector = typeof element.selector === "string" ? element.selector : "";
  const attributes = element.attributes && typeof element.attributes === "object"
    ? element.attributes as Record<string, unknown>
    : {};
  const elementTestId = typeof attributes["data-testid"] === "string" ? attributes["data-testid"] : "";
  const ariaLabel = typeof attributes["aria-label"] === "string" ? attributes["aria-label"] : "";
  const testIdMatches = [...selector.matchAll(/\[data-testid="(?:\\.|[^"\\])*"\]/g)];
  const anchorMatch = testIdMatches[testIdMatches.length - 1];

  if (elementTestId) return `[data-testid=${JSON.stringify(elementTestId)}]`;
  const target = anchorMatch ? selector.slice(anchorMatch.index).trim() : selector;
  if (ariaLabel) {
    return `${target || tag}[aria-label=${JSON.stringify(ariaLabel)}]`;
  }
  return target || tag;
}

function noteField(content: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.match(new RegExp(`^(?:-\\s*)?(?:\\*\\*)?${escaped}:(?:\\*\\*)?\\s*(.*)$`, "m"))?.[1]?.trim();
}

function compactNoteContent(content: string) {
  let target = noteField(content, "Target");
  const fixLabel = /^(?:-[ \t]*)?(?:\*\*)?Fix:(?:\*\*)?[ \t]*/m.exec(content);
  let fix = fixLabel ? content.slice(fixLabel.index + fixLabel[0].length).trim() : undefined;
  if (target && fix) return `**Target:** ${target}\n**Fix:** ${fix}\n`;
  const legacyText = noteField(content, "Text") ?? noteField(content, "Visible text") ?? "";
  const attributesValue = noteField(content, "Attributes");
  let attributes: Record<string, unknown> = {};
  if (attributesValue) {
    try {
      const parsed: unknown = JSON.parse(attributesValue);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) attributes = parsed as Record<string, unknown>;
    } catch {
      attributes = {};
    }
  }

  if (!target) {
    const selector = noteField(content, "Selector")?.replace(/^`|`$/g, "") ?? "";
    const tag = noteField(content, "Element") ?? "element";
    if (selector) target = compactTarget({ tag, selector, attributes });
  }

  if (!fix) {
    const sectionIndex = content.search(/^## Requested changes\s*$/m);
    if (sectionIndex >= 0) fix = content.slice(sectionIndex).replace(/^## Requested changes\s*/, "").trim();
  }
  if (!target || !fix) return content;

  const ariaLabel = typeof attributes["aria-label"] === "string" ? attributes["aria-label"].trim() : "";
  if (legacyText && legacyText.toLowerCase() !== ariaLabel.toLowerCase() && !target.toLowerCase().includes(legacyText.toLowerCase())) {
    target = `${target} ${JSON.stringify(compactText(legacyText, 120))}`;
  }
  return `**Target:** ${target}\n**Fix:** ${fix}\n`;
}

function withPageMetadata(content: string, route: string, hasMultiplePages: boolean) {
  const compacted = compactNoteContent(content);
  const withoutPageMetadata = compacted.replace(/^(?:(?:Page:|-[ \t]*(?:Page:|URL:))[^\r\n]*(?:\r?\n|$))+/, "");
  return hasMultiplePages && route ? `Page: ${route}\n${withoutPageMetadata}` : withoutPageMetadata;
}

async function syncPageMetadata(notes: Note[], pageIndex: Record<string, string>) {
  const validIndex = Object.fromEntries(notes.map(({ name }) => [name, pageIndex[name] ?? ""]));
  const hasMultiplePages = new Set(Object.values(validIndex).filter(Boolean)).size > 1;
  if (notes.length) await writeAtomicFile(pageIndexPath, JSON.stringify(validIndex));
  else await rm(pageIndexPath, { force: true });

  for (const note of notes) {
    const next = withPageMetadata(note.content, validIndex[note.name], hasMultiplePages);
    if (next !== note.content) await writeAtomicFile(resolve(inboxDirectory, note.name), next);
  }
}

export const GET: APIRoute = async ({ request }) => {
  const searchParams = new URL(request.url).searchParams;
  if (searchParams.has("health")) {
    return Response.json({
      app: "Pinbox",
      projectId: createHash("sha256").update(inboxDirectory).digest("hex"),
    }, { headers: { "Cache-Control": "no-store" } });
  }

  return withInboxLock(async () => {
    const filenames = await listFilenames();
    if (searchParams.has("count")) {
      return Response.json({ count: filenames.length }, { headers: { "Cache-Control": "no-store" } });
    }
    const notes = await readNotes(filenames);
    const pageIndex = await readPageIndex(notes);
    const hasMultiplePages = new Set(Object.values(pageIndex).filter(Boolean)).size > 1;
    const items = notes.map(({ name, content }) => ({
      name,
      content: withPageMetadata(content, pageIndex[name], hasMultiplePages),
    }));

    return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
  }).catch(storageError);
};

export const POST: APIRoute = async ({ request }) => {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxFeedbackBytes) {
    return Response.json({ error: "Feedback is too large." }, { status: 413 });
  }

  let payload: Record<string, unknown>;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing JSON body.");
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let json = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > maxFeedbackBytes) {
          await reader.cancel();
          return Response.json({ error: "Feedback is too large." }, { status: 413 });
        }
        json += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    const parsed: unknown = JSON.parse(json + decoder.decode());
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid JSON object.");
    payload = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Expected a JSON feedback record." }, { status: 400 });
  }

  const page = payload.page && typeof payload.page === "object" ? payload.page as Record<string, unknown> : {};
  const element = payload.element && typeof payload.element === "object" ? payload.element as Record<string, unknown> : {};
  const comment = typeof payload.comment === "string" ? payload.comment.trim() : "";
  if (!comment || comment.length > 5000) {
    return Response.json({ error: "Add feedback (up to 5,000 characters)." }, { status: 400 });
  }
  if (typeof page.url !== "string" || typeof element.selector !== "string") {
    return Response.json({ error: "The page and selected element are required." }, { status: 400 });
  }

  let pageRoute: string;
  try {
    pageRoute = normalizePageRoute(page.url);
  } catch {
    return Response.json({ error: "The page URL is invalid." }, { status: 400 });
  }

  const filename = `fix-${randomUUID().slice(0, 8)}.md`;
  const visibleText = typeof element.text === "string" ? compactText(element.text, 120) : "";
  const attributes = element.attributes && typeof element.attributes === "object"
    ? element.attributes as Record<string, unknown>
    : {};
  const ariaLabel = typeof attributes["aria-label"] === "string" ? compactText(attributes["aria-label"], 120) : "";
  const target = compactTarget(element);
  const targetWithText = visibleText
    && visibleText.toLowerCase() !== ariaLabel.toLowerCase()
    && !target.toLowerCase().includes(visibleText.toLowerCase())
    ? `${target} ${JSON.stringify(visibleText)}`
    : target;
  const markdown = `Page: ${pageRoute}\n**Target:** ${targetWithText}\n**Fix:** ${comment}\n`;

  return withInboxLock(async () => {
    await mkdir(inboxDirectory, { recursive: true });
    const notes = await readNotes(await listFilenames());
    const pageIndex = await readPageIndex(notes);
    await writeFile(resolve(inboxDirectory, filename), markdown, { flag: "wx" });
    notes.push({ name: filename, content: markdown });
    pageIndex[filename] = pageRoute;
    await syncPageMetadata(notes, pageIndex);
    return Response.json({ name: filename }, { status: 201 });
  }).catch(storageError);
};

export const DELETE: APIRoute = async ({ request }) => withInboxLock(async () => {
  const searchParams = new URL(request.url).searchParams;
  if (searchParams.get("all") === "1") {
    const filenames = await listFilenames();
    await Promise.all(filenames.map((filename) => unlink(resolve(inboxDirectory, filename))));
    await rm(pageIndexPath, { force: true });
    return Response.json({ deleted: filenames.length });
  }

  const filename = searchParams.get("name") ?? "";
  if (!/^[\w.-]+\.md$/.test(filename)) {
    return Response.json({ error: "Invalid feedback filename." }, { status: 400 });
  }

  try {
    await unlink(resolve(inboxDirectory, filename));
  } catch (error) {
    if (isMissingFile(error)) return Response.json({ error: "Feedback file not found." }, { status: 404 });
    throw error;
  }

  const notes = await readNotes(await listFilenames());
  await syncPageMetadata(notes, await readPageIndex(notes));
  return new Response(null, { status: 204 });
}).catch(storageError);
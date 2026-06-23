// ═══════════════════════════════════════════════════════════════════════════
//  Skool Video Capture — Background Service Worker (v3.0)
//  Per-platform content script detection + webRequest sniffer + Native bridge.
//  Handles PAGE_VIDEO_DETECTED from inject-main.js for metadata extraction.
// ═══════════════════════════════════════════════════════════════════════════

const EXTENSION_NAME = "Skool Video Capture";
const STORAGE_KEY_CAPTURES = "capturedVideos";
const STORAGE_KEY_DOWNLOADS = "downloadQueue";
const POISON_EXPIRY_MS = 30 * 60 * 1000;
const GC_INTERVAL_MS = 2 * 60 * 1000;
const NATIVE_HOST = "com.generic_bridge.engine";

// ─── Registries ───────────────────────────────────────────────────────────
let capturedVideos = new Map();   // tabId → video entry
let downloadQueue = new Map();    // downloadId → download status
let nativePort = null;

// ─── Persistence ──────────────────────────────────────────────────────────
async function loadFromStorage() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY_CAPTURES, STORAGE_KEY_DOWNLOADS]);
    if (data[STORAGE_KEY_CAPTURES]) {
      const entries = JSON.parse(data[STORAGE_KEY_CAPTURES]);
      const now = Date.now();
      for (const [tabIdStr, entry] of Object.entries(entries)) {
        if (now - entry.detectedAt < POISON_EXPIRY_MS) {
          capturedVideos.set(parseInt(tabIdStr, 10), entry);
        }
      }
    }
    if (data[STORAGE_KEY_DOWNLOADS]) {
      downloadQueue = new Map(JSON.parse(data[STORAGE_KEY_DOWNLOADS]));
    }
  } catch (err) {
    console.warn(`[${EXTENSION_NAME}] Storage load:`, err);
  }
}

async function saveCaptures() {
  const obj = {};
  for (const [tabId, entry] of capturedVideos) obj[String(tabId)] = entry;
  await chrome.storage.local.set({ [STORAGE_KEY_CAPTURES]: JSON.stringify(obj) });
}

async function saveDownloads() {
  await chrome.storage.local.set({ [STORAGE_KEY_DOWNLOADS]: JSON.stringify([...downloadQueue]) });
}

// ─── Native port management ───────────────────────────────────────────────
function getNativePort() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort.onMessage.addListener((msg) => {
      if (msg.event === "PROGRESS" || msg.event === "FINISHED" || msg.event === "STARTED" || msg.event === "ERROR") {
        // Forward to popup via storage
        const status = downloadQueue.get(msg.url) || {};
        downloadQueue.set(msg.url, { ...status, lastEvent: msg.event, progress: msg });
        saveDownloads();
        chrome.runtime.sendMessage({ action: "DOWNLOAD_PROGRESS", data: msg }).catch(() => {});
      }
    });
    nativePort.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) console.warn(`[${EXTENSION_NAME}] Native disconnect:`, chrome.runtime.lastError.message);
      nativePort = null;
    });
  } catch (err) {
    console.error(`[${EXTENSION_NAME}] Native port:`, err);
    nativePort = null;
  }
  return nativePort;
}

function sendToNative(payload) {
  const port = getNativePort();
  if (!port) return false;
  try { port.postMessage(payload); return true; } catch (err) { return false; }
}

// ─── Stream patterns for webRequest sniffer ──────────────────────────────
const STREAM_PATTERNS = [
  { test: /\.m3u8(\?|$)/i,        label: "HLS Stream (.m3u8)" },
  { test: /\.mpd(\?|$)/i,          label: "MPEG-DASH (.mpd)" },
  { test: /\/(segment|seq|chunk|\d{4,}|output_\d+)\.ts(\?|$)/i, label: "Video Segment (.ts)" },
  { test: /\.m4s(\?|$)/i,          label: "Video Segment (.m4s)" },
  { test: /\.(mp4|webm)(\?|$)/i,   label: "Direct Video File" },
  { test: /loom/i,                 label: "Loom Video" },
  { test: /vimeo/i,                label: "Vimeo Video" },
  { test: /wistia/i,               label: "Wistia Video" },
  { test: /googlevideo/i,          label: "YouTube Stream" },
  { test: /cloudflarestream/i,     label: "Cloudflare Stream" },
];

function normaliseUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const safe = ["_", "rnd", "cb", "nocache", "random"];
    const authRe = /signature|expires|policy|keypair|token|auth|credential|x-amz/i;
    u.searchParams.forEach((v, k) => {
      if (safe.includes(k.toLowerCase()) && !authRe.test(k)) u.searchParams.delete(k);
    });
    return u.href;
  } catch { return urlStr; }
}

function extractHost(urlStr) {
  try { return new URL(urlStr).hostname; } catch { return "unknown"; }
}

async function captureUrl(tabId, url, label, requestHeaders = [], pageMetadata = null) {
  const normalised = normaliseUrl(url);
  const existing = capturedVideos.get(tabId);
  if (existing) {
    const eb = /\.m3u8/i.test(existing.detectedUrl);
    const it = /\.(ts|m4s)/i.test(normalised);
    if (eb && it) return;
    if (/\.m3u8/i.test(normalised) && !eb) { /* upgrade */ }
    else return;
  }

  let ua = "", origin = "";
  for (const h of requestHeaders) {
    if ((h.name || "").toLowerCase() === "user-agent") ua = h.value || "";
    if ((h.name || "").toLowerCase() === "origin") origin = h.value || "";
  }

  capturedVideos.set(tabId, {
    detectedUrl: normalised,
    sourceLabel: label,
    detectedAt: Date.now(),
    host: extractHost(normalised),
    requestHeaders: { "User-Agent": ua, "Origin": origin },
    pageMetadata: pageMetadata || null,
  });

  try {
    chrome.action.setBadgeText({ text: "1", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50", tabId });
  } catch {}

  await saveCaptures();
}

// ─── GC ───────────────────────────────────────────────────────────────────
setInterval(async () => {
  const now = Date.now(); let changed = false;
  for (const [tabId, entry] of capturedVideos) {
    if (now - entry.detectedAt > POISON_EXPIRY_MS) {
      capturedVideos.delete(tabId);
      try { chrome.action.setBadgeText({ text: "", tabId }); } catch {}
      changed = true;
    }
  }
  if (changed) await saveCaptures();
}, GC_INTERVAL_MS);

// ═══════════════════════════════════════════════════════════════════════════
//  WEB REQUEST SNIFFER
// ═══════════════════════════════════════════════════════════════════════════
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    for (const p of STREAM_PATTERNS) {
      if (p.test.test(details.url)) {
        captureUrl(details.tabId, details.url, p.label, details.requestHeaders || []);
        break;
      }
    }
  },
  {
    urls: [
      "https://*.skool.com/*", "https://*.loom.com/*", "https://*.vimeo.com/*",
      "https://*.vimeocdn.com/*", "https://*.wistia.com/*", "https://*.wistia.net/*",
      "https://*.googlevideo.com/*", "https://*.cloudflarestream.com/*",
      "https://*.akamaized.net/*", "https://*.cloudfront.net/*", "https://*.amazonaws.com/*",
    ],
    types: ["media", "xmlhttprequest", "other"],
  },
  ["requestHeaders"]
);

// ═══════════════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // Content script detected a video on the page
    if (msg.action === "PAGE_VIDEO_DETECTED") {
      const tabId = sender.tab ? sender.tab.id : null;
      if (!tabId) { sendResponse({ ok: false }); return; }

      const v = msg.video;
      const existing = capturedVideos.get(tabId);

      // Merge page metadata into existing sniffer capture, or store as standalone
      if (existing && existing.sourceLabel && v.platform) {
        existing.pageMetadata = {
          platform: v.platform,
          title: v.title,
          duration: v.duration,
          source: v.source,
          pageUrl: v.pageUrl,
        };
        capturedVideos.set(tabId, existing);
        await saveCaptures();
      } else if (!existing) {
        // No sniffer capture yet — store what we know from the page
        capturedVideos.set(tabId, {
          detectedUrl: v.url,
          sourceLabel: `${v.platform} Video`,
          detectedAt: Date.now(),
          host: extractHost(v.url),
          requestHeaders: {},
          pageMetadata: {
            platform: v.platform,
            title: v.title,
            duration: v.duration,
            source: v.source,
            pageUrl: v.pageUrl,
          },
        });
        await saveCaptures();
        try {
          chrome.action.setBadgeText({ text: "1", tabId });
          chrome.action.setBadgeBackgroundColor({ color: "#4CAF50", tabId });
        } catch {}
      }

      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "getCapturedVideo") {
      sendResponse({ video: capturedVideos.get(msg.tabId) || null });
      return;
    }

    if (msg.action === "triggerDownload") {
      const entry = capturedVideos.get(msg.tabId);
      if (!entry) { sendResponse({ error: "No captured video for this tab" }); return; }

      const quality = msg.quality || "best";
      const payload = {
        action: "execute_download",
        url: entry.detectedUrl,
        request_headers: entry.requestHeaders || {},
        quality: quality,
      };

      downloadQueue.set(entry.detectedUrl, { status: "dispatched", quality, startedAt: Date.now() });
      await saveDownloads();

      const sent = sendToNative(payload);
      sendResponse(sent
        ? { event: "DISPATCHED", url: entry.detectedUrl }
        : { event: "ERROR", error: "Native host not available" }
      );
      return;
    }

    if (msg.action === "cancelDownload") {
      downloadQueue.delete(msg.url);
      await saveDownloads();
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "getDownloadQueue") {
      sendResponse({ queue: [...downloadQueue.entries()] });
      return;
    }

    if (msg.action === "pingNative") {
      sendResponse({ event: sendToNative({ action: "ping" }) ? "pong_sent" : "error" });
      return;
    }

    if (msg.action === "injectManualUrl") {
      await captureUrl(msg.tabId, msg.url, msg.label || "Manual Entry");
      sendResponse({ success: true });
      return;
    }

    if (msg.action === "clearCapture") {
      capturedVideos.delete(msg.tabId);
      try { chrome.action.setBadgeText({ text: "", tabId: msg.tabId }); } catch {}
      await saveCaptures();
      sendResponse({ success: true });
      return;
    }

    sendResponse({ error: "Unknown action" });
  })();
  return true;
});

// ─── Tab cleanup ──────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (capturedVideos.has(tabId)) { capturedVideos.delete(tabId); await saveCaptures(); }
});

loadFromStorage();
console.log(`[${EXTENSION_NAME}] v3.0 loaded with per-platform detection`);
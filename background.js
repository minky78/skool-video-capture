// ═══════════════════════════════════════════════════════════════════════════
//  Skool Video Capture — Background Service Worker (v2.0)
//  Network sniffer + Native Messaging bridge to yt-dlp.
//  Detects HLS/MP4/MPD streams, captures page context headers,
//  and delegates actual downloads to engine.py via Native Messaging.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Config ───────────────────────────────────────────────────────────────
const EXTENSION_NAME = "Skool Video Capture";
const STORAGE_KEY = "capturedVideos";
const POISON_EXPIRY_MS = 30 * 60 * 1000;
const GC_INTERVAL_MS = 2 * 60 * 1000;
const NATIVE_HOST_NAME = "com.generic_bridge.engine";

// ─── Captured video registry ──────────────────────────────────────────────
let capturedVideos = new Map();
// Latest status from native bridge downloads (keyed by URL)
let downloadStatus = new Map();

// Native messaging port reference
let nativePort = null;

// ─── Load persisted state from storage ────────────────────────────────────
async function loadFromStorage() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data[STORAGE_KEY]) {
      const entries = JSON.parse(data[STORAGE_KEY]);
      const now = Date.now();
      for (const [tabIdStr, entry] of Object.entries(entries)) {
        if (now - entry.detectedAt < POISON_EXPIRY_MS) {
          capturedVideos.set(parseInt(tabIdStr, 10), entry);
        }
      }
    }
  } catch (err) {
    console.warn(`[${EXTENSION_NAME}] Storage load error:`, err);
  }
}

async function saveToStorage() {
  try {
    const obj = {};
    for (const [tabId, entry] of capturedVideos) {
      obj[String(tabId)] = entry;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: JSON.stringify(obj) });
  } catch (err) {
    console.warn(`[${EXTENSION_NAME}] Storage save error:`, err);
  }
}

// ─── Stream detection heuristics ──────────────────────────────────────────
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

// ─── URL normalisation (safe — does NOT strip auth params) ────────────────
function normaliseUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const safeStripKeys = ["_", "rnd", "cb", "nocache", "random"];
    const authPatterns = /signature|expires|policy|keypair|token|auth|credential|x-amz/i;
    u.searchParams.forEach((value, key) => {
      if (safeStripKeys.includes(key.toLowerCase()) && !authPatterns.test(key)) {
        u.searchParams.delete(key);
      }
    });
    return u.href;
  } catch {
    return urlStr;
  }
}

function extractHost(urlStr) {
  try { return new URL(urlStr).hostname; } catch { return "unknown"; }
}

// ─── Store a captured URL with its request context headers ────────────────
async function captureUrl(tabId, url, label, requestHeaders = []) {
  const normalised = normaliseUrl(url);
  const existing = capturedVideos.get(tabId);

  if (existing) {
    const existingIsBetter = /\.m3u8/i.test(existing.detectedUrl);
    const incomingIsTs = /\.(ts|m4s)/i.test(normalised);
    if (existingIsBetter && incomingIsTs) return;
    const incomingIsBetter = /\.m3u8/i.test(normalised);
    if (incomingIsBetter && !existingIsBetter) { /* upgrade */ }
    else return;
  }

  // Extract User-Agent and Origin from request headers
  let userAgent = "";
  let origin = "";
  for (const h of requestHeaders) {
    const name = (h.name || "").toLowerCase();
    if (name === "user-agent") userAgent = h.value || "";
    if (name === "origin") origin = h.value || "";
  }

  capturedVideos.set(tabId, {
    detectedUrl: normalised,
    sourceLabel: label,
    detectedAt: Date.now(),
    host: extractHost(normalised),
    requestHeaders: { "User-Agent": userAgent, "Origin": origin },
  });

  try {
    chrome.action.setBadgeText({ text: "1", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50", tabId });
  } catch {}

  await saveToStorage();
  console.log(`[${EXTENSION_NAME}] Captured on tab ${tabId}: ${label} — ${normalised}`);
}

// ─── Garbage collector ────────────────────────────────────────────────────
setInterval(async () => {
  const now = Date.now();
  let changed = false;
  for (const [tabId, entry] of capturedVideos) {
    if (now - entry.detectedAt > POISON_EXPIRY_MS) {
      capturedVideos.delete(tabId);
      try { chrome.action.setBadgeText({ text: "", tabId }); } catch {}
      changed = true;
    }
  }
  if (changed) await saveToStorage();
}, GC_INTERVAL_MS);

// ═══════════════════════════════════════════════════════════════════════════
//  WEB REQUEST DETECTION (passive sniffer)
// ═══════════════════════════════════════════════════════════════════════════

// Listener 1: onBeforeSendHeaders — captures video URL + request headers
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const tabId = details.tabId;
    if (tabId < 0) return;
    const url = details.url;

    for (const pattern of STREAM_PATTERNS) {
      if (pattern.test.test(url)) {
        captureUrl(tabId, url, pattern.label, details.requestHeaders || []);
        break;
      }
    }
  },
  {
    urls: [
      "https://*.skool.com/*",
      "https://*.loom.com/*",
      "https://*.vimeo.com/*",
      "https://*.vimeocdn.com/*",
      "https://*.wistia.com/*",
      "https://*.wistia.net/*",
      "https://*.googlevideo.com/*",
      "https://*.cloudflarestream.com/*",
      "https://*.akamaized.net/*",
      "https://*.cloudfront.net/*",
      "https://*.amazonaws.com/*",
    ],
    types: ["media", "xmlhttprequest", "other", "script", "image"],
  },
  ["requestHeaders"]
);

// ═══════════════════════════════════════════════════════════════════════════
//  NATIVE MESSAGING — yt-dlp bridge
// ═══════════════════════════════════════════════════════════════════════════

function getNativePort() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort.onMessage.addListener((msg) => {
      // Forward native host telemetry to any listening popup connections
      console.log(`[${EXTENSION_NAME}] Native host:`, msg.event, msg);
      if (msg.event === "FINISHED" || msg.event === "ERROR" || msg.event === "PROGRESS" || msg.event === "STARTED") {
        downloadStatus.set(msg.url || "unknown", msg);
        // Broadcast to any popup that has a listener registered
        chrome.runtime.sendMessage({
          action: "nativeEvent",
          event: msg.event,
          data: msg,
        }).catch(() => {}); // popup might not be open
      }
    });
    nativePort.onDisconnect.addListener(() => {
      console.log(`[${EXTENSION_NAME}] Native host disconnected`);
      if (chrome.runtime.lastError) {
        console.warn(`[${EXTENSION_NAME}] Disconnect error:`, chrome.runtime.lastError.message);
      }
      nativePort = null;
    });
  } catch (err) {
    console.error(`[${EXTENSION_NAME}] Failed to connect native host:`, err);
    nativePort = null;
  }
  return nativePort;
}

function sendToNative(payload) {
  const port = getNativePort();
  if (!port) {
    console.error(`[${EXTENSION_NAME}] No native port available`);
    return false;
  }
  try {
    port.postMessage(payload);
    return true;
  } catch (err) {
    console.error(`[${EXTENSION_NAME}] Native postMessage failed:`, err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER — communication with popup.js
// ═══════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    // Get captured video for a tab
    if (message.action === "getCapturedVideo") {
      const entry = capturedVideos.get(message.tabId) || null;
      sendResponse({ video: entry });
      return;
    }

    // Get all captured videos
    if (message.action === "getAllCapturedVideos") {
      const snapshot = Array.from(capturedVideos.entries()).map(([tabId, entry]) => ({
        tabId,
        ...entry,
      }));
      sendResponse({ videos: snapshot });
      return;
    }

    // Trigger download via native bridge
    if (message.action === "triggerDownload") {
      const tabId = message.tabId;
      const entry = capturedVideos.get(tabId);
      if (!entry) {
        sendResponse({ error: "No captured video for this tab" });
        return;
      }

      const payload = {
        action: "execute_download",
        url: entry.detectedUrl,
        request_headers: entry.requestHeaders || {},
        output_dir: message.outputDir || undefined,
      };

      const sent = sendToNative(payload);
      if (sent) {
        sendResponse({ event: "DISPATCHED", url: entry.detectedUrl });
      } else {
        sendResponse({ event: "ERROR", error: "Failed to connect to native host. Is engine.py installed?" });
      }
      return;
    }

    // Ping native host to check availability
    if (message.action === "pingNative") {
      const sent = sendToNative({ action: "ping" });
      if (!sent) {
        sendResponse({ event: "ERROR", error: "Native host not available" });
      } else {
        sendResponse({ event: "pong_sent" });
      }
      return;
    }

    // Query download status
    if (message.action === "getDownloadStatus") {
      const status = downloadStatus.get(message.url) || null;
      sendResponse({ status });
      return;
    }

    // Manual URL injection
    if (message.action === "injectManualUrl") {
      const tabId = message.tabId;
      const url = message.url;
      const label = message.label || "Manual Entry";
      await captureUrl(tabId, url, label);
      sendResponse({ success: true });
      return;
    }

    // Clear capture for a tab
    if (message.action === "clearCapture") {
      const tabId = message.tabId;
      capturedVideos.delete(tabId);
      try { chrome.action.setBadgeText({ text: "", tabId }); } catch {}
      await saveToStorage();
      sendResponse({ success: true });
      return;
    }

    sendResponse({ error: "Unknown action" });
  })();
  return true; // keep channel open for async response
});

// ─── Cleanup on tab close ─────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (capturedVideos.has(tabId)) {
    capturedVideos.delete(tabId);
    await saveToStorage();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────
loadFromStorage();
console.log(`[${EXTENSION_NAME}] v2.0 loaded. Sniffing streams on *.skool.com`);
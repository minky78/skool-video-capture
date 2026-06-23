// ═══════════════════════════════════════════════════════════════════════════
//  Skool Video Capture — Background Service Worker (v1.1)
//  Network sniffer that monitors requests on *.skool.com tabs.
//  Detects HLS streams (m3u8), video fragments (ts, mp4 segments),
//  and third-party platform embeds (Loom, Vimeo, Wistia, YouTube).
//  ⚡ Fully client-side. No external servers. No accounts.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Config ───────────────────────────────────────────────────────────────
const EXTENSION_NAME = "Skool Video Capture";
const STORAGE_KEY = "capturedVideos";
const POISON_EXPIRY_MS = 30 * 60 * 1000;  // 30 min (extended from 5)
const GC_INTERVAL_MS = 2 * 60 * 1000;     // 2 min

// ─── Captured video registry ──────────────────────────────────────────────
// In-memory cache, backed by chrome.storage.local for SW persistence.
// Keyed by tabId → { detectedUrl, sourceLabel, detectedAt, host }
let capturedVideos = new Map();

// Load persisted state on SW startup
async function loadFromStorage() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data[STORAGE_KEY]) {
      const entries = JSON.parse(data[STORAGE_KEY]);
      // Purge expired entries on load
      const now = Date.now();
      for (const [tabIdStr, entry] of Object.entries(entries)) {
        if (now - entry.detectedAt < POISON_EXPIRY_MS) {
          capturedVideos.set(parseInt(tabIdStr, 10), entry);
        }
      }
      console.log(`[${EXTENSION_NAME}] Restored ${capturedVideos.size} captured URLs from storage`);
    }
  } catch (err) {
    console.warn(`[${EXTENSION_NAME}] Failed to load from storage:`, err);
  }
}

// Persist current state to chrome.storage.local
async function saveToStorage() {
  try {
    const obj = {};
    for (const [tabId, entry] of capturedVideos) {
      obj[String(tabId)] = entry;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: JSON.stringify(obj) });
  } catch (err) {
    console.warn(`[${EXTENSION_NAME}] Failed to save to storage:`, err);
  }
}

// ─── Stream detection heuristics ──────────────────────────────────────────
const STREAM_PATTERNS = [
  // Native S3 / signed HLS (used heavily by Skool's own video player)
  { test: /\.m3u8(\?|$)/i,        label: "HLS Stream (.m3u8)" },

  // Video fragments (.ts, .m4s) — when we see one we try to derive the parent m3u8
  { test: /\.ts(\?|$)/i,          label: "Video Segment (.ts)" },
  { test: /\.m4s(\?|$)/i,         label: "Video Segment (.m4s)" },

  // Direct MP4 or WebM video files
  { test: /\.(mp4|webm)(\?|$)/i,  label: "Direct Video File" },

  // Loom: loom.com or cdn.loom.com video manifests
  { test: /loom/i,                label: "Loom Video" },

  // Vimeo: various CDN + api endpoints (play.m.vimeo.com, vimeocdn.com)
  { test: /vimeo/i,               label: "Vimeo Video" },

  // Wistia: fast.wistia.net, embed fast.wistia.com
  { test: /wistia/i,              label: "Wistia Video" },

  // YouTube: googlevideo.com is the actual CDN; www.youtube.com for embed pages
  { test: /googlevideo/i,         label: "YouTube Stream" },

  // Cloudflare Stream
  { test: /cloudflarestream/i,    label: "Cloudflare Stream" },
];

// ─── Safe URL normalisation ───────────────────────────────────────────────
// Only strips cache-busting params that are NOT auth tokens.
// Skool/S3 signed URLs use params like X-Amz-Signature, Expires, etc.
// — we must NEVER strip those.
function normaliseUrl(urlStr) {
  try {
    const u = new URL(urlStr);

    // Only strip known cache-busting params that are safe to remove.
    // Do NOT strip params containing auth tokens (Signature, Expires, Policy, KeyPairId, token)
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

// ─── Best effort: guess the m3u8 parent from a .ts/.m4s URL ──────────────
function guessHlsPlaylistUrl(segmentUrl) {
  try {
    const u = new URL(segmentUrl);
    const path = u.pathname;
    const base = path.substring(0, path.lastIndexOf('/'));
    const candidates = ["index.m3u8", "master.m3u8", "playlist.m3u8", "manifest.m3u8"];
    return candidates.map(c => {
      const guess = new URL(u.origin + base + "/" + c);
      return guess.href;
    });
  } catch {
    return [];
  }
}

// ─── Store a captured URL in the registry ────────────────────────────────
async function captureUrl(tabId, url, label) {
  const normalised = normaliseUrl(url);
  const existing = capturedVideos.get(tabId);

  // Prefer m3u8 over .ts — if we already have an m3u8, don't clobber with a segment
  if (existing) {
    const existingIsBetter = /\.m3u8/i.test(existing.detectedUrl);
    const incomingIsTs = /\.(ts|m4s)/i.test(normalised);
    if (existingIsBetter && incomingIsTs) {
      return;  // keep the playlist, discard the segment
    }
    // But if we only had a .ts and now we get the parent m3u8, upgrade
    const incomingIsBetter = /\.m3u8/i.test(normalised);
    if (incomingIsBetter && !existingIsBetter) {
      // upgrade — fall through to overwrite
    } else {
      return;  // no-change
    }
  }

  capturedVideos.set(tabId, {
    detectedUrl: normalised,
    sourceLabel: label,
    detectedAt: Date.now(),
    host: extractHost(normalised),
  });

  // Update the extension badge to show "1" video captured
  try {
    chrome.action.setBadgeText({ text: "1", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50", tabId });
  } catch (err) {
    // tabId may be invalid — non-fatal
  }

  // Persist to survive SW restarts
  await saveToStorage();

  console.log(`[${EXTENSION_NAME}] Captured on tab ${tabId}: ${label} — ${normalised}`);
}

function extractHost(urlStr) {
  try { return new URL(urlStr).hostname; } catch { return "unknown"; }
}

// ─── Garbage collector: purge stale entries periodically ─────────────────
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
//  WEB REQUEST LISTENER — the core sniffer
// ═══════════════════════════════════════════════════════════════════════════

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Tab ID must be valid (main frame requests have tabId -1 sometimes)
    const tabId = details.tabId;
    if (tabId < 0) return;

    const url = details.url;

    // Check against all known stream patterns
    for (const pattern of STREAM_PATTERNS) {
      if (pattern.test.test(url)) {
        captureUrl(tabId, url, pattern.label);
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
  ["requestBody"]
);

// ─── Message handler: popup → background communication ───────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle async responses properly
  (async () => {
    if (message.action === "getCapturedVideo") {
      const tabId = message.tabId;
      const entry = capturedVideos.get(tabId) || null;
      sendResponse({ video: entry });
      return;
    }

    if (message.action === "getAllCapturedVideos") {
      // Return a snapshot (array) for the popup to display
      const snapshot = Array.from(capturedVideos.entries()).map(([tabId, entry]) => ({
        tabId,
        ...entry,
      }));
      sendResponse({ videos: snapshot });
      return;
    }

    // Manual injection: user pasted a URL in the popup — store it
    if (message.action === "injectManualUrl") {
      const tabId = message.tabId;
      const url = message.url;
      const label = message.label || "Manual Entry";
      await captureUrl(tabId, url, label);
      sendResponse({ success: true });
      return;
    }

    // Clear captured video for a tab
    if (message.action === "clearCapture") {
      const tabId = message.tabId;
      capturedVideos.delete(tabId);
      try { chrome.action.setBadgeText({ text: "", tabId }); } catch {}
      await saveToStorage();
      sendResponse({ success: true });
      return;
    }

    // Copy URL to clipboard (fallback for when popup navigator.clipboard isn't available)
    if (message.action === "copyToClipboard") {
      try {
        await navigator.clipboard.writeText(message.url);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return;
    }

    sendResponse({ error: "Unknown action" });
  })();

  return true;  // keep channel open for async sendResponse
});

// ─── Cleanup: when a tab closes, remove its entry ─────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (capturedVideos.has(tabId)) {
    capturedVideos.delete(tabId);
    await saveToStorage();
  }
});

// ─── Initialize: load persisted state ─────────────────────────────────────
loadFromStorage();

console.log(`[${EXTENSION_NAME}] Service worker loaded. Sniffing for streams on *.skool.com`);

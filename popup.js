// ═══════════════════════════════════════════════════════════════════════════
//  Skool Video Capture — Popup Script (v1.1)
//  Talks to the background service worker to fetch captured stream URLs
//  and triggers chrome.downloads.download for MP4 files.
//  For HLS streams, provides Copy URL for use with yt-dlp/ffmpeg.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  // ─── DOM refs ───────────────────────────────────────────────────────────
  const statusDot       = document.getElementById("statusDot");
  const captureDisplay  = document.getElementById("captureDisplay");
  const tabInfo         = document.getElementById("tabInfo");
  const captureTime     = document.getElementById("captureTime");
  const manualUrl       = document.getElementById("manualUrl");
  const manualInjectBtn = document.getElementById("manualInjectBtn");
  const toast           = document.getElementById("toast");

  let currentTabId = null;
  let toastTimer   = null;

  // ─── Toast helper ───────────────────────────────────────────────────────
  function showToast(msg, isError = false) {
    toast.textContent = msg;
    toast.classList.toggle("error", isError);
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
  }

  // ─── Get the active tab ─────────────────────────────────────────────────
  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  // ─── Format timestamp ───────────────────────────────────────────────────
  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // ─── Derive filename from URL ───────────────────────────────────────────
  function deriveFilename(url) {
    try {
      const u = new URL(url);
      const path = u.pathname;
      // Grab the last path segment
      let name = path.split("/").filter(Boolean).pop() || "skool-video";
      // Remove query params if any snuck in
      name = name.split("?")[0];
      // If it's an m3u8, rename to .mp4 so download is playable
      if (name.endsWith(".m3u8")) {
        name = name.replace(/\.m3u8$/i, ".mp4");
      }
      // Ensure we have an extension
      if (!/\.(mp4|webm|mkv|avi|mov|ts)$/i.test(name)) {
        name += ".mp4";
      }
      return name;
    } catch {
      return "skool-video.mp4";
    }
  }

  // ─── Copy URL to clipboard ──────────────────────────────────────────────
  async function copyUrlToClipboard(url) {
    try {
      await navigator.clipboard.writeText(url);
      showToast("📋 URL copied to clipboard", false);
    } catch (err) {
      // Fallback: ask background to copy
      try {
        const resp = await chrome.runtime.sendMessage({
          action: "copyToClipboard",
          url: url,
        });
        if (resp?.success) {
          showToast("📋 URL copied to clipboard", false);
        } else {
          showToast("❌ Copy failed — select the URL text manually", true);
        }
      } catch (err2) {
        showToast("❌ Copy failed: " + err2.message, true);
      }
    }
  }

  // ─── Trigger download via chrome.downloads.download ────────────────────
  async function triggerDownload(url, label) {
    try {
      const filename = deriveFilename(url);
      const isHls = /\.m3u8/i.test(url);

      console.log(`[Popup] Downloading: ${url}`);
      console.log(`[Popup] Filename: ${filename}`);

      if (isHls) {
        // chrome.downloads can't download HLS playlists as video.
        // Instead of saving a useless .m3u8 text file, copy the URL
        // and show the user how to download with yt-dlp.
        await copyUrlToClipboard(url);
        showToast(
          "📋 HLS URL copied. Use yt-dlp or ffmpeg to download (see hint below).",
          false
        );
        return;
      }

      await chrome.downloads.download({
        url: url,
        filename: filename,
        conflictAction: "uniquify",
        saveAs: false,
      });

      showToast(`⬇️ Downloading ${filename}`, false);

      // Clear badge after download
      if (currentTabId) {
        chrome.action.setBadgeText({ text: "", tabId: currentTabId });
      }

    } catch (err) {
      console.error("[Popup] Download failed:", err);
      showToast(`❌ Download failed: ${err.message}`, true);
    }
  }

  // ─── Render the captured video card ─────────────────────────────────────
  function renderVideo(entry) {
    if (!entry) {
      captureDisplay.innerHTML = `
        <div class="empty-state">
          <div class="icon">🎬</div>
          <p>Open a Skool course and play a video.<br>
          Stream URLs are captured automatically.</p>
        </div>
      `;
      statusDot.className = "status-dot idle";
      captureTime.textContent = "";
      return;
    }

    const url = entry.detectedUrl;
    const label = entry.sourceLabel;
    const host = entry.host;
    const time = entry.detectedAt;
    const isHls = /\.m3u8/i.test(url);

    const downloadBtnText = isHls ? "📋 Copy HLS URL" : "⬇ Download MP4";

    captureDisplay.innerHTML = `
      <div class="video-card">
        <div class="source-tag">${escapeHtml(label)}</div>
        <div class="host-label">Host: ${escapeHtml(host)}</div>
        <div class="url-display" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
        <button class="btn btn-primary" id="downloadBtn">
          ${downloadBtnText}
        </button>
        <button class="btn btn-secondary" id="copyBtn" style="margin-top:6px;">
          📋 Copy URL
        </button>
        <button class="btn btn-danger" id="clearBtn" style="margin-top:6px;">
          ✕ Clear
        </button>
        ${isHls ? `
          <div class="hint-box" style="margin-top:8px;font-size:11px;color:var(--text-dim);background:rgba(0,0,0,0.3);padding:8px;border-radius:4px;">
            <strong>HLS stream detected.</strong><br>
            yt-dlp -o video.mp4 "${escapeHtml(url)}"<br>
            or: ffmpeg -i "${escapeHtml(url)}" -c copy video.mp4
          </div>
        ` : ''}
      </div>
    `;

    statusDot.className = "status-dot";
    captureTime.textContent = `Captured ${formatTime(time)}`;

    // Wire up download/copy button
    document.getElementById("downloadBtn").addEventListener("click", () => {
      triggerDownload(url, label);
    });

    // Wire up copy URL button
    document.getElementById("copyBtn").addEventListener("click", () => {
      copyUrlToClipboard(url);
    });

    // Wire up clear button
    document.getElementById("clearBtn").addEventListener("click", async () => {
      if (currentTabId) {
        try {
          await chrome.runtime.sendMessage({
            action: "clearCapture",
            tabId: currentTabId,
          });
        } catch (err) {
          // non-fatal
        }
        renderVideo(null);
        showToast("Cleared capture", false);
      }
    });
  }

  // ─── Simple HTML escape ────────────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Refresh from background ────────────────────────────────────────────
  async function refresh() {
    const tab = await getActiveTab();
    if (!tab) {
      tabInfo.textContent = "No active tab";
      renderVideo(null);
      return;
    }

    currentTabId = tab.id;

    const isSkoolUrl = tab.url && tab.url.includes("skool.com");
    tabInfo.textContent = isSkoolUrl
      ? `Tab: ${currentTabId} — ${tab.title?.substring(0, 40) || "Skool"}`
      : `Tab: ${currentTabId} — not a Skool page`;

    try {
      const resp = await chrome.runtime.sendMessage({
        action: "getCapturedVideo",
        tabId: currentTabId,
      });
      renderVideo(resp?.video || null);

      if (resp?.video) {
        tabInfo.textContent = `Tab: ${currentTabId} — video found`;
      }
    } catch (err) {
      // Service worker might not be ready yet
      console.warn("[Popup] Could not reach background:", err);
      renderVideo(null);
    }
  }

  // ─── Manual URL injection ───────────────────────────────────────────────
  manualUrl.addEventListener("input", () => {
    const val = manualUrl.value.trim();
    manualInjectBtn.disabled = val.length === 0 || !val.startsWith("http");
  });

  manualInjectBtn.addEventListener("click", async () => {
    const url = manualUrl.value.trim();
    if (!url) return;

    // Crude but effective label detection
    let label = "Manual Entry";
    if (/\.m3u8/i.test(url)) label = "Manual HLS (.m3u8)";
    else if (/\.mp4/i.test(url)) label = "Manual MP4";
    else if (/\.webm/i.test(url)) label = "Manual WebM";
    else if (/vimeo/i.test(url)) label = "Vimeo Video";
    else if (/loom/i.test(url)) label = "Loom Video";
    else if (/wistia/i.test(url)) label = "Wistia Video";
    else if (/googlevideo/i.test(url)) label = "YouTube Stream";

    try {
      await chrome.runtime.sendMessage({
        action: "injectManualUrl",
        tabId: currentTabId,
        url: url,
        label: label,
      });
      manualUrl.value = "";
      manualInjectBtn.disabled = true;
      showToast(`✅ Tracked: ${label}`, false);
      await refresh();
    } catch (err) {
      showToast(`❌ Error: ${err.message}`, true);
    }
  });

  // Enter key in manual URL field = inject
  manualUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !manualInjectBtn.disabled) {
      manualInjectBtn.click();
    }
  });

  // ─── Init ───────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", refresh);

  // Also refresh manually in case the popup stays open while user switches tabs
  // (chrome auto-closes popup on tab switch, but just in case)
})();

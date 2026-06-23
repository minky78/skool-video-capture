// ═══════════════════════════════════════════════════════════════════════════
//  Skool Video Capture — Popup Script (v2.0)
//  Displays captured video, triggers native bridge download via background,
//  and shows real-time progress from the yt-dlp native host.
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

  // ─── Copy URL to clipboard ──────────────────────────────────────────────
  async function copyUrlToClipboard(url) {
    try {
      await navigator.clipboard.writeText(url);
      showToast("📋 URL copied to clipboard", false);
    } catch (err) {
      try {
        const resp = await chrome.runtime.sendMessage({ action: "copyToClipboard", url });
        if (resp?.success) showToast("📋 URL copied to clipboard", false);
        else showToast("❌ Copy failed", true);
      } catch {
        showToast("❌ Copy failed", true);
      }
    }
  }

  // ─── Trigger download via native bridge ─────────────────────────────────
  async function triggerDownload(url, label) {
    try {
      const resp = await chrome.runtime.sendMessage({
        action: "triggerDownload",
        tabId: currentTabId,
        url: url,
      });

      if (resp?.event === "DISPATCHED") {
        showToast(`✅ yt-dlp started — check your Downloads folder`, false);
      } else if (resp?.event === "ERROR") {
        showToast(`❌ ${resp.error}`, true);
      } else {
        showToast("❌ Download failed to start", true);
      }
    } catch (err) {
      console.error("[Popup] triggerDownload error:", err);
      showToast(`❌ ${err.message}`, true);
    }
  }

  // ─── Check if native bridge is available ────────────────────────────────
  async function checkNativeBridge() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: "pingNative" });
      return resp?.event === "pong_sent" || resp?.event === "pong";
    } catch {
      return false;
    }
  }

  // ─── Render the captured video card ─────────────────────────────────────
  function renderVideo(entry, nativeAvailable) {
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

    const downloadDisabled = !nativeAvailable ? "disabled" : "";
    const downloadTooltip = !nativeAvailable ? "title='Native host not installed. See README.'" : "";

    captureDisplay.innerHTML = `
      <div class="video-card">
        <div class="source-tag">${escapeHtml(label)}</div>
        <div class="host-label">Host: ${escapeHtml(host)}</div>
        <div class="url-display" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
        <button class="btn btn-primary" id="downloadBtn" ${downloadDisabled} ${downloadTooltip}>
          ⬇ Download with yt-dlp
        </button>
        <button class="btn btn-secondary" id="copyBtn" style="margin-top:6px;">
          📋 Copy URL
        </button>
        <button class="btn btn-danger" id="clearBtn" style="margin-top:6px;">
          ✕ Clear
        </button>
        ${!nativeAvailable ? `
          <div class="hint-box" style="margin-top:8px;font-size:11px;color:var(--text-dim);background:rgba(0,0,0,0.3);padding:8px;border-radius:4px;">
            <strong>Native host not detected.</strong><br>
            Run <code>native-bridge\\install-host.ps1</code> as Admin.<br>
            Or copy the URL and use yt-dlp manually.
          </div>
        ` : ''}
        ${isHls && nativeAvailable ? `
          <div class="hint-box" style="margin-top:8px;font-size:11px;color:var(--text-dim);background:rgba(0,0,0,0.3);padding:8px;border-radius:4px;">
            <strong>HLS stream</strong> — yt-dlp will download and merge.
          </div>
        ` : ''}
      </div>
    `;

    statusDot.className = "status-dot";
    captureTime.textContent = `Captured ${formatTime(time)}`;

    document.getElementById("downloadBtn").addEventListener("click", () => {
      triggerDownload(url, label);
    });
    document.getElementById("copyBtn").addEventListener("click", () => {
      copyUrlToClipboard(url);
    });
    document.getElementById("clearBtn").addEventListener("click", async () => {
      if (currentTabId) {
        try { await chrome.runtime.sendMessage({ action: "clearCapture", tabId: currentTabId }); } catch {}
        renderVideo(null, nativeAvailable);
        showToast("Cleared capture", false);
      }
    });
  }

  // ─── Simple HTML escape ────────────────────────────────────────────────
  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ─── Refresh from background ────────────────────────────────────────────
  async function refresh() {
    const tab = await getActiveTab();
    if (!tab) {
      tabInfo.textContent = "No active tab";
      renderVideo(null, false);
      return;
    }

    currentTabId = tab.id;

    const isSkoolUrl = tab.url && tab.url.includes("skool.com");
    tabInfo.textContent = isSkoolUrl
      ? `Tab: ${currentTabId} — ${tab.title?.substring(0, 40) || "Skool"}`
      : `Tab: ${currentTabId} — not a Skool page`;

    // Check native bridge availability
    const nativeAvailable = await checkNativeBridge();

    try {
      const resp = await chrome.runtime.sendMessage({
        action: "getCapturedVideo",
        tabId: currentTabId,
      });
      renderVideo(resp?.video || null, nativeAvailable);
      if (resp?.video) {
        tabInfo.textContent = `Tab: ${currentTabId} — video found`;
      }
    } catch (err) {
      console.warn("[Popup] Could not reach background:", err);
      renderVideo(null, nativeAvailable);
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
        url,
        label,
      });
      manualUrl.value = "";
      manualInjectBtn.disabled = true;
      showToast(`✅ Tracked: ${label}`, false);
      await refresh();
    } catch (err) {
      showToast(`❌ Error: ${err.message}`, true);
    }
  });

  manualUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !manualInjectBtn.disabled) {
      manualInjectBtn.click();
    }
  });

  document.addEventListener("DOMContentLoaded", refresh);
})();
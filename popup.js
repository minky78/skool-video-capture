// ═══════════════════════════════════════════════════════════════════════════
//  Skool Video Capture — Popup Script (v3.0)
//  Per-platform detection display + quality selection + download manager.
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
  const dlManager       = document.getElementById("dlManager");
  const dlManagerSection= document.getElementById("dlManagerSection");

  let currentTabId = null;
  let toastTimer   = null;
  let currentEntry = null;

  // ─── Toast helper ───────────────────────────────────────────────────────
  function showToast(msg, isError = false) {
    toast.textContent = msg;
    toast.classList.toggle("error", isError);
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
  }

  // ─── Tab ────────────────────────────────────────────────────────────────
  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  // ─── Time formatting ────────────────────────────────────────────────────
  function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", second:"2-digit" }); }
  function formatEta(s) {
    if (!s || s <= 0) return "--:--";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m ${sec}s`;
  }
  function formatSpeed(mbps) {
    if (!mbps) return "--";
    return mbps >= 1 ? `${mbps.toFixed(1)} Mbps` : `${(mbps*1000).toFixed(0)} Kbps`;
  }

  // ─── HTML escape ────────────────────────────────────────────────────────
  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ─── Platform badge class ───────────────────────────────────────────────
  function platformClass(platform) {
    const p = (platform || "").toLowerCase();
    if (p === "skool") return "skool";
    if (p === "loom") return "loom";
    if (p === "vimeo") return "vimeo";
    if (p === "wistia") return "wistia";
    if (p === "youtube") return "youtube";
    return "other";
  }

  // ─── Quality label from pattern ─────────────────────────────────────────
  function qualityLabel(label) {
    const l = (label || "").toLowerCase();
    if (l.includes("best")) return "🎥 Best Quality (auto)";
    if (l.includes("1080")) return "📺 1080p";
    if (l.includes("720")) return "📺 720p";
    if (l.includes("480")) return "📺 480p";
    if (l.includes("360")) return "📺 360p";
    return "🎥 Auto Select";
  }

  // ─── Download trigger ───────────────────────────────────────────────────
  async function triggerDownload(url, quality) {
    try {
      const resp = await chrome.runtime.sendMessage({
        action: "triggerDownload",
        tabId: currentTabId,
        quality: quality || "best",
      });
      if (resp?.event === "DISPATCHED") {
        showToast("✅ Download dispatched — check Download Manager");
        renderDownloadManager();
      } else if (resp?.error) {
        showToast(`❌ ${resp.error}`, true);
      } else {
        showToast("❌ Download failed to start", true);
      }
    } catch (err) {
      showToast(`❌ ${err.message}`, true);
    }
  }

  // ─── Copy URL ───────────────────────────────────────────────────────────
  async function copyUrl(url) {
    try {
      await navigator.clipboard.writeText(url);
      showToast("📋 URL copied to clipboard");
    } catch {
      showToast("❌ Copy failed", true);
    }
  }

  // ─── Check native bridge ────────────────────────────────────────────────
  async function checkNative() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: "pingNative" });
      return resp?.event === "pong_sent";
    } catch { return false; }
  }

  // ─── Render download manager ────────────────────────────────────────────
  async function renderDownloadManager() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: "getDownloadQueue" });
      const queue = resp?.queue || [];

      if (queue.length === 0) {
        dlManagerSection.style.display = "none";
        return;
      }
      dlManagerSection.style.display = "block";

      let html = "";
      for (const [url, status] of queue) {
        const pct = status.progress?.percentage || 0;
        const spd = status.progress?.speed_mbps || 0;
        const eta = status.progress?.eta_seconds || 0;
        const evt = status.progress?.event || status.status || "dispatched";
        const statusClass = evt === "FINISHED" ? "finished" : evt === "ERROR" ? "error" : "downloading";

        html += `
          <div class="dl-item">
            <div class="dl-item-header">
              <span class="dl-status ${statusClass}">${evt.toUpperCase()}</span>
              <span>${status.quality || "best"}</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill" style="width:${pct}%"></div>
            </div>
            <div class="progress-meta">
              <span>${pct.toFixed(1)}%</span>
              <span>${formatSpeed(spd)}</span>
              <span>ETA: ${formatEta(eta)}</span>
            </div>
            <button class="btn btn-danger" style="font-size:10px;padding:4px 8px;margin-top:4px;"
              onclick="cancelDownload('${esc(url)}')">✕ Cancel</button>
          </div>`;
      }
      dlManager.innerHTML = html;
    } catch (err) {
      /* non-fatal */
    }
  }

  // ─── Render video card ──────────────────────────────────────────────────
  function renderVideo(entry, nativeOk) {
    currentEntry = entry;
    if (!entry) {
      captureDisplay.innerHTML = `
        <div class="empty-state">
          <div class="icon">🎬</div>
          <p>Open a Skool course and play a video.<br>Metadata is detected automatically.</p>
        </div>`;
      statusDot.className = "status-dot idle";
      captureTime.textContent = "";
      return;
    }

    const meta = entry.pageMetadata || {};
    const platform = meta.platform || "";
    const title = meta.title || entry.sourceLabel || "Unknown Video";
    const url = entry.detectedUrl;
    const host = entry.host;
    const time = entry.detectedAt;
    const isHls = /\.m3u8/i.test(url);
    const isMpd = /\.mpd/i.test(url);
    const needsYtdlp = isHls || isMpd;

    statusDot.className = `status-dot ${nativeOk ? "active" : "idle"}`;
    captureTime.textContent = `Captured ${formatTime(time)}`;

    captureDisplay.innerHTML = `
      <div class="video-card">
        <span class="platform-badge ${platformClass(platform)}">${platform || entry.sourceLabel}</span>
        <div class="video-title" title="${esc(title)}">${esc(title)}</div>
        <div class="host-label">${esc(host)}</div>

        <div class="quality-row">
          <select id="qualitySelect">
            <option value="best">${qualityLabel("best")}</option>
            <option value="bestvideo+bestaudio">${qualityLabel("1080")}</option>
            <option value="720p">${qualityLabel("720")}</option>
            <option value="480p">${qualityLabel("480")}</option>
          </select>
        </div>

        ${needsYtdlp ? `
          <div style="font-size:10px;color:var(--warning);margin-bottom:6px;background:rgba(255,152,0,0.1);padding:4px 8px;border-radius:4px;">
            ⚡ ${isHls ? "HLS" : "DASH"} stream — requires yt-dlp. Click Copy yt-dlp or Download.
          </div>
        ` : ''}

        <div class="btn-row">
          <button class="btn btn-primary" id="downloadBtn" ${nativeOk ? "" : "disabled"}>
            ${nativeOk ? "⬇ Download" : "Native host offline"}
          </button>
          <button class="btn btn-copy" id="copyBtn">📋 Copy URL</button>
        </div>
        <div class="btn-row" style="margin-top:4px;">
          <button class="btn btn-secondary" id="copyCmdBtn">📋 Copy yt-dlp Command</button>
          <button class="btn btn-danger" id="clearBtn">✕ Clear</button>
        </div>
      </div>`;

    // Wire up buttons
    document.getElementById("downloadBtn").addEventListener("click", () => {
      const q = document.getElementById("qualitySelect")?.value || "best";
      triggerDownload(url, q);
    });
    document.getElementById("copyBtn").addEventListener("click", () => copyUrl(url));
    document.getElementById("copyCmdBtn").addEventListener("click", () => {
      const cmd = `yt-dlp -f "bestvideo+bestaudio/best" --merge-output-format mp4 "${url}"`;
      copyUrl(cmd);
    });
    document.getElementById("clearBtn").addEventListener("click", async () => {
      if (currentTabId) {
        try { await chrome.runtime.sendMessage({ action:"clearCapture", tabId:currentTabId }); } catch {}
        renderVideo(null, nativeOk);
        showToast("Cleared");
      }
    });
  }

  // ─── Refresh ────────────────────────────────────────────────────────────
  async function refresh() {
    const tab = await getActiveTab();
    if (!tab) {
      tabInfo.textContent = "No active tab";
      renderVideo(null, false);
      return;
    }
    currentTabId = tab.id;

    const isSkool = tab.url && tab.url.includes("skool.com");
    tabInfo.textContent = isSkool
      ? `Tab: ${currentTabId} — ${(tab.title||"Skool").substring(0,40)}`
      : `Tab: ${currentTabId} — not Skool`;

    const nativeOk = await checkNative();

    try {
      const resp = await chrome.runtime.sendMessage({ action:"getCapturedVideo", tabId:currentTabId });
      renderVideo(resp?.video || null, nativeOk);
      if (resp?.video) tabInfo.textContent = `Tab: ${currentTabId} — video found`;
    } catch {
      renderVideo(null, nativeOk);
    }

    renderDownloadManager();
  }

  // ─── Manual URL injection ───────────────────────────────────────────────
  manualUrl.addEventListener("input", () => {
    manualInjectBtn.disabled = !manualUrl.value.trim().startsWith("http");
  });
  manualInjectBtn.addEventListener("click", async () => {
    const url = manualUrl.value.trim();
    if (!url) return;
    let label = "Manual Entry";
    if (/\.m3u8/i.test(url)) label = "Manual HLS"; else if (/\.mp4/i.test(url)) label = "Manual MP4";

    try {
      await chrome.runtime.sendMessage({ action:"injectManualUrl", tabId:currentTabId, url, label });
      manualUrl.value = ""; manualInjectBtn.disabled = true;
      showToast(`✅ Tracked: ${label}`);
      await refresh();
    } catch (err) { showToast(`❌ ${err.message}`, true); }
  });
  manualUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !manualInjectBtn.disabled) manualInjectBtn.click();
  });

  // ─── Listen for progress events ────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "DOWNLOAD_PROGRESS") {
      renderDownloadManager();
    }
  });

  // ─── Cancel handler (exposed globally for onclick) ──────────────────────
  window.cancelDownload = async (url) => {
    try { await chrome.runtime.sendMessage({ action:"cancelDownload", url }); } catch {}
    await renderDownloadManager();
  };

  document.addEventListener("DOMContentLoaded", refresh);
  setInterval(renderDownloadManager, 3000); // Poll download status every 3s
})();
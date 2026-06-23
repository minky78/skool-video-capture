// ═══════════════════════════════════════════════════════════════════════════
//  Skool Video Capture — Content Script (inject-main.js)
//  Injected at document_start to read video metadata from the page context.
//  Extracts: title, platform, quality options, playbackId, playbackToken.
//  No headers are spoofed — uses only the page's own publicly exposed data.
// ═══════════════════════════════════════════════════════════════════════════

(function() {
  "use strict";

  // ─── Platform detection ─────────────────────────────────────────────────
  const hostname = window.location.hostname.toLowerCase();
  const isSkool = hostname.includes("skool.com");
  const isLoom  = hostname.includes("loom.com");
  const isVimeo = hostname.includes("vimeo.com");
  const isWistia = hostname.includes("wistia.com");
  const isYouTube = hostname.includes("youtube.com") || hostname.includes("youtu.be");

  // ─── Extract Skool video from Next.js page props ────────────────────────
  function extractSkoolVideo() {
    // Priority 1: window.__NEXT_DATA__ (Next.js SSR data)
    try {
      const nd = window.__NEXT_DATA__;
      if (nd && nd.props) {
        const result = parseSkoolProps(nd.props);
        if (result) return result;
      }
    } catch(e) {}

    // Priority 2: #__NEXT_DATA__ script tag
    try {
      const el = document.querySelector("script#__NEXT_DATA__");
      if (el && el.textContent) {
        const data = JSON.parse(el.textContent);
        if (data.props) {
          const result = parseSkoolProps(data.props);
          if (result) return result;
        }
      }
    } catch(e) {}

    return null;
  }

  function parseSkoolProps(props) {
    try {
      const pp = props.pageProps;
      if (!pp) return null;

      // Native Skool video: pageProps.video with playbackId + playbackToken
      if (pp.video && pp.video.playbackId && pp.video.playbackToken) {
        const v = pp.video;
        const mod = pp.selectedModule;
        const course = pp.course || (pp.renderData && pp.renderData.course);

        // Get title from course metadata
        let title = "Skool Video";
        if (mod && course && course.children) {
          const found = findChildById(course.children, mod);
          if (found && found.course && found.course.metadata) {
            title = found.course.metadata.title || title;
          }
        }

        const m3u8Url = `https://stream.video.skool.com/${v.playbackId}.m3u8?token=${v.playbackToken}`;

        return {
          platform: "Skool",
          source: "page_props_video",
          id: v.id || v.playbackId,
          playbackId: v.playbackId,
          title: title,
          url: m3u8Url,
          duration: v.duration ? Math.round(Number(v.duration) / 1000) : null,
          pageUrl: window.location.href,
          pageTitle: document.title,
        };
      }

      return null;
    } catch(e) {
      return null;
    }
  }

  function findChildById(children, targetId) {
    for (const child of children) {
      if (child.id === targetId) return child;
      if (child.children) {
        const found = findChildById(child.children, targetId);
        if (found) return found;
      }
    }
    return null;
  }

  // ─── Extract Loom video ─────────────────────────────────────────────────
  function extractLoomVideo() {
    // Priority 1: iframe embed on skool
    const iframe = document.querySelector('iframe[src*="loom.com/embed"], iframe[src*="loom.com/share"]');
    if (iframe) {
      const match = iframe.src.match(/(?:embed|share)\/([a-f0-9]{32})/);
      if (match) {
        return {
          platform: "Loom",
          source: "iframe_embed",
          id: match[1],
          title: iframe.title || document.title || `Loom Video ${match[1]}`,
          url: `https://www.loom.com/share/${match[1]}`,
          pageUrl: window.location.href,
        };
      }
    }

    // Priority 2: video element with data-loom-video-id
    const videoEl = document.querySelector('video[data-loom-video-id]');
    if (videoEl) {
      const id = videoEl.getAttribute("data-loom-video-id");
      if (id && id.length === 32) {
        return {
          platform: "Loom",
          source: "video_element",
          id: id,
          title: videoEl.title || `Loom Video ${id}`,
          url: `https://www.loom.com/share/${id}`,
          pageUrl: window.location.href,
        };
      }
    }

    return null;
  }

  // ─── Extract Vimeo video ────────────────────────────────────────────────
  function extractVimeoVideo() {
    // Priority 1: window.playerConfig
    try {
      if (window.playerConfig && window.playerConfig.video && window.playerConfig.video.id) {
        const pc = window.playerConfig;
        return {
          platform: "Vimeo",
          source: "player_config",
          id: String(pc.video.id),
          title: pc.video.title || `Vimeo Video ${pc.video.id}`,
          url: `https://vimeo.com/${pc.video.id}`,
          duration: pc.video.duration || null,
          pageUrl: window.location.href,
        };
      }
    } catch(e) {}

    // Priority 2: iframe embed
    const iframe = document.querySelector('iframe[src*="player.vimeo.com"], iframe[src*="vimeo.com"]');
    if (iframe) {
      const match = iframe.src.match(/video\/(\d+)/);
      if (match) {
        return {
          platform: "Vimeo",
          source: "iframe_embed",
          id: match[1],
          title: iframe.title || `Vimeo Video ${match[1]}`,
          url: `https://vimeo.com/${match[1]}`,
          pageUrl: window.location.href,
        };
      }
    }

    return null;
  }

  // ─── Extract Wistia video ───────────────────────────────────────────────
  function extractWistiaVideo() {
    // Wistia hash IDs are 10 chars, look for embedded hashes in script tags
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent || script.innerHTML || "";
      const match = text.match(/wistia_async_([a-z0-9]{10,15})/i);
      if (match) {
        const hashId = match[1];
        return {
          platform: "Wistia",
          source: "script_embed",
          id: hashId,
          title: document.title || `Wistia Video ${hashId}`,
          url: `https://fast.wistia.net/embed/iframe/${hashId}`,
          pageUrl: window.location.href,
        };
      }
    }

    // Alternative: wistia iframe
    const iframe = document.querySelector('iframe[src*="wistia.com"], iframe[src*="wistia.net"]');
    if (iframe) {
      const match = iframe.src.match(/wvideo=([a-z0-9]+)/i) || iframe.src.match(/embed\/([a-z0-9]+)/i);
      if (match) {
        return {
          platform: "Wistia",
          source: "iframe_embed",
          id: match[1],
          title: document.title || `Wistia Video ${match[1]}`,
          url: `https://fast.wistia.net/embed/iframe/${match[1]}`,
          pageUrl: window.location.href,
        };
      }
    }

    return null;
  }

  // ─── Extract YouTube video ──────────────────────────────────────────────
  function extractYouTubeVideo() {
    const iframe = document.querySelector('iframe[src*="youtube.com/embed"], iframe[src*="youtu.be"]');
    if (iframe) {
      const match = iframe.src.match(/(?:embed\/|youtu\.be\/|watch\?v=)([a-zA-Z0-9_-]{11})/);
      if (match) {
        return {
          platform: "YouTube",
          source: "iframe_embed",
          id: match[1],
          title: iframe.title || document.title || `YouTube Video ${match[1]}`,
          url: `https://www.youtube.com/watch?v=${match[1]}`,
          pageUrl: window.location.href,
        };
      }
    }
    return null;
  }

  // ─── Unified detector ───────────────────────────────────────────────────
  function detectVideo() {
    if (isSkool) {
      // Try native Skool video first, then embeds
      const skool = extractSkoolVideo();
      if (skool) return skool;
      const loom = extractLoomVideo();
      if (loom) return loom;
      const vimeo = extractVimeoVideo();
      if (vimeo) return vimeo;
      const wistia = extractWistiaVideo();
      if (wistia) return wistia;
      const yt = extractYouTubeVideo();
      if (yt) return yt;
    } else if (isLoom) {
      return extractLoomVideo();
    } else if (isVimeo) {
      return extractVimeoVideo();
    } else if (isWistia) {
      return extractWistiaVideo();
    } else if (isYouTube) {
      return extractYouTubeVideo();
    }
    return null;
  }

  // ─── Wait for page data to load, then send to extension ─────────────────
  function waitAndDetect() {
    // Give Next.js data a moment to hydrate
    const video = detectVideo();
    if (video) {
      chrome.runtime.sendMessage({
        action: "PAGE_VIDEO_DETECTED",
        video: video,
      }).catch(() => {
        // Background may not be ready yet — retry once
        setTimeout(() => {
          chrome.runtime.sendMessage({
            action: "PAGE_VIDEO_DETECTED",
            video: video,
          }).catch(() => {});
        }, 1000);
      });
    }
  }

  // Run detection once DOM is ready, then again after a delay for async data
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(waitAndDetect, 500);
      setTimeout(waitAndDetect, 2000); // retry for lazy-loaded data
    });
  } else {
    setTimeout(waitAndDetect, 500);
    setTimeout(waitAndDetect, 2000);
  }

})();
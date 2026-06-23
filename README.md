# Skool Video Capture

A Chrome extension that captures video stream URLs from Skool.com courses. Fully local — no servers, no accounts, no data leaves your browser.

## What It Does

- Monitors network requests on Skool.com pages
- Detects HLS streams (.m3u8), direct video files (.mp4, .webm), and embedded videos (Loom, Vimeo, Wistia, YouTube, Cloudflare Stream)
- Shows captured URLs in a popup
- Downloads MP4/WebM files directly via Chrome's download API
- Copies HLS stream URLs to clipboard for use with yt-dlp or ffmpeg

## Installation

1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** ON (top right)
3. Click **Load unpacked**
4. Select this folder

The green icon appears in your toolbar.

## How to Use

1. Open a Skool course page and play a video
2. Click the extension icon in your toolbar
3. The captured stream URL appears in the popup
4. Click **Download MP4** for direct video files
5. For HLS streams (.m3u8), click **Copy URL** and use one of:

```bash
# Option 1: yt-dlp (recommended)
yt-dlp -o video.mp4 "https://...m3u8"

# Option 2: ffmpeg
ffmpeg -i "https://...m3u8" -c copy video.mp4
```

## Manual Entry

If auto-capture misses a URL, paste it into the **Manual Entry** field and click **Track URL**.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension config, permissions, entry points |
| `background.js` | Service worker — network sniffer, URL capture, storage |
| `popup.html` | Popup UI |
| `popup.js` | Popup logic — display, download, copy |
| `icon-*.png` | Toolbar icons (16px, 48px, 128px) |

## Permissions Explained

| Permission | Why |
|-----------|-----|
| `webRequest` | Monitors network requests to detect video URLs |
| `downloads` | Saves captured video files to your Downloads folder |
| `activeTab` | Gets the current tab ID to associate captures |
| `storage` | Persists captured URLs across service worker restarts |
| `clipboardWrite` | Copies HLS URLs to clipboard |
| `host_permissions` | Skool.com + video CDNs (Loom, Vimeo, Wistia, etc.) |

## Troubleshooting

**No URL captured?**
- Make sure you actually clicked Play on the video
- Reload the page and try again
- Check the Chrome extension console for errors (chrome://extensions → Inspect views: service worker)

**Download fails?**
- HLS streams (.m3u8) can't be downloaded directly — use the Copy URL button + yt-dlp
- Signed URLs expire — download promptly after capturing
- Check that the URL hasn't expired (captured over 30 min ago)

**Service worker keeps dying?**
- This is normal MV3 behavior. Captured URLs are persisted to chrome.storage.local and restored on restart.

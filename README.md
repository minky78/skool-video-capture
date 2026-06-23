# Skool Video Capture (v2.0)

Chrome extension that captures video stream URLs from Skool.com courses and downloads them via **yt-dlp** through a Native Messaging bridge.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────┐
│  popup.js   │ ←─→ │ background.js│ ←─→ │ engine.py   │ ←─→ │ yt-dlp   │
│  (popup UI) │     │ (sniffer +   │     │ (native msg │     │ (download)│
│             │     │  bridge)     │     │  host)      │     │          │
└─────────────┘     └──────────────┘     └─────────────┘     └──────────┘
                                               │
                                        stdout/stdin
                                        (binary-framed JSON)
```

- The extension sniffs web requests on Skool.com and captures video URLs
- Background service worker communicates with a Python native host via `chrome.runtime.connectNative`
- The native host (`engine.py`) runs `yt-dlp` with the page's own User-Agent and Origin headers
- yt-dlp downloads HLS streams (.m3u8), MP4 files, and MPEG-DASH (.mpd) directly

## Installation

### 1. Install the extension

1. Go to `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `skool-video-capture` folder

### 2. Install the native messaging host (Windows)

1. Install Python 3 and yt-dlp:
   ```
   pip install yt-dlp
   ```

2. Open `native-bridge/com.generic_bridge.engine.json` and **edit the extension ID**:
   - Go to `chrome://extensions`
   - Find "Skool Video Capture"
   - Copy the ID (looks like `abcdefghijklmnopabcdefghijklmnop`)
   - Replace `EXTENSION_ID_PLACEHOLDER` in the JSON file

3. Open **PowerShell as Administrator** and run:
   ```
   cd native-bridge
   powershell -ExecutionPolicy Bypass -File install-host.ps1
   ```
   Paste the extension ID when prompted.

4. Reload the extension: `chrome://extensions` → click the refresh icon

### 3. Verify it works

Click the extension icon → the popup shows a green status. Open a Skool course, play a video, and the URL is captured. Click **Download with yt-dlp**.

The video saves to your Downloads folder.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension config, permissions |
| `background.js` | Service worker — sniffer + native bridge |
| `popup.html` / `popup.js` | Popup UI |
| `native-bridge/engine.py` | Native messaging host — runs yt-dlp |
| `native-bridge/engine.bat` | Windows batch wrapper for engine.py |
| `native-bridge/com.generic_bridge.engine.json` | Native messaging manifest |
| `native-bridge/install-host.ps1` | PowerShell script to register the host |

## Permissions

| Permission | Why |
|-----------|-----|
| `webRequest` | Sniff network requests to detect video URLs |
| `nativeMessaging` | Talk to engine.py to run yt-dlp |
| `storage` | Persist captured URLs across service worker restarts |
| `clipboardWrite` | Copy URLs to clipboard |

## Troubleshooting

**"Native host not detected" in popup:**
- Make sure you ran `install-host.ps1` as Administrator
- Check the extension ID in `com.generic_bridge.engine.json` matches `chrome://extensions`
- Restart Chrome and reload the extension

**yt-dlp fails:**
- Open `native-bridge/debug_bridge.log` to see error details
- Make sure yt-dlp is installed: `pip install yt-dlp`
- Test manually: `yt-dlp "URL_HERE"`

**No URL captured:**
- Click Play on the video first
- Reload the Skool page and try again
- Check the service worker console: `chrome://extensions` → Inspect views: service worker

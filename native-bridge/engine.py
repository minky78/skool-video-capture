#!/usr/bin/env python3
"""
engine.py — Generic Native Messaging host for Chromium.

Receives execute_download payloads over the Chromium Native Messaging stdio
protocol, runs yt-dlp on a background thread, parses its stdout progress
lines, and streams PROGRESS / FINISHED / ERROR JSON telemetry back to the
browser in real time.

Platform-agnostic: headers come from the request payload (the browser passes
the page's own User-Agent and Origin), not from any hardcoded third-party
values. The output directory is user-configurable via the OUTPUT_DIR constant.

Protocol: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
"""

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Dict, Optional

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HOST_DIR = Path(__file__).resolve().parent
DEBUG_LOG_PATH = HOST_DIR / "debug_bridge.log"

# Default output directory for downloads. Override via the OUTPUT_DIR env var
# or change this constant to suit your machine.
DEFAULT_OUTPUT_DIR = str(Path.home() / "Downloads")
OUTPUT_DIR = os.environ.get("BRIDGE_OUTPUT_DIR", DEFAULT_OUTPUT_DIR)

# 32-bit unsigned int length prefix = 4 bytes, little-endian.
HEADER_FORMAT = "<I"
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)
MAX_MESSAGE_BYTES = 1024 * 1024  # 1 MiB safety cap

# Serialize host writes so background-thread telemetry doesn't interleave.
_write_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log_debug(message: str) -> None:
    try:
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(f"[{timestamp}] {message}\n")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Binary-framed I/O (Chromium Native Messaging protocol)
# ---------------------------------------------------------------------------

def read_exact(num_bytes: int) -> bytes:
    buf = bytearray()
    while len(buf) < num_bytes:
        chunk = sys.stdin.buffer.read(num_bytes - len(buf))
        if not chunk:
            return bytes(buf)
        buf.extend(chunk)
    return bytes(buf)


def read_message() -> Optional[Dict[str, Any]]:
    header = read_exact(HEADER_SIZE)
    if not header or len(header) < HEADER_SIZE:
        return None

    (payload_length,) = struct.unpack(HEADER_FORMAT, header)
    if payload_length <= 0:
        return {}
    if payload_length > MAX_MESSAGE_BYTES:
        log_debug(f"Rejected oversized message: {payload_length} bytes")
        return None

    body = read_exact(payload_length)
    if not body or len(body) < payload_length:
        log_debug(
            f"Truncated body: expected {payload_length}, got {len(body) if body else 0}"
        )
        return None

    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        log_debug(f"Failed to decode JSON: {exc}")
        return None


def write_message(payload: Dict[str, Any]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    header = struct.pack(HEADER_FORMAT, len(encoded))
    with _write_lock:
        sys.stdout.buffer.write(header)
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()


# ---------------------------------------------------------------------------
# yt-dlp availability + invocation
# ---------------------------------------------------------------------------

def find_ytdlp() -> Optional[str]:
    """Locate yt-dlp on PATH. Returns the executable path or None."""
    return shutil.which("yt-dlp")


def sanitize_header_value(value: str) -> str:
    """Strip CR/LF from header values to prevent argument injection."""
    if not isinstance(value, str):
        return ""
    return re.sub(r"[\r\n]+", " ", value).strip()


def build_ytdlp_args(
    url: str,
    request_headers: Dict[str, str],
    output_dir: str,
) -> list:
    """
    Build the yt-dlp command argument list.

    Headers from the browser payload are applied via --add-header dynamically.
    The output template sends files into the user-configured directory.
    """
    args = [
        "yt-dlp",
        "--no-progress",
        "--newline",
        "--progress-template",
        "PROGRESS|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._total_bytes)s|%(progress._downloaded_bytes)s",
        "-f", "bestvideo+bestaudio/best",
        "--merge-output-format", "mp4",
        "-P", output_dir,
        "-o", "%(title)s [%(id)s].%(ext)s",
    ]

    for key, value in (request_headers or {}).items():
        clean_key = sanitize_header_value(str(key))
        clean_value = sanitize_header_value(str(value))
        if not clean_key or not clean_value:
            continue
        args.extend(["--add-header", f"{clean_key}: {clean_value}"])

    args.append(url)
    return args


# ---------------------------------------------------------------------------
# Progress line parsing
# ---------------------------------------------------------------------------

# Matches yt-dlp progress template output:
#   PROGRESS|  5.2%|1.23MiB/s|00:30|12345678|640000
_PROGRESS_RE = re.compile(
    r"PROGRESS\|\s*([\d.]+)%\|([\d.]+\w+/s|Unknown)\|([\d:]+|Unknown)\|([\d.N/A]+)\|([\d.N/A]+)"
)


def parse_progress_line(line: str) -> Optional[Dict[str, Any]]:
    """Convert a yt-dlp progress template line into a telemetry dict."""
    if not line or not line.startswith("PROGRESS|"):
        return None

    match = _PROGRESS_RE.search(line)
    if not match:
        return None

    percentage_str, speed_str, eta_str, total_str, downloaded_str = match.groups()

    try:
        percentage = float(percentage_str)
    except (TypeError, ValueError):
        percentage = 0.0

    speed_mbps = _parse_speed_to_mbps(speed_str)
    eta_seconds = _parse_eta_to_seconds(eta_str)

    return {
        "event": "PROGRESS",
        "percentage": percentage,
        "speed_mbps": speed_mbps,
        "eta_seconds": eta_seconds,
        "total_bytes": _safe_int(total_str),
        "downloaded_bytes": _safe_int(downloaded_str),
    }


def _parse_speed_to_mbps(speed_str: str) -> Optional[float]:
    if not speed_str or speed_str == "Unknown":
        return None
    m = re.match(r"([\d.]+)\s*([KMGT]?i?B)/s", speed_str, re.IGNORECASE)
    if not m:
        return None
    value = float(m.group(1))
    unit = m.group(2).upper()
    if unit in ("B",):
        return value * 8 / 1_000_000
    if unit in ("KB", "KIB"):
        return value * 8 / 1000
    if unit in ("MB", "MIB"):
        return value * 8
    if unit in ("GB", "GIB"):
        return value * 8 * 1000
    return None


def _parse_eta_to_seconds(eta_str: str) -> Optional[float]:
    if not eta_str or eta_str == "Unknown":
        return None
    parts = eta_str.split(":")
    try:
        parts = [float(p) for p in parts]
    except ValueError:
        return None
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return None


def _safe_int(s: str) -> Optional[int]:
    try:
        return int(s)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Download execution (background thread)
# ---------------------------------------------------------------------------

def run_download(
    url: str,
    request_headers: Dict[str, str],
    output_dir: str,
) -> None:
    """
    Execute yt-dlp on a background thread, streaming PROGRESS packets back
    to the browser as each progress line arrives on stdout.
    """
    ytdlp_path = find_ytdlp()
    if not ytdlp_path:
        write_message({
            "event": "ERROR",
            "error": "yt-dlp is not installed or not on PATH.",
            "url": url
        })
        return

    args = build_ytdlp_args(url, request_headers, output_dir)
    args[0] = ytdlp_path  # use absolute path for safety

    log_debug(f"Spawning: {' '.join(args)}")

    write_message({
        "event": "STARTED",
        "url": url,
        "output_dir": output_dir
    })

    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,  # line-buffered
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except Exception as exc:
        write_message({
            "event": "ERROR",
            "error": f"Failed to spawn yt-dlp: {exc}",
            "url": url
        })
        return

    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue

            progress = parse_progress_line(line)
            if progress:
                write_message(progress)
                continue

            # Non-progress lines are informational or warnings.
            if line.lower().startswith("error"):
                write_message({
                    "event": "ERROR",
                    "error": line,
                    "url": url
                })
            elif "warning" in line.lower():
                write_message({"event": "WARNING", "message": line})

        proc.wait()
        rc = proc.returncode

        if rc == 0:
            write_message({
                "event": "FINISHED",
                "url": url,
                "output_dir": output_dir,
                "return_code": rc
            })
        else:
            write_message({
                "event": "ERROR",
                "error": f"yt-dlp exited with code {rc}",
                "url": url,
                "return_code": rc
            })
    except Exception as exc:
        write_message({
            "event": "ERROR",
            "error": f"Download loop error: {exc}",
            "url": url
        })
        log_debug(f"Download loop error: {exc}\n{traceback.format_exc()}")
    finally:
        try:
            if proc.poll() is None:
                proc.terminate()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

def handle_execute_download(message: Dict[str, Any]) -> Dict[str, Any]:
    url = str(message.get("url", "")).strip()
    if not url:
        return {"event": "ERROR", "error": "Missing 'url' field."}

    if not re.match(r"^https?://", url, re.IGNORECASE):
        return {"event": "ERROR", "error": f"Invalid URL scheme: {url}"}

    request_headers = message.get("request_headers") or {}
    if not isinstance(request_headers, dict):
        request_headers = {}

    output_dir = str(message.get("output_dir") or OUTPUT_DIR)
    try:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        return {"event": "ERROR", "error": f"Bad output_dir: {exc}"}

    # Ack immediately; the long-running work happens on a background thread
    # so the main pipe loop stays free to read any follow-up messages.
    ack = {
        "event": "DISPATCHED",
        "url": url,
        "output_dir": output_dir
    }

    thread = threading.Thread(
        target=run_download,
        args=(url, request_headers, output_dir),
        daemon=True,
        name=f"ytdlp-{int(time.time())}"
    )
    thread.start()

    return ack


def handle_ping(message: Dict[str, Any]) -> Dict[str, Any]:
    ytdlp = find_ytdlp()
    return {
        "event": "pong",
        "ok": True,
        "data": {
            "receivedAt": time.time(),
            "echo": message,
            "host": "com.generic_bridge.engine",
            "python": sys.version.split()[0],
            "ytdlp_available": ytdlp is not None,
            "ytdlp_path": ytdlp,
            "output_dir": OUTPUT_DIR,
            "pid": os.getpid()
        }
    }


def handle_subscribe(message: Dict[str, Any]) -> Dict[str, Any]:
    log_debug(f"SUBSCRIBE received: {message}")
    return {
        "event": "subscribed",
        "ok": True,
        "data": {"channel": "default", "at": time.time()}
    }


# ---------------------------------------------------------------------------
# Main packet loop
# ---------------------------------------------------------------------------

def route_message(message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    action = message.get("action") or message.get("command") or ""

    if action == "execute_download":
        return handle_execute_download(message)
    if action == "ping":
        return handle_ping(message)
    if action == "subscribe":
        return handle_subscribe(message)

    log_debug(f"UNKNOWN action: {message}")
    return {
        "event": "ERROR",
        "error": f"Unknown action: {action}"
    }


def main() -> int:
    log_debug("=== Native bridge host starting ===")
    log_debug(f"PID={os.getpid()} Python={sys.version.split()[0]}")
    log_debug(f"OUTPUT_DIR={OUTPUT_DIR}")
    log_debug(f"yt-dlp on PATH: {find_ytdlp()}")

    try:
        while True:
            message = read_message()
            if message is None:
                log_debug("stdin EOF; shutting down.")
                return 0
            if not message:
                continue

            try:
                response = route_message(message)
            except Exception as exc:
                log_debug(f"Router exception: {exc}\n{traceback.format_exc()}")
                response = {
                    "event": "ERROR",
                    "error": f"Router error: {exc}"
                }

            if response is not None:
                write_message(response)

    except KeyboardInterrupt:
        log_debug("Interrupted by signal.")
        return 0
    except Exception as exc:
        log_debug(f"Fatal loop error: {exc}\n{traceback.format_exc()}")
        try:
            write_message({
                "event": "ERROR",
                "error": f"Fatal host error: {exc}"
            })
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
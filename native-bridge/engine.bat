@echo off
REM Engine.bat — Native messaging host wrapper for Windows
REM Chrome launches this batch file, which runs the Python engine.
REM
REM Requirements:
REM   - Python 3 installed and on PATH
REM   - yt-dlp installed (pip install yt-dlp)
REM   - Native messaging manifest installed (see install-host.ps1)
REM
REM This script MUST match the "path" in the native messaging manifest.
REM It does not change directory — Chrome's native messaging protocol
REM passes the working directory from the manifest.

python "%~dp0engine.py" %*
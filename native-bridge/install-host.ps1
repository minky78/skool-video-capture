# install-host.ps1
# Registers the Native Messaging host in the Windows registry.
# Run this once from an Admin PowerShell prompt.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-host.ps1

$ErrorActionPreference = "Stop"

$HostName = "com.generic_bridge.engine"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $ScriptDir "$HostName.json"

# Replace placeholder extension ID with the real one after loading unpacked.
# 1. Go to chrome://extensions
# 2. Find "Skool Video Capture"
# 3. Copy the ID (looks like: abcdefghijklmnopabcdefghijklmnop)
# 4. Run this script again
$ExtensionId = Read-Host "Enter your extension ID from chrome://extensions"

# Update the manifest JSON with the real extension ID
$manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
$manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
$manifest | ConvertTo-Json -Depth 10 | Set-Content $ManifestPath -Encoding UTF8

Write-Host "Installing Native Messaging host: $HostName"
Write-Host "Manifest: $ManifestPath"

# Chrome path
$ChromeRegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
if (-not (Test-Path $ChromeRegPath)) {
    New-Item -Path $ChromeRegPath -Force | Out-Null
}

# Edge path
$EdgeRegPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
if (-not (Test-Path $EdgeRegPath)) {
    New-Item -Path $EdgeRegPath -Force | Out-Null
}

Set-ItemProperty -Path $ChromeRegPath -Name "(Default)" -Value $ManifestPath
Set-ItemProperty -Path $EdgeRegPath -Name "(Default)" -Value $ManifestPath

Write-Host ""
Write-Host "✅ Done! Native Messaging host installed for:"
Write-Host "   HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
Write-Host "   HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
Write-Host ""
Write-Host "The manifest at $ManifestPath points to:"
Write-Host "   $($manifest.path)"
Write-Host ""
Write-Host "Make sure yt-dlp is installed: pip install yt-dlp"
Write-Host "Then reload the extension at chrome://extensions"
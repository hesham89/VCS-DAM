$ErrorActionPreference = "Stop"

$RadioIp = "192.168.1.2"
$RadioRtpPort = 3003
$ListenPort = 3004
$PreferredSourceIp = "192.168.1.10"
$LocalIp = (Get-NetIPAddress -AddressFamily IPv4 -IPAddress $PreferredSourceIp -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty IPAddress)

if (-not $LocalIp) {
  $LocalIp = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -like "192.168.1.*" -and $_.IPAddress -ne $RadioIp } |
  Select-Object -First 1 -ExpandProperty IPAddress)
}

if (-not $LocalIp) {
  Write-Host "No local 192.168.1.x interface found. Set the PC Ethernet IP first." -ForegroundColor Red
  exit 1
}

Write-Host "Local VCS test IP: $LocalIp"
Write-Host "Sending RTP PCMA test tone to $RadioIp`:$RadioRtpPort"
Write-Host "Listening for return RTP on UDP/$ListenPort"
Write-Host ""

python "$PSScriptRoot\scripts\vcs_rtp_test.py" `
  --radio-ip $RadioIp `
  --radio-rtp-port $RadioRtpPort `
  --source-ip $LocalIp `
  --listen-ip 0.0.0.0 `
  --listen-port $ListenPort `
  --payload-type 8 `
  --duration 5

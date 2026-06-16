param(
  [string]$HostIp = "10.50.0.206",
  [string]$User = "vcs",
  [string]$Password = "vcs",
  [string]$HostKey = "SHA256:TCKA/QXQ6kTLQfwJ0vPtnxcvBHEFpc+leS9L9vkwEro"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverFile = Join-Path $root "atm_vcs_server.mjs"
$plink = "C:\Program Files\PuTTY\plink.exe"
$pscp = "C:\Program Files\PuTTY\pscp.exe"

if (!(Test-Path $serverFile)) { throw "Missing $serverFile" }
if (!(Test-Path $plink)) { throw "Missing $plink" }
if (!(Test-Path $pscp)) { throw "Missing $pscp" }

Write-Host "[1/5] Checking Ubuntu SSH reachability..."
& $plink -ssh -batch -hostkey $HostKey -pw $Password "$User@$HostIp" "echo connected"

Write-Host "[2/5] Uploading fixed server file..."
& $pscp -batch -hostkey $HostKey -pw $Password $serverFile "$User@$HostIp`:/tmp/atm_vcs_server.mjs"

Write-Host "[3/5] Installing file and restarting service..."
$remote = @"
set -e
echo '$Password' | sudo -S cp /tmp/atm_vcs_server.mjs /opt/atm-vcs/atm_vcs_server.mjs
echo '$Password' | sudo -S chown atm-vcs:atm-vcs /opt/atm-vcs/atm_vcs_server.mjs
node --check /opt/atm-vcs/atm_vcs_server.mjs
echo '$Password' | sudo -S systemctl restart atm-vcs.service
sleep 2
"@
& $plink -ssh -batch -hostkey $HostKey -pw $Password "$User@$HostIp" $remote

Write-Host "[4/5] Service health..."
& $plink -ssh -batch -hostkey $HostKey -pw $Password "$User@$HostIp" "curl -k -sS https://127.0.0.1:3443/api/health || true; echo; systemctl --no-pager --full status atm-vcs.service | head -n 20"

Write-Host "[5/5] Recent media logs..."
& $plink -ssh -batch -hostkey $HostKey -pw $Password "$User@$HostIp" "tail -n 80 /opt/atm-vcs/logs/service.out.log"

Write-Host "Controller: https://$HostIp`:3443/controller"

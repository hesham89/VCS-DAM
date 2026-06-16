$ErrorActionPreference = "Stop"

$InterfaceAlias = "Ethernet"
$PrefixLength = 24
$RequiredIps = @("192.168.1.10", "192.168.1.16")

$adapter = Get-NetAdapter -Name $InterfaceAlias -ErrorAction SilentlyContinue
if (-not $adapter) {
  Write-Host "Interface '$InterfaceAlias' was not found. Edit this script if your adapter has another name." -ForegroundColor Red
  exit 1
}

foreach ($ip in $RequiredIps) {
  $existing = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $ip -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "$ip is already configured on $($existing.InterfaceAlias)"
    continue
  }

  Write-Host "Adding $ip/$PrefixLength to $InterfaceAlias"
  New-NetIPAddress -InterfaceAlias $InterfaceAlias -IPAddress $ip -PrefixLength $PrefixLength | Out-Null
}

Write-Host ""
Write-Host "Configured local VCS-side IPs:"
Get-NetIPAddress -InterfaceAlias $InterfaceAlias -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -like "192.168.1.*" } |
  Select-Object InterfaceAlias,IPAddress,PrefixLength |
  Format-Table -AutoSize

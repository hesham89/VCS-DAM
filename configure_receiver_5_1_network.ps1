$ErrorActionPreference = "Stop"

$InterfaceAlias = "Ethernet"
$RequiredIps = @(
  @{ IPAddress = "5.1.1.3"; PrefixLength = 24; Purpose = "Receiver RTP destination" },
  @{ IPAddress = "5.1.1.248"; PrefixLength = 24; Purpose = "Receiver SNMP trap destination" }
)

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "Run this script from an elevated PowerShell window: right-click PowerShell and choose Run as Administrator."
}

$adapter = Get-NetAdapter -Name $InterfaceAlias -ErrorAction Stop
if ($adapter.Status -ne "Up") {
  Write-Warning "Adapter '$InterfaceAlias' is not Up. Current status: $($adapter.Status)"
}

$existing = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $InterfaceAlias -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress
foreach ($item in $RequiredIps) {
  if ($existing -contains $item.IPAddress) {
    Write-Host "Already configured: $($item.IPAddress) - $($item.Purpose)"
    continue
  }
  New-NetIPAddress -InterfaceAlias $InterfaceAlias -IPAddress $item.IPAddress -PrefixLength $item.PrefixLength | Out-Null
  Write-Host "Added: $($item.IPAddress)/$($item.PrefixLength) - $($item.Purpose)"
}

Write-Host ""
Write-Host "Current 5.1.1.x addresses:"
Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $InterfaceAlias |
  Where-Object { $_.IPAddress -like "5.1.1.*" } |
  Select-Object IPAddress, InterfaceAlias, PrefixLength, AddressState |
  Format-Table -AutoSize

Write-Host ""
Write-Host "Testing receiver ping at 5.1.1.250..."
Test-Connection -ComputerName 5.1.1.250 -Count 2

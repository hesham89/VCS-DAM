$ErrorActionPreference = "Stop"

$Node = "C:\Users\hesha\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path $Node)) {
  $Node = "node"
}

Push-Location $PSScriptRoot
try {
  & $Node .\atm_vcs_server.mjs
}
finally {
  Pop-Location
}

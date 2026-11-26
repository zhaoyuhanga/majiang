# 一键部署到 39.106.36.10
# 用法： .\deploy.ps1 -Password "服务器root密码"
param(
  [Parameter(Mandatory = $true)][string]$Password,
  [string]$HostName = "39.106.36.10",
  [string]$User = "root",
  [string]$Plink = "C:\Program Files (x86)\PuTTY\plink.exe",
  [string]$Pscp = "C:\Program Files (x86)\PuTTY\pscp.exe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
  if (Test-Path .deploy) { Remove-Item -Recurse -Force .deploy }
  New-Item -ItemType Directory -Force .deploy\majiang | Out-Null
  Copy-Item package.json, package-lock.json -Destination .deploy\majiang
  Copy-Item -Recurse server, public -Destination .deploy\majiang
  Push-Location .deploy\majiang
  npm.cmd ci --omit=dev --no-audit --no-fund
  Pop-Location

  if (Test-Path majiang.tar.gz) { Remove-Item majiang.tar.gz }
  tar -czf majiang.tar.gz -C .deploy majiang

  & $Pscp -pw $Password majiang.tar.gz "${User}@${HostName}:/tmp/majiang.tar.gz"
  $remote = "rm -rf /opt/majiang && tar -xzf /tmp/majiang.tar.gz -C /opt && systemctl restart majiang && sleep 2 && systemctl is-active majiang && curl -s http://127.0.0.1/healthz"
  & $Plink -ssh -batch -pw $Password "${User}@${HostName}" $remote
  Write-Host "`n部署完成： http://$HostName/" -ForegroundColor Green
} finally {
  Pop-Location
}

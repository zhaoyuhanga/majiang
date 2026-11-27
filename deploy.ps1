# 一键部署到 39.106.36.10，失败时自动回滚
# 用法： .\deploy.ps1 -Password "服务器root密码"
param(
  [Parameter(Mandatory = $true)][string]$Password,
  [string]$HostName = "39.106.36.10",
  [string]$User = "root",
  [string]$AdminPassword,
  [string]$Plink = "C:\Program Files (x86)\PuTTY\plink.exe",
  [string]$Pscp = "C:\Program Files (x86)\PuTTY\pscp.exe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = (Get-Content -Encoding UTF8 (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$archive = "majiang-$stamp.tar.gz"
Push-Location $root
try {
  if (Test-Path .deploy) { Remove-Item -Recurse -Force .deploy }
  New-Item -ItemType Directory -Force .deploy\majiang | Out-Null
  Copy-Item package.json, package-lock.json -Destination .deploy\majiang
  Copy-Item -Recurse server, public -Destination .deploy\majiang
  Push-Location .deploy\majiang
  npm.cmd ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw '生产依赖安装失败' }
  Pop-Location

  tar -czf $archive -C .deploy majiang
  if ($LASTEXITCODE -ne 0) { throw '发布包创建失败' }

  $secretSource = $null
  $secretRemote = ''
  if ($PSBoundParameters.ContainsKey('AdminPassword')) {
    if ([string]::IsNullOrWhiteSpace($AdminPassword) -or $AdminPassword -match '[\r\n]') { throw '管理员口令不能为空或包含换行' }
    $secretSource = Join-Path $root ".deploy\admin-secret.txt"
    [System.IO.File]::WriteAllText($secretSource, $AdminPassword + "`n", [System.Text.UTF8Encoding]::new($false))
    $secretRemote = "/root/.majiang-admin-$stamp.txt"
    & $Pscp -pw $Password $secretSource "${User}@${HostName}:$secretRemote"
    if ($LASTEXITCODE -ne 0) { throw '管理员口令上传失败' }
    & $Plink -ssh -batch -pw $Password "${User}@${HostName}" "chmod 600 '$secretRemote'"
    if ($LASTEXITCODE -ne 0) { throw '管理员口令权限设置失败' }
  }

  & $Pscp -pw $Password $archive "${User}@${HostName}:/tmp/$archive"
  if ($LASTEXITCODE -ne 0) { throw '发布包上传失败' }

  $remote = @'
set -e
stamp=__STAMP__
version=__VERSION__
archive=/tmp/majiang-__STAMP__.tar.gz
release=/opt/majiang-release-__STAMP__
backup=/opt/majiang-backup-__STAMP__
failed=/opt/majiang-failed-__STAMP__
admin_secret_source=__ADMIN_SECRET_SOURCE__
cleanup_secret() {
  if [ -n "$admin_secret_source" ]; then rm -f "$admin_secret_source"; fi
}
trap cleanup_secret EXIT
rollback() {
  if [ -d "$backup" ]; then
    if [ -d /opt/majiang ]; then mv /opt/majiang "$failed"; fi
    mv "$backup" /opt/majiang
    systemctl restart majiang || true
    echo "部署失败，已回滚到上一版本" >&2
  fi
  exit 1
}
mkdir -p "$release"
tar -xzf "$archive" -C "$release" --strip-components=1
(cd "$release" && node --check server/index.js && node -e "require('./package.json'); require('express'); require('socket.io'); require('compression')")
mkdir -p "$release/data"
chmod 700 "$release/data"
if [ -d /opt/majiang/data ]; then cp -a /opt/majiang/data/. "$release/data/"; fi
if [ -n "$admin_secret_source" ]; then
  if [ ! -s "$admin_secret_source" ]; then echo '管理员口令文件为空' >&2; exit 1; fi
  cp "$admin_secret_source" "$release/data/admin-secret.txt"
elif [ ! -s "$release/data/admin-secret.txt" ]; then
  (cd "$release" && node -e "require('fs').writeFileSync('data/admin-secret.txt', require('crypto').randomBytes(24).toString('hex') + '\n', { mode: 0o600 })")
fi
chmod 600 "$release/data/admin-secret.txt"
cleanup_secret
admin_secret_source=
if [ -f "$release/data/users.json" ]; then chmod 600 "$release/data/users.json"; fi
systemd_dir=/etc/systemd/system/majiang.service.d
mkdir -p "$systemd_dir"
cat > "$systemd_dir/20-low-memory.conf" <<'EOF'
[Service]
Environment="NODE_OPTIONS=--max-old-space-size=1280"
ExecStart=
ExecStart=/opt/node/bin/node --optimize-for-size server/index.js
EOF
systemctl daemon-reload
if [ -d /opt/majiang ]; then mv /opt/majiang "$backup"; fi
if ! mv "$release" /opt/majiang; then rollback; fi
if ! systemctl restart majiang; then rollback; fi
ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  health=$(curl -fsS http://127.0.0.1/healthz || true)
  if printf '%s' "$health" | grep -q "\"version\":\"$version\""; then ok=1; break; fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then echo "版本健康检查失败：$health" >&2; rollback; fi
main_pid=$(systemctl show -p MainPID --value majiang)
runtime_options=$(tr '\0' '\n' < "/proc/$main_pid/environ" | grep '^NODE_OPTIONS=' || true)
case "$runtime_options" in
  *--max-old-space-size=1280*) ;;
  *) echo 'V8 老生代参数校验失败' >&2; rollback ;;
esac
if ! tr '\0' ' ' < "/proc/$main_pid/cmdline" | grep -q -- '--optimize-for-size'; then
  echo 'V8 体积优化参数校验失败' >&2
  rollback
fi
if ! systemctl is-active --quiet majiang; then rollback; fi
curl -fsS http://127.0.0.1/healthz
echo
echo "上一版本备份：$backup"
'@
  $remote = $remote.Replace('__STAMP__', $stamp).Replace('__VERSION__', $version).Replace('__ADMIN_SECRET_SOURCE__', $secretRemote)
  $remoteName = "majiang-deploy-$stamp.sh"
  $remotePath = Join-Path $root ".deploy\$remoteName"
  [System.IO.File]::WriteAllText($remotePath, $remote, [System.Text.UTF8Encoding]::new($false))
  & $Pscp -pw $Password $remotePath "${User}@${HostName}:/tmp/$remoteName"
  if ($LASTEXITCODE -ne 0) { throw '远程部署脚本上传失败' }
  & $Plink -ssh -batch -pw $Password "${User}@${HostName}" "bash -n /tmp/$remoteName && bash /tmp/$remoteName"
  if ($LASTEXITCODE -ne 0) { throw '远程部署或健康检查失败' }
  Write-Host "`n部署完成： http://$HostName/ （v$version）" -ForegroundColor Green
} finally {
  if ($secretSource -and (Test-Path $secretSource)) { Remove-Item -Force $secretSource }
  Pop-Location
}

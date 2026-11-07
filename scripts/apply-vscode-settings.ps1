# Aplica setarile de RAM pentru VS Code in ACEST repo (.vscode\settings.json).
# Ruleaza din radacina repo-ului:   powershell -ExecutionPolicy Bypass -File scripts\apply-vscode-settings.ps1
#
# De ce: node_modules are ~31k fisiere si tsconfig-ul nu are "include", deci fiecare
# fereastra VS Code tine watchers pe tot si lasa tsserver sa urce pana la 3 GB.
# Pe un sistem cu 7.5 GB total, asta e cauza restarturilor.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'package.json'))) {
  throw "Nu gasesc package.json in $root - ruleaza scriptul din radacina repo-ului."
}

$dir = Join-Path $root '.vscode'
$target = Join-Path $dir 'settings.json'

if (-not (Test-Path $dir)) {
  New-Item -ItemType Directory -Path $dir | Out-Null
  Write-Host "creat: .vscode\"
}

if (Test-Path $target) {
  $backup = "$target.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item $target $backup
  Write-Host "backup: $(Split-Path $backup -Leaf)"
}

$settings = @'
{
  "files.watcherExclude": {
    "**/node_modules/**": true,
    "**/dist/**": true,
    "**/release/**": true,
    "**/android/**": true,
    "**/.git/objects/**": true,
    "**/.data/**": true,
    "**/*.zip": true,
    "**/*.exe": true,
    "**/*.apk": true
  },
  "search.exclude": {
    "**/node_modules": true,
    "**/dist": true,
    "**/release": true,
    "**/android": true,
    "**/.data": true,
    "**/*.zip": true,
    "**/*.exe": true,
    "**/*.apk": true,
    "**/package-lock.json": true,
    "**/*.map": true
  },
  "typescript.tsserver.maxTsServerMemory": 1536,
  "typescript.disableAutomaticTypeAcquisition": true,
  "typescript.tsserver.watchOptions": {
    "watchFile": "useFsEvents",
    "watchDirectory": "useFsEvents"
  },
  "editor.minimap.enabled": false,
  "workbench.editor.limit.enabled": true,
  "workbench.editor.limit.value": 6,
  "workbench.editor.limit.perEditorGroup": true,
  "telemetry.telemetryLevel": "off",
  "git.autofetch": false
}
'@

[System.IO.File]::WriteAllText($target, $settings, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "scris: .vscode\settings.json ($([math]::Round((Get-Item $target).Length/1KB,1)) KB)"

# Raport: cat de mult conteaza fiecare setare pe repo-ul asta
$nm = if (Test-Path (Join-Path $root 'node_modules')) { (Get-ChildItem (Join-Path $root 'node_modules') -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object).Count } else { 0 }
$rel = if (Test-Path (Join-Path $root 'release')) { [math]::Round(((Get-ChildItem (Join-Path $root 'release') -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)/1MB) } else { 0 }

Write-Host ""
Write-Host "exclus de la indexare/watching:"
Write-Host ("  node_modules : {0} fisiere" -f $nm)
Write-Host ("  release      : {0} MB" -f $rel)
Write-Host ""
Write-Host "URMATORUL PAS OBLIGATORIU (altfel nu se aplica nimic):"
Write-Host "  Ctrl+Shift+P  ->  Developer: Reload Window"
Write-Host ""
Write-Host "Nota: setarile sunt per-workspace, nu globale. Nu ating configuratia altor proiecte."

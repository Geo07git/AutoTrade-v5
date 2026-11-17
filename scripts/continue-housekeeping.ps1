# continue-housekeeping.ps1
#
# Scop: reduce payload-ul care se trimite modelului la fiecare request Continue,
# ca sa dispara eroarea "Message exceeds context limit".
#
# Ce face:
#   1. backup la ~/.continue/config.yaml     -> config.yaml.bak-<timestamp>
#   2. taie lista de module MCP (--modules)  -> implicit "market,news" (~60 -> ~29 unelte)
#   3. optional: coboara contextLength pentru deepseek-reasoner (-ReasonerContextLength 64000)
#   4. muta sesiunile vechi in ~/.continue/sessions-backup  (MUTA, nu sterge nimic)
#
# Ce NU face:
#   - nu citeste, nu afiseaza si nu modifica apiKey / secrete (rescrie fisierul byte-cu-byte,
#     minus liniile tinta)
#   - nu sterge niciun fisier
#   - nu atinge build-ul, git-ul sau productia
#
# Rulare:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\continue-housekeeping.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\continue-housekeeping.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\continue-housekeeping.ps1 -Modules "market,news,swap"
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\continue-housekeeping.ps1 -MoveSessions:$false

[CmdletBinding()]
param(
    [string] $Modules = "market,news",
    [int]    $ReasonerContextLength = 0,     # 0 = nu modifica contextLength
    [bool]   $MoveSessions = $true,
    [switch] $DryRun
)

$ErrorActionPreference = "Stop"

$ContinueDir  = Join-Path $env:USERPROFILE ".continue"
$ConfigPath   = Join-Path $ContinueDir "config.yaml"
$SessionsDir  = Join-Path $ContinueDir "sessions"
$SessionsBak  = Join-Path $ContinueDir "sessions-backup"

if (-not (Test-Path $ConfigPath)) {
    throw "Nu gasesc $ConfigPath. Verifica daca Continue e instalat pentru acest utilizator."
}

Write-Host ""
Write-Host "=== Continue housekeeping ===" -ForegroundColor Cyan
if ($DryRun) { Write-Host "MOD: DRY RUN - nu se scrie nimic" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1. config.yaml
$raw = Get-Content -LiteralPath $ConfigPath -Raw

$lines = $raw -split "`r?`n"
$out   = New-Object System.Collections.Generic.List[string]

$modulesBefore = $null
$reasonerBefore = $null
$inReasoner = $false
$changed = $false

for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    $next = if ($i + 1 -lt $lines.Count) { $lines[$i + 1] } else { "" }

    # 1a. linia cu modulele MCP:  - "--modules"  urmata de  - "market,spot,..."
    if ($line -match '^\s*-\s*"--modules"\s*$' -and $next -match '^(\s*-\s*")([^"]*)("\s*)$') {
        $modulesBefore = $Matches[2]
        $out.Add($line)
        $out.Add($Matches[1] + $Modules + $Matches[3])
        $i++
        if ($modulesBefore -ne $Modules) { $changed = $true }
        continue
    }

    # 1b. contextLength pentru DeepSeek Reasoner (doar daca s-a cerut explicit)
    if ($line -match '^\s*name:\s*DeepSeek Reasoner\s*$') { $inReasoner = $true }
    if ($inReasoner -and $ReasonerContextLength -gt 0 -and $line -match '^(\s*contextLength:\s*)(\d+)(\s*)$') {
        $reasonerBefore = $Matches[2]
        $out.Add($Matches[1] + $ReasonerContextLength + $Matches[3])
        $changed = $true
        $inReasoner = $false
        continue
    }
    if ($inReasoner -and $line -match '^\s*-\s*name:') { $inReasoner = $false }

    $out.Add($line)
}

if ($null -eq $modulesBefore) {
    Write-Host "ATENTIE: nu am gasit blocul '--modules' in config.yaml - config neschimbat." -ForegroundColor Yellow
} else {
    Write-Host ("module MCP:  {0}  ->  {1}" -f $modulesBefore, $Modules)
}
if ($null -ne $reasonerBefore) {
    Write-Host ("contextLength reasoner: {0} -> {1}" -f $reasonerBefore, $ReasonerContextLength)
}

if ($changed -and -not $DryRun) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backup = "$ConfigPath.bak-$stamp"
    Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
    Write-Host "backup config:  $backup" -ForegroundColor DarkGray

    $text  = ($out -join "`n")
    $enc   = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ConfigPath, $text, $enc)
    Write-Host "config.yaml rescris (apiKey neatins)." -ForegroundColor Green
} elseif (-not $changed) {
    Write-Host "config.yaml era deja in forma dorita - nimic de scris." -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 2. sessions
if ($MoveSessions -and (Test-Path $SessionsDir)) {
    $files = Get-ChildItem -LiteralPath $SessionsDir -Filter *.json -File -ErrorAction SilentlyContinue
    if ($files.Count -eq 0) {
        Write-Host "sessions:  nimic de mutat." -ForegroundColor DarkGray
    } else {
        $mb = [math]::Round(($files | Measure-Object Length -Sum).Sum / 1MB, 1)
        Write-Host ("sessions:  {0} fisiere, {1} MB -> {2}" -f $files.Count, $mb, $SessionsBak)

        if ($DryRun) {
            Write-Host "           (dry run - nu s-a mutat nimic)" -ForegroundColor Yellow
        } else {
            New-Item -ItemType Directory -Force -Path $SessionsBak | Out-Null
            $moved = 0; $skipped = 0
            foreach ($f in $files) {
                try {
                    Move-Item -LiteralPath $f.FullName -Destination (Join-Path $SessionsBak $f.Name) -Force
                    $moved++
                } catch {
                    $skipped++
                }
            }
            Write-Host ("           mutate: {0}, sarite (fisier in uz): {1}" -f $moved, $skipped) -ForegroundColor Green
        }
    }
}

# ---------------------------------------------------------------- 3. pasi manuali
Write-Host ""
Write-Host "Pasi de terminat din UI (nu se pot automatiza):" -ForegroundColor Cyan
Write-Host "  1. VS Code:  Ctrl+Shift+P  ->  'Developer: Reload Window'"
Write-Host "  2. In chat:  butonul '+'  (New Session), nu doar 'New Chat'"
Write-Host "  3. Model:    alege 'DeepSeek Chat' pentru research cu unelte"
Write-Host "  4. Test:     trimite doar 'hi', fara fisiere atasate"
Write-Host ""

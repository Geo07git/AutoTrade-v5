# restart-app.ps1 - opreste instanta AutoTrade-v5 care asculta pe portul aplicatiei
#                   si porneste una noua, apoi verifica /api/health.
#
# Rulare (din radacina repo-ului):
#   powershell -ExecutionPolicy Bypass -File scripts\restart-app.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\restart-app.ps1 -Status      # doar raporteaza
#   powershell -ExecutionPolicy Bypass -File scripts\restart-app.ps1 -Port 3001   # alt port
#   powershell -ExecutionPolicy Bypass -File scripts\restart-app.ps1 -NoWait      # nu astepta health
#
# De ce asa: procesul se identifica dupa PORT, nu dupa nume sau PID ghicit.
# Numele `node` e comun (pe masina asta ruleaza si serverul MCP okx-trade-mcp),
# deci `Stop-Process -Name node` ar omori si unelte fara legatura cu aplicatia.
# Portul e unic: doar instanta aplicatiei il asculta.
#
# Ce opreste:
#   1. procesul care asculta pe port (copilul tsx/node - chiar aplicatia)
#   2. parintii lui ramasi atarnati (npm run dev / cmd), doar daca ruleaza tsx server.ts
#      din ACEST repo (verificat prin linia de comanda)
#
# Ce NU atinge NICIODATA:
#   - procese care nu asculta pe port si nu ruleaza server.ts din repo (ex. MCP-ul OKX)
#   - .data\ (chei, pozitii, ordine), .git\, sursa
#   - alte instante AutoTrade-v5 pe alt port

[CmdletBinding()]
param(
    [int]    $Port = 3000,
    [switch] $Status,
    [switch] $NoWait,
    [int]    $HealthTimeoutSec = 30
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'package.json'))) {
    throw "Nu gasesc package.json in $root - ruleaza scriptul din radacina repo-ului."
}

function Get-AppListeners {
    param([int]$P)
    Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
}

# Parintii atarnati: doar cei care ruleaza tsx/npm cu server.ts din acest repo.
function Get-RepoAppProcesses {
    param([string]$RepoRoot)
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -match 'server\.ts' -and
            $_.CommandLine -match [regex]::Escape($RepoRoot)
        }
}

function Get-Health {
    param([int]$P)
    try {
        return Invoke-RestMethod -Uri "http://localhost:$P/api/health" -TimeoutSec 5
    } catch {
        return $null
    }
}

# ------------------------------------------------------------------ 0. stare
$listeners = @(Get-AppListeners -P $Port)
$repoProcs = @(Get-RepoAppProcesses -RepoRoot $root)

Write-Host ""
Write-Host "=== AutoTrade-v5 restart ===" -ForegroundColor Cyan
Write-Host ("repo      : {0}" -f $root)
Write-Host ("port      : {0}" -f $Port)
Write-Host ("listener  : {0}" -f $(if ($listeners.Count) { ($listeners -join ', ') } else { 'niciunul' }))
Write-Host ("procese   : {0}" -f $(if ($repoProcs.Count) { ($repoProcs.ProcessId -join ', ') } else { 'niciunul' }))

if ($Status) {
    $h = Get-Health -P $Port
    if ($h) {
        Write-Host ""
        Write-Host "health    : ok" -ForegroundColor Green
        $h | ConvertTo-Json -Depth 3
    } else {
        Write-Host ""
        Write-Host "health    : NU raspunde pe portul $Port" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "(mod -Status: nu s-a oprit si nu s-a pornit nimic)" -ForegroundColor DarkGray
    exit 0
}

# ------------------------------------------------------------------ 1. oprire
if ($listeners.Count -eq 0 -and $repoProcs.Count -eq 0) {
    Write-Host ""
    Write-Host "Nimic de oprit - pornesc direct." -ForegroundColor DarkGray
} else {
    Write-Host ""
    Write-Host "1. opresc procesul care asculta pe portul $Port" -ForegroundColor Cyan
    foreach ($procId in $listeners) {
        try {
            $p = Get-Process -Id $procId -ErrorAction Stop
            Write-Host ("   stop PID {0,-7} {1}" -f $procId, $p.ProcessName) -ForegroundColor Yellow
        } catch {
            Write-Host ("   PID {0} a disparut deja" -f $procId) -ForegroundColor DarkGray
        }
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }

    # Parintii (npm/cmd) raman dupa ce copilul moare; ii curatam doar daca sunt din repo.
    if ($repoProcs.Count -gt 0) {
        Write-Host "2. curat parintii ramasi (tsx server.ts din repo)" -ForegroundColor Cyan
        foreach ($proc in $repoProcs) {
            if ($listeners -contains $proc.ProcessId) { continue }
            Write-Host ("   stop PID {0,-7} (parinte)" -f $proc.ProcessId) -ForegroundColor Yellow
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    # Asteapta ca portul sa fie chiar liber, altfel noua instanta porneste in gol.
    $waited = 0
    while ($waited -lt 15 -and (Get-AppListeners -P $Port).Count -gt 0) {
        Start-Sleep -Seconds 1
        $waited++
    }
    if ((Get-AppListeners -P $Port).Count -gt 0) {
        Write-Host ""
        Write-Host "ATENTIE: portul $Port e inca ocupat dupa 15s - nu pornesc o instanta noua." -ForegroundColor Red
        Write-Host "Verifica manual:  Get-NetTCPConnection -LocalPort $Port -State Listen" -ForegroundColor DarkGray
        exit 1
    }
    Write-Host "   port $Port liber" -ForegroundColor Green
}

# ------------------------------------------------------------------ 2. pornire
$outLog = Join-Path $env:TEMP 'autotrade-dev.out.log'
$errLog = Join-Path $env:TEMP 'autotrade-dev.err.log'

Write-Host ""
Write-Host "3. pornesc instanta noua (npm run dev)" -ForegroundColor Cyan
Write-Host ("   log: {0}" -f $outLog) -ForegroundColor DarkGray

$started = Start-Process -FilePath 'npm.cmd' `
    -ArgumentList 'run', 'dev' `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError  $errLog `
    -PassThru

Write-Host ("   PID parinte {0}" -f $started.Id)

if ($NoWait) {
    Write-Host ""
    Write-Host "Pornit. Health nu a fost verificat (-NoWait)." -ForegroundColor Yellow
    exit 0
}

# ------------------------------------------------------------------ 3. health
Write-Host ""
Write-Host "4. astept /api/health" -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
$health = $null
while ((Get-Date) -lt $deadline) {
    $health = Get-Health -P $Port
    if ($health -and $health.status -eq 'ok') { break }
    Start-Sleep -Seconds 2
}

Write-Host ""
if ($health -and $health.status -eq 'ok') {
    Write-Host "OK - aplicatia raspunde." -ForegroundColor Green
    $health | ConvertTo-Json -Depth 3
    Write-Host ""
    Write-Host ("ruleaza pe: http://localhost:{0}" -f $Port) -ForegroundColor Green
    exit 0
}

Write-Host ("ESEC: /api/health nu a raspuns in {0}s pe portul {1}." -f $HealthTimeoutSec, $Port) -ForegroundColor Red
Write-Host "Ultimele linii din log:" -ForegroundColor DarkGray
if (Test-Path $outLog) { Get-Content $outLog -Tail 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }
if (Test-Path $errLog) { Get-Content $errLog -Tail 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkRed } }
exit 1

# Curatenie repetabila pentru AutoTrade-v5. NU atinge sursa, datele botului sau .git.
#
#   powershell -ExecutionPolicy Bypass -File scripts\cleanup.ps1            # doar arata ce ar sterge
#   powershell -ExecutionPolicy Bypass -File scripts\cleanup.ps1 -Apply     # sterge efectiv
#
# Ce curata:
#   1. release\win-unpacked            - intermediar de build, se reface la fiecare electron:build
#   2. release\* versiuni vechi        - pastreaza doar artefactele versiunii din package.json
#   3. backup-uri vechi din profil     - TradeBot-data-backup-* / TradeBot-legacy-backup-* > 14 zile
#
# Ce NU atinge NICIODATA:
#   .data\ (chei, pozitii, ordine), .git\, node_modules\, sursa, dist\

param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$mode = if ($Apply) { 'APPLY (sterge)' } else { 'DRY-RUN (doar raporteaza; adauga -Apply ca sa stergi)' }
Write-Host "mod: $mode" -ForegroundColor Cyan

if (-not (Test-Path (Join-Path $root 'package.json'))) { throw "Nu gasesc package.json in $root" }
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "versiune curenta: $version`n"

# Protectie: nu rula daca aplicatia ruleaza (fisierele ar fi blocate)
$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'TradeBot' }
if ($running) {
    Write-Host "ATENTIE: aplicatia ruleaza ($($running.Count) procese). Inchide-o intai." -ForegroundColor Red
    exit 1
}

$totalFreed = 0
function Remove-Target {
    param([string]$Path, [string]$Label)
    if (-not (Test-Path $Path)) { return }
    $mb = [math]::Round(((Get-ChildItem $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)/1MB, 1)
    if ($Apply) {
        Remove-Item $Path -Recurse -Force
        Write-Host ("  sters    {0,-42} {1,8} MB" -f $Label, $mb) -ForegroundColor Green
    } else {
        Write-Host ("  ar sterge{0,-42} {1,8} MB" -f $Label, $mb) -ForegroundColor Yellow
    }
    $script:totalFreed += $mb
}

Write-Host "1. intermediare de build"
Remove-Target (Join-Path $root 'release\win-unpacked') 'release\win-unpacked'

Write-Host "2. artefacte din versiuni vechi"
$rel = Join-Path $root 'release'
if (Test-Path $rel) {
    Get-ChildItem $rel -File | Where-Object {
        $_.Extension -in '.exe', '.blockmap', '.yml', '.zip' -and
        $_.Name -match '\d+\.\d+\.\d+' -and
        $_.Name -notmatch [regex]::Escape($version)
    } | ForEach-Object { Remove-Target $_.FullName ("release\" + $_.Name) }
}

Write-Host "3. backup-uri de profil mai vechi de 14 zile"
$cutoff = (Get-Date).AddDays(-14)
Get-ChildItem $env:USERPROFILE -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^TradeBot-(data|legacy)-backup-' -and $_.LastWriteTime -lt $cutoff } |
    ForEach-Object { Remove-Target $_.FullName $_.Name }

Write-Host ""
if ($totalFreed -eq 0) {
    Write-Host "Nimic de curatat - repo-ul e deja curat." -ForegroundColor Green
} elseif ($Apply) {
    Write-Host ("Eliberat: {0} MB" -f $totalFreed) -ForegroundColor Green
} else {
    Write-Host ("S-ar elibera: {0} MB. Ruleaza din nou cu -Apply." -f $totalFreed) -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Verificare: datele botului sunt in %APPDATA%\TradeBot Pro Terminal\.data (dupa rebranding)"
Write-Host "            sau %APPDATA%\react-example\.data (inainte de rebranding)." -ForegroundColor DarkGray

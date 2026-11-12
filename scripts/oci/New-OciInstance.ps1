<#
.SYNOPSIS
    Interogare automata + creare instanta OCI pentru AutoTrade-v5.

.DESCRIPTION
    Scriptul ruleaza in 3 faze:

      1. INTEROGARE  - citeste profilul din ~/.oci/config, listeaza
                       instantele existente, availability domains,
                       subnet-urile publice, imaginea Ubuntu potrivita
                       pentru shape-ul cerut si limitele de capacitate.
      2. PLAN        - afiseaza exact ce s-ar crea (fara sa creeze nimic).
      3. CREARE      - doar cu -Create. Reincearca automat la erorile
                       tranzitorii de capacitate ("Out of host capacity"),
                       asteapta starea RUNNING si scrie un fisier de stare
                       in .data/ (gitignored) + log in .data/logs/.

    NU contine si NU afiseaza niciun secret: cheia privata OCI ramane
    doar in ~/.oci/ si nu este niciodata citita de script.

.PARAMETER Profile
    Profilul din ~/.oci/config. Default: DEFAULT

.PARAMETER AvailabilityDomain
    Un singur AD (ex. oGji:EU-FRANKFURT-1-AD-2). Ignorat daca folosesti -AllAds.

.PARAMETER AllAds
    Rotatie round-robin pe TOATE availability domains-urile regiunii:
    tentativa 1 -> AD-1, 2 -> AD-2, 3 -> AD-3, 4 -> AD-1 ...
    Creste sansele de reusita la shape-uri cerute (A1.Flex).

.PARAMETER MaxAttempts
    Numar maxim de tentative. 0 sau negativ = fara limita (foloseste -Until).

.PARAMETER Until
    Deadline de tip "yyyy-MM-dd HH:mm" (ora locala). Scriptul reincearca pana atunci.
    Util pentru ferestre lungi (ex. peste noapte, cand se elibereaza capacitatea).

.PARAMETER ListOnly
    Doar interogare, fara plan si fara creare.

.PARAMETER Create
    Creeaza efectiv instanta. Fara acest switch scriptul este DRY-RUN.

.EXAMPLE
    # 1. Doar interogare (zero risc, zero cost)
    .\New-OciInstance.ps1 -ListOnly

.EXAMPLE
    # 2. Plan complet, fara creare
    .\New-OciInstance.ps1

.EXAMPLE
    # 3. Creare reala, A1.Flex 2 OCPU / 12 GB, cu retry 60x la 60s
    .\New-OciInstance.ps1 -Create -MaxAttempts 60 -RetrySeconds 60

.EXAMPLE
    # 4. Alta regiune / alt shape
    .\New-OciInstance.ps1 -Region eu-frankfurt-1 -Shape VM.Standard.E2.1.Micro -Create

.EXAMPLE
    # 5. Rotatie pe toate AD-urile (recomandat pentru A1.Flex)
    .\New-OciInstance.ps1 -Create -AllAds -MaxAttempts 90 -RetrySeconds 30

.EXAMPLE
    # 6. Ruleaza pana luni la 08:00, fara limita de tentative (recomandat peste noapte)
    .\New-OciInstance.ps1 -Create -AllAds -Until "2026-11-03 08:00" -MaxAttempts 0 -RetrySeconds 20

.NOTES
    Necesita: OCI CLI in PATH + ~/.oci/config valid (oci setup config).
    Cost: crearea unei instante este operatiune facturabila (in afara de
    free tier). Ruleaza intai -ListOnly si apoi dry-run.
#>

[CmdletBinding()]
param(
    [string]$Profile = 'DEFAULT',
    [string]$Region,
    [string]$CompartmentId,
    [string]$Shape = 'VM.Standard.A1.Flex',
    [int]$Ocpus = 2,
    [int]$MemoryGB = 12,
    [string]$DisplayName,
    [string]$ImageId,
    [string]$SubnetId,
    [string]$AvailabilityDomain,
    [switch]$AllAds,
    [string]$SshPublicKeyPath = (Join-Path $env:USERPROFILE '.ssh\tradebot_a1.pub'),
    [int]$MaxAttempts = 40,
    [datetime]$Until,
    [int]$RetrySeconds = 60,
    [int]$BootVolumeGB = 50,
    [switch]$ListOnly,
    [switch]$Create,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ----------------------------------------------------------------------------
# Infrastructura locala (fara secrete)
# ----------------------------------------------------------------------------
$RepoRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$DataDir    = Join-Path $RepoRoot '.data'
$LogDir     = Join-Path $DataDir 'logs'
$Stamp      = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogFile    = Join-Path $LogDir "oci-provision-$Stamp.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'HH:mm:ss'), $Level, $Message
    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN'  { Write-Host $line -ForegroundColor Yellow }
        'OK'    { Write-Host $line -ForegroundColor Green }
        'STEP'  { Write-Host $line -ForegroundColor Cyan }
        default { Write-Host $line }
    }
    Add-Content -Path $LogFile -Value $line -Encoding utf8
}

function Format-Ocid {
    # OCID-urile nu sunt secrete, dar nu are rost sa umplem ecranul.
    param([string]$Ocid)
    if ([string]::IsNullOrWhiteSpace($Ocid)) { return '(gol)' }
    if ($Ocid.Length -le 24) { return $Ocid }
    return '...' + $Ocid.Substring($Ocid.Length - 20)
}

function Invoke-Oci {
    param(
        [Parameter(Mandatory)][string[]]$OciArgs,
        [switch]$AllowFail,
        [switch]$Raw
    )
    $full = @($OciArgs)
    if ($Profile -and $Profile -ne 'DEFAULT') { $full += @('--profile', $Profile) }
    if ($Region) { $full += @('--region', $Region) }

    # Wrapper-ul oci.exe scrie uneori zgomot pe stderr chiar si la succes
    # (ex. erori de profil PowerShell mostenite), deci stderr merge in fisier
    # separat si ne bazam pe EXIT CODE, nu pe textul de eroare.
    $errFile = [System.IO.Path]::GetTempFileName()
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & oci @full 2> $errFile
    } finally {
        $ErrorActionPreference = $prevEap
    }
    $code = $LASTEXITCODE

    $errText = ''
    if (Test-Path $errFile) {
        $errText = Get-Content $errFile -Raw -ErrorAction SilentlyContinue
        Remove-Item $errFile -Force -ErrorAction SilentlyContinue
    }
    $noise = 'cloud file provider is not running|CategoryInfo|FullyQualifiedErrorId|^\s*\+\s|^At line:|^\s*$'
    $cleanErr = (($errText -split "`r?`n") | Where-Object { $_ -and $_ -notmatch $noise }) -join "`n"

    $text = ($out | Out-String).Trim()

    if ($code -ne 0) {
        if ($AllowFail) { return $null }
        $cmd = ($full | Where-Object { $_ -notmatch '^file://' }) -join ' '
        throw "oci $cmd a esuat (exit $code):`n$cleanErr"
    }
    if ($Raw) { return $text }
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text | ConvertFrom-Json
}

function Get-TargetCompartmentIds {
    # Root + compartimente copil (pentru ca list-urile sa nu rateze resurse).
    param([int]$Max = 15)
    $ids = @($tenancy)
    $comps = Invoke-Oci -AllowFail -OciArgs @(
        'iam','compartment','list',
        '--compartment-id', $tenancy,
        '--compartment-id-in-subtree','true',
        '--all'
    )
    if ($comps -and $comps.data) {
        foreach ($c in ($comps.data | Select-Object -First $Max)) {
            if ($c.'lifecycle-state' -eq 'ACTIVE') { $ids += $c.id }
        }
    }
    return ($ids | Select-Object -Unique)
}

function Get-ProfileValue {
    param([string]$Key)
    $cfg = Join-Path $env:USERPROFILE '.oci\config'
    if (-not (Test-Path $cfg)) { return $null }
    $inSection = $false
    foreach ($line in Get-Content $cfg) {
        $t = $line.Trim()
        if ($t -match '^\[(.+)\]$') {
            $inSection = ($Matches[1] -eq $Profile)
            continue
        }
        if ($inSection -and $t -match "^$([regex]::Escape($Key))\s*=\s*(.+)$") {
            return $Matches[1].Trim()
        }
    }
    return $null
}

# ----------------------------------------------------------------------------
# FAZA 1 - INTEROGARE
# ----------------------------------------------------------------------------
Write-Log "=== AutoTrade-v5 / OCI provisioner ===" 'STEP'
Write-Log "Log: $LogFile"

$ociCmd = Get-Command oci -ErrorAction SilentlyContinue
if (-not $ociCmd) {
    Write-Log "OCI CLI nu este in PATH. Instaleaza: https://docs.oracle.com/iaas/Content/API/SDKDocs/cliinstall.htm" 'ERROR'
    exit 1
}
Write-Log ("OCI CLI: {0} ({1})" -f $ociCmd.Source, (& oci --version 2>&1 | Select-Object -First 1))

$cfgPath = Join-Path $env:USERPROFILE '.oci\config'
if (-not (Test-Path $cfgPath)) {
    Write-Log "Lipseste ~/.oci/config. Ruleaza: oci setup config" 'ERROR'
    exit 1
}

$tenancy = Get-ProfileValue 'tenancy'
$cfgRegion = Get-ProfileValue 'region'
if (-not $Region) { $Region = $cfgRegion }
if (-not $CompartmentId) { $CompartmentId = $tenancy }
if (-not $DisplayName) { $DisplayName = "tradebot-v5-$Stamp" }

Write-Log ("Profil       : {0}" -f $Profile)
Write-Log ("Regiune      : {0}" -f $Region)
Write-Log ("Tenancy      : {0}" -f (Format-Ocid $tenancy))
Write-Log ("Compartment  : {0}" -f (Format-Ocid $CompartmentId))
Write-Log ("Shape        : {0}{1}" -f $Shape, $(if ($Shape -like '*Flex') { " ($Ocpus OCPU / $MemoryGB GB)" } else { '' }))

# 1a. Instante existente (ca sa nu creezi duplicate)
Write-Log "`n--- Instante existente (non-TERMINATED) ---" 'STEP'
$found = 0
foreach ($cid in (Get-TargetCompartmentIds)) {
    $r = Invoke-Oci -AllowFail -OciArgs @('compute','instance','list','--compartment-id',$cid,'--all')
    if (-not $r -or -not $r.data) { continue }
    foreach ($i in ($r.data | Where-Object { $_.'lifecycle-state' -ne 'TERMINATED' })) {
        $found++
        Write-Log ("  {0,-26} {1,-22} {2,-11} {3}" -f $i.'display-name', $i.shape, $i.'lifecycle-state', (Format-Ocid $i.id))
    }
}
if ($found -eq 0) { Write-Log "  (niciuna)" }

# Garda anti-duplicat / anti-dublu-cost: daca exista deja o instanta activa,
# nu cream inca una din greseala (ex. script rulat de doua ori).
if ($found -gt 0 -and $Create -and -not $Force) {
    Write-Log ("Exista deja {0} instanta/instante non-TERMINATED. Nu creez alta. Foloseste -Force pentru a forta." -f $found) 'ERROR'
    exit 1
}

# 1b. Availability domains
Write-Log "`n--- Availability domains ---" 'STEP'
$ads = Invoke-Oci -OciArgs @('iam','availability-domain','list','--compartment-id',$tenancy)
if (-not $ads -or -not $ads.data) { Write-Log "Nu am putut citi AD-urile." 'ERROR'; exit 1 }
$ads.data | ForEach-Object { Write-Log ("  " + $_.name) }

# Lista de AD-uri pe care se face rotatie (una sau toate).
if ($AllAds) {
    $adList = @($ads.data | ForEach-Object { $_.name })
} elseif ($AvailabilityDomain) {
    $adList = @($AvailabilityDomain)
} else {
    $adList = @($ads.data[0].name)
}
$AvailabilityDomain = $adList[0]   # AD reprezentativ pentru raportarea limitelor
if ($adList.Count -gt 1) {
    Write-Log ("  -> rotatie pe {0} AD-uri: {1}" -f $adList.Count, ($adList -join ' | '))
} else {
    Write-Log ("  -> folosesc: {0}" -f $adList[0])
}

# 1c. Imagine Ubuntu potrivita pentru shape
Write-Log "`n--- Imagine Ubuntu pentru shape ---" 'STEP'
if (-not $ImageId) {
    $img = $null
    foreach ($ver in @('24.04','22.04')) {
        $r = Invoke-Oci -AllowFail -OciArgs @(
            'compute','image','list',
            '--compartment-id', $tenancy,
            '--shape', $Shape,
            '--operating-system','Canonical Ubuntu',
            '--operating-system-version', $ver,
            '--sort-by','TIMECREATED','--sort-order','DESC',
            '--limit','10'
        )
        if ($r -and $r.data) {
            $img = $r.data | Where-Object { $_.'lifecycle-state' -eq 'AVAILABLE' } | Select-Object -First 1
            if ($img) { break }
        }
    }
    if ($img) {
        $ImageId = $img.id
        Write-Log ("  {0}  (creat: {1})  {2}" -f $img.'display-name', $img.'time-created', (Format-Ocid $img.id))
    } else {
        Write-Log "  Nu am gasit imagine Ubuntu pentru acest shape." 'ERROR'
        exit 1
    }
} else {
    Write-Log ("  ImageId dat manual: {0}" -f (Format-Ocid $ImageId))
}

# 1d. Subnet public
Write-Log "`n--- Subnet-uri disponibile ---" 'STEP'
if (-not $SubnetId) {
    $all = @()
    foreach ($cid in (Get-TargetCompartmentIds)) {
        $r = Invoke-Oci -AllowFail -OciArgs @('network','subnet','list','--compartment-id',$cid,'--all')
        if ($r -and $r.data) { $all += $r.data }
    }
    $avail = @($all | Where-Object { $_.'lifecycle-state' -eq 'AVAILABLE' })
    if ($avail.Count -eq 0) { Write-Log "  Nu am gasit subnet-uri." 'ERROR'; exit 1 }
    foreach ($s in $avail) {
        $kind = if ($s.'prohibit-public-ip-on-vnic') { 'privat' } else { 'PUBLIC' }
        Write-Log ("  [{0}] {1,-26} {2,-18} {3}" -f $kind, $s.'display-name', $s.'cidr-block', (Format-Ocid $s.id))
    }
    $pick = $avail | Where-Object { -not $_.'prohibit-public-ip-on-vnic' } | Select-Object -First 1
    if (-not $pick) { $pick = $avail | Select-Object -First 1 }
    $SubnetId = $pick.id
    Write-Log ("  -> folosesc: {0} ({1})" -f $pick.'display-name', $pick.'cidr-block')
} else {
    Write-Log ("  SubnetId dat manual: {0}" -f (Format-Ocid $SubnetId))
}

# 1e. Limite de capacitate pentru shape (informativa; unele tenancy-uri nu au acces)
Write-Log "`n--- Capacitate / limite (informativ) ---" 'STEP'
$limitName = switch -Wildcard ($Shape) {
    'VM.Standard.A1*'    { 'standard-a1-core-count' }
    'VM.Standard.E2*'    { 'standard-e2-core-count' }
    'VM.Standard.E4*'    { 'standard-e4-core-count' }
    'VM.Standard3.Flex*' { 'standard3-core-count' }
    default              { $null }
}
if ($limitName) {
    foreach ($ad in $adList) {
        $avail = Invoke-Oci -AllowFail -OciArgs @(
            'limits','resource-availability','get',
            '--service-name','compute',
            '--limit-name',$limitName,
            '--compartment-id',$CompartmentId,
            '--availability-domain',$ad
        )
        if ($avail -and $avail.data) {
            # Raspunsul poate sa nu contina toate campurile; citim defensiv (StrictMode).
            $d = @($avail.data)[0]
            $names = $d.PSObject.Properties.Name
            $av  = if ($names -contains 'available') { $d.available } else { '?' }
            $us  = if ($names -contains 'used')      { $d.used }      else { '?' }
            $lim = if ($names -contains 'limit')     { $d.limit }     else { '?' }
            Write-Log ("  {0} | {1}: available={2} used={3} limit={4}" -f $ad, $limitName, $av, $us, $lim)
        } else {
            Write-Log ("  {0} | (limite indisponibile)" -f $ad)
        }
    }
} else {
    Write-Log "  (shape fara mapare de limita - sar peste)"
}

# 1f. Cheie SSH publica
$pubKey = $null
if (Test-Path $SshPublicKeyPath) {
    $pubKey = (Get-Content $SshPublicKeyPath -Raw).Trim()
    Write-Log ("`nCheie SSH publica: {0} ({1} caractere)" -f $SshPublicKeyPath, $pubKey.Length)
} else {
    Write-Log "`nCheie SSH publica lipseste: $SshPublicKeyPath - instanta va porni FARA acces SSH." 'WARN'
}

if ($ListOnly) {
    Write-Log "`n-ListOnly: ma opresc aici. Nu s-a creat nimic." 'OK'
    exit 0
}

# ----------------------------------------------------------------------------
# FAZA 2 - PLAN
# ----------------------------------------------------------------------------
Write-Log "`n=== PLAN ===" 'STEP'
Write-Log ("  Display name   : {0}" -f $DisplayName)
Write-Log ("  Regiune        : {0}" -f $Region)
Write-Log ("  AD             : {0}{1}" -f $AvailabilityDomain, $(if ($adList.Count -gt 1) { " (+ rotatie pe toate $($adList.Count))" } else { '' }))
Write-Log ("  Shape          : {0}" -f $Shape)
if ($Shape -like '*Flex') {
    Write-Log ("  OCPU / RAM     : {0} / {1} GB" -f $Ocpus, $MemoryGB)
}
Write-Log ("  Boot volume    : {0} GB" -f $BootVolumeGB)
Write-Log ("  Imagine        : {0}" -f (Format-Ocid $ImageId))
Write-Log ("  Subnet         : {0}" -f (Format-Ocid $SubnetId))
Write-Log ("  Public IP      : da")
Write-Log ("  Retry          : {0} x {1}s la 'Out of host capacity'" -f $(if ($MaxAttempts -le 0) { 'nelimitat' } else { $MaxAttempts }), $RetrySeconds)
if ($Until) {
    Write-Log ("  Ruleaza pana   : {0} (aprox. {1:N1} ore)" -f $Until.ToString('yyyy-MM-dd HH:mm'), (($Until - (Get-Date)).TotalHours))
}

if (-not $Create) {
    Write-Log "`nDRY-RUN: nu s-a creat nimic. Adauga -Create pentru executie." 'WARN'
    exit 0
}

# ----------------------------------------------------------------------------
# FAZA 3 - CREARE (cu retry pe erori tranzitorii)
# ----------------------------------------------------------------------------
$tmpDir = Join-Path $env:TEMP "oci-provision-$Stamp"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

$metaFile = Join-Path $tmpDir 'metadata.json'
$metaObj = @{}
if ($pubKey) { $metaObj['ssh_authorized_keys'] = $pubKey }
# IMPORTANT: UTF-8 FARA BOM - altfel OCI CLI respinge JSON-ul ("must be in JSON format").
[System.IO.File]::WriteAllText($metaFile, ($metaObj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))

$commonArgs = @(
    '--shape', $Shape,
    '--display-name', $DisplayName,
    '--image-id', $ImageId,
    '--subnet-id', $SubnetId,
    '--assign-public-ip', 'true',
    '--metadata', "file://$($metaFile -replace '\\','/')",
    '--boot-volume-size-in-gbs', "$BootVolumeGB"
)
if ($Shape -like '*Flex') {
    $shapeFile = Join-Path $tmpDir 'shape.json'
    [System.IO.File]::WriteAllText($shapeFile, (@{ ocpus = $Ocpus; memoryInGBs = $MemoryGB } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    $commonArgs += @('--shape-config', "file://$($shapeFile -replace '\\','/')")
}
$commonArgs += @('--wait-for-state','RUNNING','--wait-interval-seconds','10','--max-wait-seconds','1200')

$instance  = $null
$createdAd = $null
$adStats   = @{}
foreach ($a in $adList) { $adStats[$a] = 0 }

# MaxAttempts 0/negativ = fara limita; cand e dat -Until, timpul e singurul plafon.
$attemptCap = if ($MaxAttempts -le 0) { [int]::MaxValue } else { $MaxAttempts }
$deadline   = if ($Until) { $Until } else { $null }

# Rotatie round-robin: tentativa 1 -> AD-1, 2 -> AD-2, 3 -> AD-3, 4 -> AD-1 ...
for ($attempt = 1; $attempt -le $attemptCap; $attempt++) {
    if ($deadline -and (Get-Date) -ge $deadline) {
        Write-Log ("Deadline atins ({0}). Ma opresc." -f $deadline.ToString('yyyy-MM-dd HH:mm')) 'WARN'
        break
    }

    $currentAd = $adList[($attempt - 1) % $adList.Count]
    $adStats[$currentAd]++
    $remaining = if ($deadline) { $deadline - (Get-Date) } else { $null }
    $etaTxt = if ($remaining) { ' (ramas {0:hh\:mm})' -f $remaining } else { '' }
    Write-Log ("`nTentativa {0}{1} - AD: {2} - {3}{4}" -f $attempt, $(if ($MaxAttempts -le 0) { '' } else { "/$MaxAttempts" }), $currentAd, $Shape, $etaTxt) 'STEP'

    $launchArgs = @(
        'compute','instance','launch',
        '--compartment-id', $CompartmentId,
        '--availability-domain', $currentAd
    ) + $commonArgs

    try {
        $instance  = Invoke-Oci -OciArgs $launchArgs
        $createdAd = $currentAd
        Write-Log ("Instanta a fost creata in {0}." -f $createdAd) 'OK'
        break
    } catch {
        $msg = $_.Exception.Message
        # Prima linie utila din mesaj (fara trace-ul PowerShell) pentru diagnoza.
        $firstLine = (($msg -split "`r?`n") | Where-Object { $_ -match '\S' -and $_ -notmatch '^At |^\s*\+|CategoryInfo|FullyQualifiedErrorId' } | Select-Object -First 1)
        $transient = $msg -match 'Out of host capacity|InternalError|TooManyRequests|ServiceUnavailable|capacity'
        if ($transient -and $attempt -lt $attemptCap) {
            Write-Log ("Capacitate indisponibila (tranzitoriu): {0}" -f $firstLine) 'WARN'
            # Dormi doar cat mai ramane pana la deadline (nu depasi fereastra).
            $sleepSec = $RetrySeconds
            if ($deadline) {
                $left = [int](($deadline - (Get-Date)).TotalSeconds)
                if ($left -le 0) { Write-Log "Deadline atins in timpul pauzei. Ma opresc." 'WARN'; break }
                if ($left -lt $sleepSec) { $sleepSec = $left }
            }
            Write-Log ("Reincerc in {0}s..." -f $sleepSec)
            Start-Sleep -Seconds $sleepSec
            continue
        }
        Write-Log ("Eroare ne-reincercabila: {0}" -f $msg) 'ERROR'
        exit 1
    }
}

if (-not $instance) {
    if ($deadline -and (Get-Date) -ge $deadline) {
        Write-Log ("Deadline {0} atins fara succes." -f $deadline.ToString('yyyy-MM-dd HH:mm')) 'ERROR'
    } else {
        Write-Log ("Nu am reusit sa creez instanta in $attempt tentative.") 'ERROR'
    }
    foreach ($a in $adList) { Write-Log ("  {0}: {1} tentative" -f $a, $adStats[$a]) 'ERROR' }
    exit 1
}

# ----------------------------------------------------------------------------
# POST-CREARE - IP public + fisier de stare
# ----------------------------------------------------------------------------
$instanceId = $instance.data.id
Write-Log ("`nInstance OCID: {0}" -f (Format-Ocid $instanceId))
Write-Log ("AD folosit    : {0}" -f $createdAd)

$publicIp = $null
for ($i = 1; $i -le 12; $i++) {
    $vnic = Invoke-Oci -AllowFail -OciArgs @('compute','instance','list-vnics','--instance-id',$instanceId)
    if ($vnic -and $vnic.data -and @($vnic.data).Count -gt 0) {
        $publicIp = @($vnic.data)[0].'public-ip'
    }
    if ($publicIp -and $publicIp -ne 'null') { break }
    Start-Sleep -Seconds 5
}

$state = [ordered]@{
    createdAt      = (Get-Date).ToString('o')
    displayName    = $DisplayName
    instanceId     = $instanceId
    publicIp       = $publicIp
    region         = $Region
    availabilityDomain = $createdAd
    shape          = $Shape
    ocpus          = $(if ($Shape -like '*Flex') { $Ocpus } else { $null })
    memoryGB       = $(if ($Shape -like '*Flex') { $MemoryGB } else { $null })
    imageId        = $ImageId
    subnetId       = $SubnetId
    bootVolumeGB   = $BootVolumeGB
    sshUser        = 'ubuntu'
    sshKeyPath     = ($SshPublicKeyPath -replace '\.pub$','')
}
$stateFile = Join-Path $DataDir "oci-instance-$Stamp.json"
$state | ConvertTo-Json -Depth 4 | Set-Content -Path $stateFile -Encoding utf8
Write-Log ("Stare salvata: {0}" -f $stateFile) 'OK'

Write-Log "`n=== GATA ===" 'OK'
Write-Log ("  IP public : {0}" -f $publicIp)
Write-Log ("  SSH       : ssh -i `"$($SshPublicKeyPath -replace '\.pub$','')`" ubuntu@$publicIp")
Write-Log "`n  Urmatorii pasi pe instanta:"
Write-Log "    1. sudo apt update && sudo apt install -y git curl"
Write-Log "    2. curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
Write-Log "    3. git clone https://github.com/Geo07git/AutoTrade-v5 /home/ubuntu/AutoTrade-v5"
Write-Log "    4. copiaza .env + .data din backup (NU din git)"
Write-Log "    5. creeaza unitatea systemd autotrade-v5.service"
Write-Log "    6. actualizeaza secretele GitHub: OCI_HOST=$publicIp, OCI_USER=ubuntu, OCI_SSH_KEY"
Write-Log ("`nLog complet: {0}" -f $LogFile)

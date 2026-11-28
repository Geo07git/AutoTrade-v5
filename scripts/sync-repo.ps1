# sync-repo.ps1 - aduce repo-ul local la zi cu origin/main, in siguranta.
#
# Rulare (din radacina repo-ului):
#   powershell -ExecutionPolicy Bypass -File scripts\sync-repo.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\sync-repo.ps1 -Status      # doar raporteaza
#   powershell -ExecutionPolicy Bypass -File scripts\sync-repo.ps1 -Restart     # pull + restart
#   powershell -ExecutionPolicy Bypass -File scripts\sync-repo.ps1 -SkipLint    # nu rula tsc
#
# Cod de iesire:
#   0  repo actualizat (si, daca s-a cerut, server repornit)
#   2  deja la zi - nimic de facut
#   1  blocat: modificari locale, divergenta, fetch/pull esuat, lint rosu
#
# Ce face, in ordine:
#   1. verifica repo-ul (branch main, HEAD atasat, fara rebase/merge in curs)
#   2. git status - daca exista modificari la fisiere URMARITE -> stop, nu atinge nimic
#   3. git fetch origin  (GIT_TERMINAL_PROMPT=0, deci nu se blocheaza pe credentiale)
#   4. compara HEAD cu origin/main (in urma / inainte)
#   5. garda pe ce intra: .data\ trebuie sa fie ignorat, iar commit-urile de tras nu au
#      voie sa atinga .data/, .env*, *.pem, *.key, *.zip, *.patch -> stop INAINTE de pull
#   6. git pull --ff-only origin main   - NUMAI fast-forward
#   7. npm run lint, dar doar daca s-a schimbat cod (src/, server.ts, configs)
#   8. optional (-Restart): lanseaza scripts\restart-app.ps1 - si numai dupa lint verde
#      (restart-app.ps1 face singur copie de siguranta a .data\ si shutdown curat)
#
# Ce NU face NICIODATA (reguli din AGENTS.md):
#   - git reset --hard / git clean / git checkout -- . / git restore .
#   - git rebase, git merge, git commit --amend pe istoric deja publicat
#   - git push (sincronizarea doar TRAGE; publicarea ramane decizia proprietarului)
#   - nu reporneste serverul daca lint-ul a picat (serverul vechi ramane sus, functional)
#   - nu citeste, nu scrie si nu afiseaza .env* sau .data\

[CmdletBinding()]
param(
    [switch] $Status,        # doar raporteaza starea, nu trage si nu reporneste nimic
    [switch] $Restart,       # dupa un pull reusit, lanseaza scripts\restart-app.ps1
    [switch] $ForceRestart,  # reporneste si cand s-au schimbat doar fisiere non-runtime (docs, scripts)
    [switch] $SkipLint,      # nu rula npm run lint (nerecomandat)
    [string] $Branch = 'main',
    [int]    $Port = 3000,
    [int]    $GitTimeoutSec = 120,
    [int]    $LintTimeoutSec = 300
)

$ErrorActionPreference = 'Continue'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$LogPath = Join-Path $env:TEMP 'autotrade-sync.log'
$LockPath = Join-Path $env:TEMP 'autotrade-sync.lock'

# ------------------------------------------------------------------ helpers

function Write-Log {
    param([string] $Message, [string] $Color = 'Gray')
    $stamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    Write-Host $Message -ForegroundColor $Color
    try {
        Add-Content -LiteralPath $LogPath -Value ("{0}  {1}" -f $stamp, $Message) -Encoding UTF8
    } catch {
        # log-ul e best effort; nu opreste sincronizarea din cauza lui
    }
}

function Quote-Arg {
    param([string] $Value)
    if ($Value -match '[\s"]') {
        return '"' + ($Value -replace '"', '\"') + '"'
    }
    return $Value
}

# Ruleaza un executabil si intoarce exit code + output, fara sa arunce exceptii.
# Motivul pentru Process in loc de "& cmd": avem nevoie simultan de exit code,
# de stdout si de stderr separate, plus un timeout care nu blocheaza veciunile.
function Invoke-Exe {
    param(
        [string]   $FilePath,
        [string[]] $Arguments,
        [int]      $TimeoutSec = 120,
        [hashtable] $Environment = @{}
    )

    $result = [pscustomobject]@{
        ExitCode = 1
        StdOut   = ''
        StdErr   = ''
        TimedOut = $false
    }

    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $FilePath
        $psi.WorkingDirectory = $script:RepoRoot
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.Arguments = (($Arguments | ForEach-Object { Quote-Arg $_ }) -join ' ')

        foreach ($key in $Environment.Keys) {
            $psi.EnvironmentVariables[$key] = [string] $Environment[$key]
        }

        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        [void] $proc.Start()

        $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
        $stderrTask = $proc.StandardError.ReadToEndAsync()

        if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
            $result.TimedOut = $true
            try { $proc.Kill() } catch {}
        }

        $result.ExitCode = $proc.ExitCode
        $result.StdOut = $stdoutTask.Result
        $result.StdErr = $stderrTask.Result
        $proc.Dispose()
    } catch {
        $result.StdErr = $_.Exception.Message
    }

    return $result
}

function Invoke-Git {
    param([string[]] $GitArgs, [int] $TimeoutSec = $script:GitTimeoutSec)
    return Invoke-Exe -FilePath 'git' -Arguments $GitArgs -TimeoutSec $TimeoutSec -Environment @{
        GIT_TERMINAL_PROMPT = '0'   # nu astepta niciodata input de credentiale
        GIT_PAGER           = 'cat'
    }
}

function Exit-With {
    param([int] $Code, [string] $Message, [string] $Color = 'Gray')
    Write-Log ''
    Write-Log $Message $Color
    Write-Log ''
    Write-Log ("Cod de iesire: {0}   |   log: {1}" -f $Code, $LogPath) 'DarkGray'
    exit $Code
}

# ------------------------------------------------------------------ pre-verificari

Write-Log ''
Write-Log '=== AutoTrade-v5 sync repo ===' 'Cyan'
Write-Log ("repo   : {0}" -f $script:RepoRoot)
Write-Log ("branch : {0}" -f $Branch)
Write-Log ("mod    : {0}" -f $(if ($Status) { 'STATUS (nu modifica nimic)' } else { 'SYNC' }))

if (-not (Test-Path (Join-Path $script:RepoRoot 'package.json'))) {
    Exit-With -Code 1 -Message "Nu gasesc package.json in $($script:RepoRoot) - ruleaza scriptul din radacina repo-ului." -Color Red
}
if (-not (Test-Path (Join-Path $script:RepoRoot '.git'))) {
    Exit-With -Code 1 -Message "Nu gasesc .git in $($script:RepoRoot)." -Color Red
}

# Un singur sync o data. Lock-ul moare singur dupa 15 minute (proces omorat brutal).
if (Test-Path $LockPath) {
    $age = (Get-Date) - (Get-Item $LockPath).LastWriteTime
    if ($age.TotalMinutes -lt 15) {
        Exit-With -Code 1 -Message ("O sincronizare este deja in curs (lock: {0}, vechime {1:N1} min). Asteapta sa termine." -f $LockPath, $age.TotalMinutes) -Color Yellow
    }
    Write-Log ("lock vechi ({0:N1} min) - il suprascriu" -f $age.TotalMinutes) 'DarkGray'
}
try {
    Set-Content -LiteralPath $LockPath -Value ([string] $PID) -Encoding ASCII -Force
} catch {
    Exit-With -Code 1 -Message "Nu pot scrie lock-ul $LockPath : $($_.Exception.Message)" -Color Red
}

try {

# ------------------------------------------------------------------ 1. stare git

$headFile = Join-Path $script:RepoRoot '.git\HEAD'
$gitDir = Join-Path $script:RepoRoot '.git'

foreach ($marker in @('rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD')) {
    if (Test-Path (Join-Path $gitDir $marker)) {
        Exit-With -Code 1 -Message ("Operatie git in curs ({0}). Termin-o sau anuleaz-o manual inainte de sync." -f $marker) -Color Red
    }
}
if ((Test-Path $headFile) -and ((Get-Content -LiteralPath $headFile -Raw) -notmatch '^ref:')) {
    Exit-With -Code 1 -Message 'HEAD este detasat. Comuta pe branch-ul main inainte de sync.' -Color Red
}

$branchCheck = Invoke-Git -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')
if ($branchCheck.ExitCode -ne 0) {
    Exit-With -Code 1 -Message ("git rev-parse a esuat: {0}" -f $branchCheck.StdErr.Trim()) -Color Red
}
$currentBranch = $branchCheck.StdOut.Trim()
if ($currentBranch -ne $Branch) {
    Exit-With -Code 1 -Message ("Esti pe branch-ul '{0}', dar sync-ul tinteste '{1}'. Nu comut automat intre branch-uri." -f $currentBranch, $Branch) -Color Red
}

# Modificari la fisiere URMARITE = munca nesalvata. Nu o ascundem si nu o aruncam.
# Fisierele netracked (log-uri, build) nu blocheaza fast-forward-ul; daca ar fi
# sa fie suprascrise, pull-ul insusi refuza si raportam eroarea lui.
$statusProc = Invoke-Git -GitArgs @('status', '--porcelain', '--untracked-files=no')
if ($statusProc.ExitCode -ne 0) {
    Exit-With -Code 1 -Message ("git status a esuat: {0}" -f $statusProc.StdErr.Trim()) -Color Red
}
$dirty = @($statusProc.StdOut -split "`r?`n" | Where-Object { $_.Trim() })
if ($dirty.Count -gt 0) {
    Write-Log ''
    Write-Log 'Modificari locale la fisiere urmarite:' 'Yellow'
    $dirty | ForEach-Object { Write-Log ("  {0}" -f $_.TrimEnd()) 'Yellow' }
    Exit-With -Code 1 -Message 'Nu fac pull peste munca nesalvata. Commita sau salveaza-le (git stash) si ruleaza din nou.' -Color Red
}

# ------------------------------------------------------------------ 2. fetch

Write-Log ''
Write-Log '1. git fetch origin' 'Cyan'
$fetch = Invoke-Git -GitArgs @('fetch', 'origin', '--prune')
if ($fetch.TimedOut) {
    Exit-With -Code 1 -Message ("git fetch a depasit {0}s. Verifica reteaua." -f $GitTimeoutSec) -Color Red
}
if ($fetch.ExitCode -ne 0) {
    Write-Log $fetch.StdErr.Trim() 'Red'
    Exit-With -Code 1 -Message 'git fetch a esuat (offline sau remote inaccesibil). Nu s-a schimbat nimic local.' -Color Red
}
Write-Log '   ok' 'Green'

# ------------------------------------------------------------------ 3. comparatie

$headRev = (Invoke-Git -GitArgs @('rev-parse', 'HEAD')).StdOut.Trim()
$remoteRef = "origin/$Branch"
$remoteRev = (Invoke-Git -GitArgs @('rev-parse', $remoteRef)).StdOut.Trim()
if (-not $remoteRev) {
    Exit-With -Code 1 -Message ("Nu exista {0} dupa fetch." -f $remoteRef) -Color Red
}

$behind = [int] ((Invoke-Git -GitArgs @('rev-list', '--count', "HEAD..$remoteRef")).StdOut.Trim() -as [int])
$ahead  = [int] ((Invoke-Git -GitArgs @('rev-list', '--count', "$remoteRef..HEAD")).StdOut.Trim() -as [int])

Write-Log ''
Write-Log ("local  : {0}" -f $headRev.Substring(0, [Math]::Min(7, $headRev.Length)))
Write-Log ("remote : {0}" -f $remoteRev.Substring(0, [Math]::Min(7, $remoteRev.Length)))
Write-Log ("in urma: {0} commit(uri)   |   inainte: {1} commit(uri)" -f $behind, $ahead)

if ($ahead -gt 0 -and $behind -gt 0) {
    Write-Log ''
    Write-Log 'Istoricul a divergat (commit-uri locale + commit-uri pe remote).' 'Yellow'
    Exit-With -Code 1 -Message 'Nu fac merge si nu fac rebase automat pe main. Rezolva manual (AGENTS.md interzice ambele automat).' -Color Red
}
if ($ahead -gt 0) {
    Exit-With -Code 1 -Message ("Ai {0} commit(uri) locale nepublicate. Sync-ul doar trage, nu publica. Fa push explicit daca vrei." -f $ahead) -Color Yellow
}

if ($behind -eq 0) {
    if ($Restart -and $ForceRestart) {
        # "Cod nou pe disc, dar procesul ruleaza o versiune veche" (de ex. un pull al carui lint a
        # picat, apoi reparat): nu e nimic de tras, dar arborele curent trebuie verificat si
        # incarcat. Lint-ul de mai jos ramane poarta, deci un cod stricat tot nu ajunge live.
        Write-Log ''
        Write-Log 'Repo deja la zi, dar s-a cerut restart verificat (-ForceRestart): rulez lint pe arborele curent, apoi repornesc.' 'Yellow'
    }
    elseif ($Status) {
        Exit-With -Code 2 -Message 'Repo deja la zi cu origin/main.' -Color Green
    }
    else {
        Exit-With -Code 2 -Message 'Repo deja la zi cu origin/main. Nimic de facut.' -Color Green
    }
}

# Ce vine, ca sa stim daca merita restart
Write-Log ''
Write-Log 'Commit-uri noi pe origin:' 'Cyan'
$incoming = (Invoke-Git -GitArgs @('log', '--oneline', "--max-count=10", "HEAD..$remoteRef")).StdOut
$incoming -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { Write-Log ("  {0}" -f $_.Trim()) }

if ($Status) {
    Exit-With -Code 0 -Message ("Ar fi de tras {0} commit(uri). Mod -Status: nu s-a modificat nimic." -f $behind) -Color Yellow
}

# ------------------------------------------------------------------ 3b. garda pe ce intra

# Un `pull` nu poate atinge .data\ (e gitignored) si nu poate suprascrie fisiere netracked
# fara sa refuze singur. Verificam totusi explicit: daca cineva a scos regula din .gitignore
# sau a comis din greseala un secret / un fisier din .data, ne oprim INAINTE de a-l asterne
# in working tree (si inainte de a-l expune la `git add -A`).
# Probe a CHILD path, not `.data` itself: a directory-only rule (`.data/`) matches only once git
# knows the path is a directory, so on a fresh clone probing `.data` would report "not ignored"
# and block a sync that is actually safe.
$ignoreCheck = Invoke-Git -GitArgs @('check-ignore', '-q', '.data/probe')
if ($ignoreCheck.ExitCode -ne 0) {
    Exit-With -Code 1 -Message '.data\ nu mai este ignorat de git. Nu fac pull pana nu revine regula .data/ in .gitignore - altfel urmatorul git add -A ar comite chei, pozitii si ordine.' -Color Red
}

$incomingPaths = @(
    (Invoke-Git -GitArgs @('diff', '--name-only', $headRev, $remoteRef)).StdOut -split "`r?`n" |
        Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() }
)
$forbidden = @($incomingPaths | Where-Object {
    ($_ -match '^\.data/') -or
    (($_ -match '^\.env') -and ($_ -notmatch '\.example$')) -or
    ($_ -match '\.(pem|key|zip|patch)$')
})
if ($forbidden.Count -gt 0) {
    Write-Log ''
    Write-Log 'Commit-urile de tras ating fisiere care nu au ce cauta in repo:' 'Red'
    $forbidden | ForEach-Object { Write-Log ("  {0}" -f $_) 'Red' }
    Exit-With -Code 1 -Message 'Nu fac pull peste .data/secrete. Curata-le pe origin (local nu se rescrie istoric) si ruleaza din nou.' -Color Red
}
Write-Log ''
Write-Log ("garda: {0} fisiere de adus, niciunul .data/.env/secret   |   .data ignorat: da" -f $incomingPaths.Count) 'Green'

# ------------------------------------------------------------------ 4. pull ff-only

Write-Log ''
Write-Log ("2. git pull --ff-only origin {0}" -f $Branch) 'Cyan'
$pull = Invoke-Git -GitArgs @('pull', '--ff-only', 'origin', $Branch) -TimeoutSec ($GitTimeoutSec * 2)
if ($pull.TimedOut) {
    Exit-With -Code 1 -Message ("git pull a depasit {0}s." -f ($GitTimeoutSec * 2)) -Color Red
}
if ($pull.ExitCode -ne 0) {
    Write-Log ($pull.StdErr.Trim()) 'Red'
    Write-Log ($pull.StdOut.Trim()) 'DarkGray'
    Exit-With -Code 1 -Message 'git pull --ff-only a esuat (fisiere netracked ar fi suprascrise sau alta problema). Verifica mesajul de mai sus; nu am fortat nimic.' -Color Red
}
$newRev = (Invoke-Git -GitArgs @('rev-parse', 'HEAD')).StdOut.Trim()
Write-Log ("   ok -> {0}" -f $newRev.Substring(0, [Math]::Min(7, $newRev.Length))) 'Green'

# ------------------------------------------------------------------ 5. ce s-a schimbat

$changedFiles = @(
    (Invoke-Git -GitArgs @('diff', '--name-only', $headRev, $newRev)).StdOut -split "`r?`n" |
        Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() }
)

# Runtime = ce afecteaza procesul care ruleaza. Docs/scripts/.github nu cer restart.
$runtimePattern = '^(src/|public/)' + '|' + '^(server\.ts|vite\.config\.ts|index\.html|electron\.cjs|package\.json|package-lock\.json|tsconfig\.json|capacitor\.config\.ts)'
$runtimeFiles = @($changedFiles | Where-Object { $_ -match $runtimePattern })

Write-Log ''
Write-Log ("Fisiere schimbate: {0} (runtime: {1})" -f $changedFiles.Count, $runtimeFiles.Count)
$changedFiles | ForEach-Object { Write-Log ("  {0}" -f $_) 'DarkGray' }

# ------------------------------------------------------------------ 6. lint

$lintOk = $true
$lintRan = $false

# npm.cmd is a shim: it asks npm-prefix.js for the prefix and can end up looking for
# <repo>\node_modules\npm\bin\npm-cli.js, which does not exist -> "Cannot find module" and the
# lint NEVER runs (observed: the gate refused a restart for a code that was fine). Calling node.exe
# with the global npm CLI by absolute path removes the guesswork; npm.cmd stays as a fallback.
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
$npmCli = if ($nodeExe) { Join-Path (Split-Path $nodeExe) 'node_modules\npm\bin\npm-cli.js' } else { $null }
$npmUsable = [bool]($nodeExe -and $npmCli -and (Test-Path $npmCli))

if (($runtimeFiles.Count -gt 0 -or $ForceRestart) -and -not $SkipLint) {
    Write-Log ''
    Write-Log $(if ($npmUsable) { '3. npm run lint (prin node + npm-cli.js)' } else { '3. npm run lint' }) 'Cyan'
    $lint = if ($npmUsable) {
        Invoke-Exe -FilePath $nodeExe -Arguments @($npmCli, 'run', 'lint') -TimeoutSec $LintTimeoutSec
    } else {
        Invoke-Exe -FilePath 'npm.cmd' -Arguments @('run', 'lint') -TimeoutSec $LintTimeoutSec
    }
    $lintRan = $true
    $lintOutput = ($lint.StdOut + "`n" + $lint.StdErr)
    if ($lint.TimedOut) {
        $lintOk = $false
        Write-Log ("   TIMEOUT dupa {0}s" -f $LintTimeoutSec) 'Red'
    } elseif ($lintOutput -match 'MODULE_NOT_FOUND|Cannot find module') {
        # The lint tool itself did not start. Saying "codul nu trece tsc" here would be a lie.
        $lintOk = $false
        Write-Log '   LINT-UL NU A PUTUT PORNI (npm rupt in acest context):' 'Red'
        ($lintOutput -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 6 | ForEach-Object { Write-Log ("  {0}" -f $_) 'Red' }
    } elseif ($lint.ExitCode -ne 0) {
        $lintOk = $false
        Write-Log '   LINT ROSU:' 'Red'
        ($lint.StdOut -split "`r?`n") | Where-Object { $_.Trim() } | ForEach-Object { Write-Log ("  {0}" -f $_) 'Red' }
        ($lint.StdErr -split "`r?`n") | Where-Object { $_.Trim() } | ForEach-Object { Write-Log ("  {0}" -f $_) 'Red' }
    } else {
        Write-Log '   ok' 'Green'
    }
    if (-not $lintOk -and $lintOutput -match 'MODULE_NOT_FOUND|Cannot find module') {
        Exit-With -Code 1 -Message 'Lint-ul nu a putut rula (npm nu e utilizabil din acest context), deci NU pot valida codul si NU repornesc. Instanta veche ramane sus. Rezolva npm-ul (npm -v in repo) si ruleaza din nou.' -Color Red
    }
} elseif ($SkipLint) {
    Write-Log ''
    Write-Log '3. lint sarit (-SkipLint)' 'Yellow'
} else {
    Write-Log ''
    Write-Log '3. lint sarit (nu s-a schimbat cod runtime)' 'DarkGray'
}

if (-not $lintOk) {
    Exit-With -Code 1 -Message 'Codul nou nu trece tsc. NU repornesc serverul: instanta veche ramane sus si functionala. Rezolva lint-ul (sau revino cu git revert) si ruleaza din nou.' -Color Red
}

# ------------------------------------------------------------------ 7. restart

$shouldRestart = $false
if ($Restart) {
    if ($runtimeFiles.Count -gt 0) { $shouldRestart = $true }
    elseif ($ForceRestart) { $shouldRestart = $true }
}

Write-Log ''
if (-not $Restart) {
    Write-Log '4. restart sarit (nu s-a cerut -Restart)' 'DarkGray'
} elseif (-not $shouldRestart) {
    Write-Log '4. restart sarit: s-au schimbat doar fisiere non-runtime (docs/scripts/config repo).' 'DarkGray'
    Write-Log '   Foloseste -ForceRestart daca vrei repornire oricum.' 'DarkGray'
} else {
    $restartScript = Join-Path $PSScriptRoot 'restart-app.ps1'
    if (-not (Test-Path $restartScript)) {
        Exit-With -Code 1 -Message ("Nu gasesc {0}. Codul e actualizat, dar serverul NU a fost repornit." -f $restartScript) -Color Red
    }

    Write-Log ("4. restart: lansez restart-app.ps1 -Port {0} (detasat)" -f $Port) 'Cyan'

    # Detasat intentionat: daca sync-ul a fost lansat din serverul insusi, serverul
    # moare in timpul restartului, iar scriptul de restart trebuie sa supravietuiasca.
    try {
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $restartScript, '-Port', [string] $Port) `
            -WorkingDirectory $script:RepoRoot `
            -WindowStyle Hidden | Out-Null
        Write-Log '   lansat (health-ul nu se asteapta aici; verifica /api/health)' 'Green'
    } catch {
        Exit-With -Code 1 -Message ("Codul e actualizat, dar lansarea restart-app.ps1 a esuat: {0}" -f $_.Exception.Message) -Color Red
    }
}

# ------------------------------------------------------------------ rezumat

Write-Log ''
Write-Log 'Sincronizare incheiata.' 'Green'
Write-Log ("  {0} -> {1}   |   {2} fisiere   |   lint: {3}   |   restart: {4}" -f `
    $headRev.Substring(0, [Math]::Min(7, $headRev.Length)), `
    $newRev.Substring(0, [Math]::Min(7, $newRev.Length)), `
    $changedFiles.Count, `
    $(if ($lintRan) { 'ok' } else { 'sariti' }), `
    $(if ($shouldRestart) { 'lansat' } else { 'nu' })) 'Green'

exit 0

} finally {
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}

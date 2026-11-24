param([switch]$ColdBuild, [ValidateSet('phase6', 'phase7', 'phase8')][string]$Stage = 'phase6')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
& docker version --format '{{.Server.Version}}'
if ($LASTEXITCODE -ne 0) { throw 'Docker engine is unavailable' }

# A separate project, fresh caches and an empty template protect the local application.
$runID = $Stage + '-' + [Guid]::NewGuid().ToString('N')
$evidence = Join-Path $root ('.local/' + $Stage + '/' + $runID)
New-Item -ItemType Directory -Path $evidence | Out-Null
$token = 'synthetic-' + $runID
$settings = @{
    COMPOSE_PROJECT_NAME = $runID
    TRYON_API_KEYS = "$token,$token-retry"
    TRYON_DAILY_ATTEMPT_LIMIT = '10'
    MODEL_PROVIDER = ''
    MODEL_NAME = ''
    MODEL_BASE_URL = ''
    MODEL_API_KEY = ''
    VOWMIRROR_WEB_PORT = '3006'
    VOWMIRROR_GO_MOD_VOLUME = $runID + '-mod'
    VOWMIRROR_GO_BUILD_VOLUME = $runID + '-build'
    VOWMIRROR_ACCEPTANCE_OFFLINE = 'true'
    VOWMIRROR_SOURCE_MODE = 'ro'
    VOWMIRROR_EVIDENCE_DIR = ($evidence -replace '\\', '/') + '/screenshots'
}
$previous = @{}
foreach ($name in $settings.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$composeArgs = @('compose', '-f', 'compose.yaml', '--env-file', '.env.example', '-p', $runID)
$boundary = Join-Path $evidence 'boundary.env'
$step = 0
function Invoke-Compose {
    param([string[]]$Arguments)
    $script:step++
    $log = Join-Path $evidence ('{0:D2}.log' -f $script:step)
    Write-Host ('Checking: docker compose ' + ($Arguments -join ' '))
    # Windows PowerShell treats redirected native stderr as ErrorRecords, even
    # for normal Docker progress. Judge the native exit status explicitly.
    $preference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & docker @composeArgs @Arguments *> $log
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $preference }
    if ($code -ne 0) {
        Get-Content -LiteralPath $log -Tail 50 | Write-Host
        throw ('Compose check failed; evidence: ' + (Split-Path -Leaf $log))
    }
    Get-Content -LiteralPath $log -Tail 8 | Write-Host
}

$verificationError = $null
$cleanupError = $null
try {
    foreach ($name in $settings.Keys) { [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process') }
    [IO.File]::WriteAllText($boundary, "TRYON_API_KEYS=$token`n", [Text.UTF8Encoding]::new($false))
    Invoke-Compose @('config', '--quiet')
    $build = @('build')
    if ($ColdBuild) { $build += '--no-cache' }
    if ($env:GOPROXY) { $build += @('--build-arg', ('GOPROXY=' + $env:GOPROXY)) }
    Invoke-Compose ($build + @('tools-go', 'tools-node', 'tools-browser', 'web', 'backend'))

    # The rebuilt image supplies freshly downloaded modules to the new named volume.
    # Compile test binaries before the hard test deadline, including on a cold cache.
    Invoke-Compose @('run', '--rm', '-T', 'tools-go', 'sh', '-ec', 'for package in $(go list ./...); do go test -c -o /tmp/phase6-test $package; done')
    Invoke-Compose @('run', '--rm', '-T', 'tools-go', 'timeout', '-s', 'TERM', '-k', '2s', '58s', 'go', 'test', '-count=1', '-timeout=55s', '-v', './internal/facedetect')
    Invoke-Compose @('run', '--rm', '-T', 'tools-go', 'timeout', '-s', 'TERM', '-k', '2s', '58s', 'go', 'test', '-count=1', '-timeout=55s', '-run', 'TestFaceGateStopsBeforeAssetsAndAccounting|TestAcceptanceHTTPErrorsDoNotLeakSensitiveData|TestProductionCoupleRouteRejectsUnconfiguredModel', './internal/logic/tryon', './internal/cmd')
    Invoke-Compose @('run', '--rm', '-T', 'tools-go')
    Invoke-Compose @('run', '--rm', '-T', 'tools-node')

    $tracked = & git ls-files --cached --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect tracked source files' }
    $images = @($tracked | Where-Object { $_ -match '\.(png|jpe?g|webp)$' })
    $expected = @('backend/internal/imagevalidate/testdata/checker.jpg', 'backend/internal/imagevalidate/testdata/checker.png', 'backend/internal/imagevalidate/testdata/checker.webp')
    $faceFixtures = @('one.jpg', 'two.jpg', 'three.jpg', 'two-exif6.jpg') | ForEach-Object { 'backend/internal/facedetect/testdata/' + $_ }
    $expected += $faceFixtures
    $publicAssets = Get-Content -LiteralPath 'web/public/manifest.json' -Raw | ConvertFrom-Json
    $expected += @($publicAssets.assets | ForEach-Object { 'web/public/' + $_.file })
    $expected += @($publicAssets.outfitPreviews | ForEach-Object { 'web/public/' + $_.display.file; 'web/public/' + $_.thumbnail.file })
    if (Compare-Object ($images | Sort-Object) ($expected | Sort-Object)) { throw 'Unexpected tracked image' }
    if ($tracked | Where-Object { $_ -match '(^|/)(\.env|config\.yaml|private/|node_modules/|go-build/)|\.(exe|log|test)$' -and $_ -ne '.env.example' }) {
        throw 'Private input or build artifact entered tracked source'
    }

    foreach ($entry in @(@('web', '/usr/share/nginx/html'), @('backend', '/app'))) {
        Invoke-Compose @('run', '--rm', '--no-deps', '-T', '-v', "${root}/docker/check-image.sh:/run/check-image.sh:ro", '-v', "${boundary}:/run/boundary.env:ro", '--entrypoint', 'sh', $entry[0], '/run/check-image.sh', $entry[1])
    }
    Invoke-Compose @('up', '-d', '--wait', 'web', 'backend')
    Invoke-Compose @('exec', '-T', 'backend', 'sh', '-ec', 'test ${#TRYON_API_KEYS} -ge 32; test ${#MODEL_API_KEY} -eq 0; test ${#MODEL_PROVIDER} -eq 0; test ${#MODEL_NAME} -eq 0; test ${#MODEL_BASE_URL} -eq 0; test ! -e /assets/wedding/private; test -d /assets/wedding/poses; test ! -e /app/.env; test ! -e /app/manifest/config/config.yaml; test ! -e /usr/local/go')

    # Both application and test networks must have no external route during execution.
    $networkIDs = & docker network ls --filter "label=com.docker.compose.project=$runID" --format '{{.ID}}'
    if ($LASTEXITCODE -ne 0 -or @($networkIDs).Count -ne 2) { throw 'Missing isolated acceptance networks' }
    foreach ($networkID in $networkIDs) {
        $internal = & docker network inspect $networkID --format '{{.Internal}}'
        if ($LASTEXITCODE -ne 0 -or $internal -ne 'true') { throw 'Acceptance network has external routing' }
    }
    Invoke-Compose @('run', '--rm', '-T', 'tools-browser', 'node', '--test', 'tests/browser-safety.test.mjs')
    Invoke-Compose @('run', '--rm', '-T', 'tools-browser', 'node', 'tests/invitation-audio.mjs')
    Invoke-Compose @('run', '--rm', '-T', 'tools-browser', 'node', 'tests/http-acceptance.mjs')
    Invoke-Compose @('run', '--rm', '-T', 'tools-browser', 'node', 'tests/smoke.mjs', '--stage', $Stage)
    Invoke-Compose @('run', '--rm', '-T', 'tools-browser', 'node', 'tests/gallery-fit.mjs')
    Invoke-Compose @('run', '--rm', '-T', 'tools-browser', 'node', 'tests/outfit-previews.mjs')
    Invoke-Compose @('restart', 'backend')
    Invoke-Compose @('up', '-d', '--wait', 'web', 'backend')
    Invoke-Compose @('run', '--rm', '-T', 'tools-browser', 'node', 'tests/restart-acceptance.mjs')
    Invoke-Compose @('run', '--rm', '-T', 'tools-browser', 'node', 'tests/face-gate-browser.mjs')
    Invoke-Compose @('logs', '--no-color', 'web', 'backend')
    $markers = @($token, 'synthetic-body-limit-client-marker', 'synthetic-acceptance-private-marker', [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root 'backend/internal/imagevalidate/testdata/checker.png'))))
    $markers += $faceFixtures | ForEach-Object { [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root $_))) }
    foreach ($log in Get-ChildItem -LiteralPath $evidence -Filter '*.log') {
        foreach ($marker in $markers) {
            if ([IO.File]::ReadAllText($log.FullName).Contains($marker)) { throw 'Runtime sensitive marker entered evidence logs' }
        }
    }
    $imageIDs = & docker @composeArgs images -q web backend
    if ($LASTEXITCODE -ne 0) { throw 'Cannot record application images' }
    foreach ($imageID in $imageIDs) {
        $metadata = & docker image inspect $imageID
        if ($LASTEXITCODE -ne 0 -or ($metadata -join "`n").Contains($token)) { throw 'Runtime marker entered image metadata' }
    }
} catch {
    $verificationError = $_
} finally {
    try {
        & docker @composeArgs --profile tools down --volumes --remove-orphans
        if ($LASTEXITCODE -ne 0) { throw 'Acceptance container/cache cleanup failed' }
        foreach ($resource in @('container', 'volume', 'network')) {
            $listArgs = @($resource, 'ls', '--quiet', '--filter', "label=com.docker.compose.project=$runID")
            if ($resource -eq 'container') { $listArgs += '--all' }
            $remaining = & docker @listArgs
            if ($LASTEXITCODE -ne 0 -or $remaining) { throw ('Acceptance cleanup left ' + $resource + ' resources') }
        }
    } catch {
        $cleanupError = $_
    } finally {
        foreach ($name in $settings.Keys) {
            $restoreValue = $previous[$name]
            # PowerShell 7 can preserve empty strings; absent variables need a true null.
            if ($null -eq $restoreValue) { $restoreValue = [NullString]::Value }
            [Environment]::SetEnvironmentVariable($name, $restoreValue, 'Process')
        }
    }
}
if ($verificationError -and $cleanupError) {
    throw [AggregateException]::new('Acceptance and cleanup both failed', [Exception[]]@($verificationError.Exception, $cleanupError.Exception))
}
if ($verificationError) { throw $verificationError }
if ($cleanupError) { throw $cleanupError }
[IO.File]::WriteAllText((Join-Path $evidence 'summary.json'), (@{
    coldBuild = [bool]$ColdBuild; images = @($imageIDs); offlineNetworks = 2
    stage = $Stage; checks = $step; result = 'passed'; cleanup = 'passed'; modelConfiguration = 'empty'; realModelCalls = 0
} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host ($Stage + ' acceptance passed; model configuration empty; runtime networks internal.')

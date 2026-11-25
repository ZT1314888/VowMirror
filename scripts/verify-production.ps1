param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
& docker version --format '{{.Server.Version}}'
if ($LASTEXITCODE -ne 0) { throw 'Docker engine is unavailable' }
$runID = 'production-' + [Guid]::NewGuid().ToString('N')
$evidence = Join-Path $root ('.local/production-deployment/' + $runID)
$certificates = Join-Path $evidence 'certificates'
$empty = Join-Path $evidence 'empty'
$partial = Join-Path $evidence 'partial'
$invalid = Join-Path $evidence 'invalid'
foreach ($directory in @($evidence, $certificates, $empty, $partial, $invalid)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
$settings = @{
    TRYON_API_KEYS = 'synthetic-production-' + [Guid]::NewGuid().ToString('N')
    MODEL_PROVIDER = ''; MODEL_NAME = ''; MODEL_BASE_URL = ''; MODEL_API_KEY = ''
    VOWMIRROR_WEB_PORT = '0'; VOWMIRROR_HTTPS_BIND = '127.0.0.1'; VOWMIRROR_HTTPS_PORT = '0'
    VOWMIRROR_SSL_DIR = ($certificates -replace '\\', '/')
    VOWMIRROR_ACCEPTANCE_OFFLINE = 'true'
    VOWMIRROR_GO_MOD_VOLUME = $runID + '-mod'
    VOWMIRROR_GO_BUILD_VOLUME = $runID + '-build'
    VOWMIRROR_EVIDENCE_DIR = ($evidence -replace '\\', '/') + '/browser-unused'
}
$previous = @{}
foreach ($name in $settings.Keys) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$compose = @('compose', '-f', 'compose.yaml', '--env-file', '.env.example', '-p', $runID)
$step = 0
function Invoke-Docker {
    param([string[]]$Arguments, [switch]$ExpectFailure, [int[]]$ExpectedExitCodes)
    $script:step++
    $log = Join-Path $evidence ('{0:D2}.log' -f $script:step)
    $preference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & docker @Arguments *> $log
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $preference }
    $failed = if ($ExpectedExitCodes) { $code -notin $ExpectedExitCodes }
        elseif ($ExpectFailure) { $code -eq 0 }
        else { $code -ne 0 }
    if ($failed) {
        Get-Content -LiteralPath $log -Tail 25 | Write-Host
        throw ('Production check failed; log: ' + (Split-Path -Leaf $log))
    }
    Get-Content -LiteralPath $log -Tail 3 | Write-Host
}
function Invoke-Compose {
    param([string[]]$Arguments, [switch]$ExpectFailure, [int[]]$ExpectedExitCodes)
    Invoke-Docker -Arguments ($compose + $Arguments) -ExpectFailure:$ExpectFailure -ExpectedExitCodes:$ExpectedExitCodes
}
$network = $runID + '-cloudflare'
$networkCreated = $false
$verificationError = $null
$cleanupError = $null
try {
    foreach ($name in $settings.Keys) { [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process') }
    Invoke-Compose @('build', 'tools-node', 'tools-backup', 'tools-browser', 'web', 'backend')
    Invoke-Compose @('run', '--rm', '-T', 'tools-node', 'sh', '-ec', 'shellcheck docker/enable-ssl.sh docker/snapshot-usage.sh scripts/backup-usage.sh scripts/deploy-production.sh; node --test tests/production-deployment.test.mjs')
    Invoke-Compose @('run', '--rm', '--no-deps', '-T', '-v', "${certificates}:/certificates", 'tools-node', 'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web', '-addext', 'subjectAltName=DNS:web,DNS:vowmirror.ggff.net', '-keyout', '/certificates/origin.key', '-out', '/certificates/origin.crt')
    Copy-Item -LiteralPath (Join-Path $certificates 'origin.crt') -Destination $partial
    [IO.File]::WriteAllText((Join-Path $invalid 'origin.crt'), 'invalid synthetic certificate')
    [IO.File]::WriteAllText((Join-Path $invalid 'origin.key'), 'invalid synthetic key')
    $fixture = "${root}/tests/production-container.sh:/run/production-container.sh:ro"
    Invoke-Compose @('run', '--rm', '--no-deps', '-T', '-v', $fixture, '-v', "${empty}:/etc/nginx/ssl:ro", '--entrypoint', 'sh', 'web', '/run/production-container.sh', 'tls-empty')
    Invoke-Compose -Arguments @('run', '--rm', '--no-deps', '-T', '-v', $fixture, '-v', "${partial}:/etc/nginx/ssl:ro", '--entrypoint', 'sh', 'web', '/run/production-container.sh', 'tls-partial') -ExpectFailure
    Invoke-Compose -Arguments @('run', '--rm', '--no-deps', '-T', '-v', $fixture, '-v', "${invalid}:/etc/nginx/ssl:ro", '--entrypoint', 'sh', 'web', '/run/production-container.sh', 'tls-invalid') -ExpectFailure
    Invoke-Compose @('run', '--rm', '--no-deps', '-T', '-v', $fixture, '--entrypoint', 'sh', 'web', '/run/production-container.sh', 'tls-valid')
    # Fresh deploys run backup-usage.sh before backend starts; the created usage volume must stay writable by 65532:65532.
    Invoke-Compose -Arguments @('run', '--rm', '--no-deps', '-T', 'tools-backup') -ExpectedExitCodes @(3)
    Invoke-Compose @('up', '-d', '--wait', 'web', 'backend')
    Invoke-Compose @('run', '--rm', '-T', '-v', "${certificates}:/certificates:ro", 'tools-browser', 'node', 'tests/production-http.mjs')
    $writer = $runID + '-writer'
    Invoke-Compose @('run', '-d', '--name', $writer, '-v', "${runID}_usage:/usage", 'tools-browser', 'node', 'tests/production-http.mjs', '--wal-writer')
    $ready = $false
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        & docker exec $writer test -s /tmp/wal-ready
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Milliseconds 200
    }
    if (-not $ready) { throw 'WAL writer did not become ready' }
    Invoke-Compose @('run', '--rm', '--no-deps', '-T', '-v', $fixture, '--entrypoint', 'sh', 'tools-backup', '/run/production-container.sh', 'snapshot')
    # Emulate an actual trusted source subnet on a separate internal-only test network.
    Invoke-Docker @('network', 'create', '--internal', '--subnet', '173.245.63.224/28', $network)
    $networkCreated = $true
    $web = & docker @compose ps --quiet web
    if ($LASTEXITCODE -ne 0 -or -not $web) { throw 'Production test web container is missing' }
    Invoke-Docker @('network', 'connect', '--ip', '173.245.63.226', $network, $web)
    $peer = $runID + '-cloudflare-peer'
    Invoke-Compose @('run', '-d', '--name', $peer, '-v', "${certificates}:/certificates:ro", 'tools-node', 'sleep', 'infinity')
    Invoke-Docker @('network', 'connect', '--ip', '173.245.63.227', $network, $peer)
    Invoke-Docker @('exec', '-e', 'PRODUCTION_TEST_HOST=173.245.63.226', $peer, 'node', 'tests/production-http.mjs', '--cloudflare')
    Invoke-Docker @('stop', '--timeout', '5', $writer)
    Invoke-Docker @('rm', $writer)
    Invoke-Compose @('stop', 'backend')
    Invoke-Compose @('run', '--rm', '--no-deps', '-T', '-v', $fixture, '--entrypoint', 'sh', 'tools-backup', '/run/production-container.sh', 'snapshot-closed')
    # Respect the backend dependency before testing a fresh Nginx startup/DNS resolution.
    Invoke-Compose @('up', '-d', '--wait', 'backend')
    Invoke-Compose @('restart', 'web')
    Invoke-Compose @('up', '-d', '--wait', 'web', 'backend')
    Invoke-Compose @('exec', '-T', 'web', 'nginx', '-t')
} catch { $verificationError = $_ }
finally {
    try {
        & docker @compose --profile tools down --volumes --remove-orphans
        if ($LASTEXITCODE -ne 0) { throw 'Production acceptance cleanup failed' }
        if ($networkCreated) {
            & docker network rm $network
            if ($LASTEXITCODE -ne 0) { throw 'Cloudflare test network cleanup failed' }
        }
        foreach ($resource in @('container', 'volume', 'network')) {
            $arguments = @($resource, 'ls', '--quiet', '--filter', "label=com.docker.compose.project=$runID")
            if ($resource -eq 'container') { $arguments += '--all' }
            $remaining = & docker @arguments
            if ($LASTEXITCODE -ne 0 -or $remaining) { throw ('Production cleanup left ' + $resource + ' resources') }
        }
        # Synthetic certificate keys are useful only for this run; remove their exact known paths.
        foreach ($key in @((Join-Path $certificates 'origin.key'), (Join-Path $invalid 'origin.key'))) {
            if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key }
        }
    } catch { $cleanupError = $_ }
    finally {
        foreach ($name in $settings.Keys) {
            $value = $previous[$name]
            if ($null -eq $value) { $value = [NullString]::Value }
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}
if ($verificationError -and $cleanupError) { throw [AggregateException]::new('Verification and cleanup failed', [Exception[]]@($verificationError.Exception, $cleanupError.Exception)) }
if ($verificationError) { throw $verificationError }
if ($cleanupError) { throw $cleanupError }
[IO.File]::WriteAllText((Join-Path $evidence 'summary.json'), (@{ checks = $step; result = 'passed'; cleanup = 'passed'; realModelCalls = 0 } | ConvertTo-Json))
Write-Host 'Production TLS, real-IP and encrypted WAL backup acceptance: PASS'

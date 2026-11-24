param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
& docker version --format '{{.Server.Version}}'
if ($LASTEXITCODE -ne 0) { throw 'Docker engine is unavailable; start Docker Desktop before retrying' }

$runID = 'entry-' + [Guid]::NewGuid().ToString('N')
$evidence = Join-Path $root ('.local/api-entry/' + $runID)
New-Item -ItemType Directory -Path $evidence | Out-Null
$token = 'synthetic-entry-' + [Guid]::NewGuid().ToString('N')
$settings = @{
    TRYON_API_KEYS = "$token-a,$token-b,$token-c,$token-d"
    TRYON_DAILY_ATTEMPT_LIMIT = '10'
    MODEL_PROVIDER = ''; MODEL_NAME = ''; MODEL_BASE_URL = ''; MODEL_API_KEY = ''
    VOWMIRROR_WEB_PORT = '0'
    VOWMIRROR_ACCEPTANCE_OFFLINE = 'true'
    VOWMIRROR_GO_MOD_VOLUME = $runID + '-mod'
    VOWMIRROR_GO_BUILD_VOLUME = $runID + '-build'
    VOWMIRROR_SOURCE_MODE = 'ro'
    VOWMIRROR_EVIDENCE_DIR = ($evidence -replace '\\', '/') + '/browser-unused'
}
$previous = @{}
foreach ($name in $settings.Keys) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$composeArgs = @('compose', '-f', 'compose.yaml', '--env-file', '.env.example', '-p', $runID)
$step = 0
function Invoke-Compose {
    param([string[]]$Arguments)
    Invoke-Docker ($composeArgs + $Arguments)
}
function Invoke-Docker {
    param([string[]]$Arguments)
    $script:step++
    $log = Join-Path $evidence ('{0:D2}.log' -f $script:step)
    Write-Host ('Checking: docker ' + ($Arguments -join ' '))
    $preference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & docker @Arguments *> $log
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $preference }
    Get-Content -LiteralPath $log -Tail 12 | Write-Host
    if ($code -ne 0) { throw ('Docker check failed; evidence: ' + (Split-Path -Leaf $log)) }
}

function Assert-AcceptanceNetworks {
    $record = [ordered]@{ networks = @(); containers = @(); result = 'failed' }
    try {
        foreach ($role in @('app', 'default')) {
            $raw = & docker network inspect ($runID + '_' + $role) --format '{{json .}}'
            if ($LASTEXITCODE -ne 0) { throw ('Cannot inspect ' + $role + ' network') }
            $network = $raw | ConvertFrom-Json
            $record.networks += [ordered]@{
                role = $role; name = $network.Name; id = $network.Id; internal = $network.Internal
            }
            if (-not $network.Internal) { throw ('Acceptance network is not internal: ' + $role) }
        }
        $app = $record.networks[0]
        $containers = [ordered]@{ web = ''; backend = ''; peer = $peer; runner = $runner }
        foreach ($role in @('web', 'backend')) {
            $containers[$role] = & docker @composeArgs ps --quiet $role
            if ($LASTEXITCODE -ne 0 -or @($containers[$role]).Count -ne 1 -or -not $containers[$role]) {
                throw ('Missing acceptance container: ' + $role)
            }
        }
        foreach ($role in $containers.Keys) {
            $raw = & docker inspect $containers[$role] --format '{{json .NetworkSettings.Networks}}'
            if ($LASTEXITCODE -ne 0) { throw ('Cannot inspect network attachments: ' + $role) }
            $attachments = @((($raw | ConvertFrom-Json).PSObject.Properties))
            $entry = [ordered]@{ role = $role; networks = @(); result = 'failed' }
            foreach ($attachment in $attachments) {
                $internal = & docker network inspect $attachment.Value.NetworkID --format '{{.Internal}}'
                if ($LASTEXITCODE -ne 0) { throw ('Cannot inspect attached network: ' + $role) }
                $entry.networks += [ordered]@{
                    name = $attachment.Name; id = $attachment.Value.NetworkID; internal = ($internal -eq 'true')
                }
            }
            $record.containers += $entry
            if ($attachments.Count -ne 1 -or $attachments[0].Name -ne $app.name -or
                $attachments[0].Value.NetworkID -ne $app.id) {
                throw ('Acceptance container must attach only to the project app network: ' + $role)
            }
            $entry.result = 'passed'
        }
        $record.result = 'passed'
    } finally {
        [IO.File]::WriteAllText((Join-Path $evidence 'networks.json'), ($record | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    }
}

$verificationError = $null
$cleanupError = $null
try {
    foreach ($name in $settings.Keys) { [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process') }
    Invoke-Compose @('config', '--quiet')
    $build = @('build')
    if ($env:GOPROXY) { $build += @('--build-arg', ('GOPROXY=' + $env:GOPROXY)) }
    Invoke-Compose ($build + @('tools-go', 'tools-browser'))
    # Dependency/compilation preparation is outside the hard test deadline.
    Invoke-Compose @('run', '--rm', '-T', 'tools-go', 'sh', '-ec', 'for package in ./internal/security ./internal/middleware ./internal/cmd ./internal/logic/tryon; do go test -c -o /tmp/entry-test "$package"; done')
    $tests = '^(TestRateLimiter|TestRateLimitMiddleware|TestServerHeaderLimit|TestAcceptanceHTTPErrorsDoNotLeakSensitiveData|TestFaceGateStopsBeforeAssetsAndAccounting)$'
    Invoke-Compose @('run', '--rm', '-T', 'tools-go', 'timeout', '-s', 'TERM', '-k', '2s', '58s', 'go', 'test', '-count=1', '-timeout=55s', '-run', $tests, './internal/security', './internal/middleware', './internal/cmd', './internal/logic/tryon')
    Invoke-Compose @('run', '--rm', '-T', 'tools-go', 'sh', '-ec', 'test -z "$(gofmt -l internal/cmd/entry_protection_test.go)"; go vet ./internal/cmd ./internal/middleware ./internal/security')
    Invoke-Compose @('run', '--rm', '-T', 'tools-browser', 'node', '--check', 'tests/api-entry-protection.mjs')
    Invoke-Compose @('run', '--rm', '-T', 'tools-browser', 'node', '--check', 'tests/http-acceptance.mjs')
    Invoke-Compose ($build + @('web', 'backend'))
    Invoke-Compose @('up', '-d', '--wait', 'web', 'backend')
    Invoke-Compose @('exec', '-T', 'web', 'nginx', '-t')
    Invoke-Compose @('exec', '-T', 'backend', 'sh', '-ec', 'test -n "$TRYON_API_KEYS"; test -z "$MODEL_PROVIDER$MODEL_NAME$MODEL_BASE_URL$MODEL_API_KEY"')
    $peer = $runID + '-peer'
    $runner = $runID + '-runner'
    Invoke-Compose @('run', '-d', '--name', $peer, 'tools-browser', 'sleep', 'infinity')
    Invoke-Compose @('run', '-d', '--name', $runner, '-e', "ENTRY_PEER_URL=http://${peer}:8099", '-v', "${runID}_usage:/usage:ro", 'tools-browser', 'sleep', 'infinity')
    Assert-AcceptanceNetworks
    Invoke-Docker @('exec', '-d', $peer, 'node', 'tests/api-entry-protection.mjs', '--peer')
    Invoke-Docker @('exec', $runner, 'node', 'tests/api-entry-protection.mjs')
    Invoke-Docker @('logs', $peer)
    Invoke-Compose @('logs', '--no-color', 'web', 'backend')
    Write-Host 'API entry protection targeted verification passed (no full suite or browser smoke).'
} catch { $verificationError = $_ }
finally {
    try {
        & docker @composeArgs --profile tools down --rmi local --volumes --remove-orphans
        if ($LASTEXITCODE -ne 0) { throw 'Isolated resource cleanup failed' }
        foreach ($resource in @('container', 'network', 'volume')) {
            $argsToList = @($resource, 'ls', '--quiet', '--filter', "label=com.docker.compose.project=$runID")
            if ($resource -eq 'container') { $argsToList += '--all' }
            $remaining = & docker @argsToList
            if ($LASTEXITCODE -ne 0 -or $remaining) { throw ('Cleanup left ' + $resource + ' resources') }
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
if ($verificationError -and $cleanupError) {
    throw [AggregateException]::new('Verification and cleanup failed', [Exception[]]@($verificationError.Exception, $cleanupError.Exception))
}
if ($verificationError) { throw $verificationError }
if ($cleanupError) { throw $cleanupError }

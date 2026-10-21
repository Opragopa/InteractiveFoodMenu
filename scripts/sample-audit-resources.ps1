param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9-]{3,16}$')][string]$RunId,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9-]{3,40}$')][string]$Phase,
  [string[]]$ComposeProjects = @('ifm-audit-menu','ifm-audit-appwrite'),
  [string]$ProductionHealthUrl = 'http://127.0.0.1:8091/health',
  [int]$IntervalSeconds = 5,
  [int]$DurationSeconds = 10800
)
$ErrorActionPreference = 'Stop'
if ($IntervalSeconds -lt 2 -or $DurationSeconds -lt 10) { throw 'Invalid sampling interval/duration.' }
foreach ($project in $ComposeProjects) { if ($project -notmatch '^ifm-audit(?:-|$)') { throw 'Only explicit audit Compose projects may be sampled.' } }
if (Test-Path $OutputDirectory) { if (Get-ChildItem -LiteralPath $OutputDirectory -Force | Select-Object -First 1) { throw 'Use a new empty external resource directory.' } }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path
$cursor = $output
while ($cursor) { if (Test-Path (Join-Path $cursor '.git')) { throw 'Resources must be outside the repository.' }; $parent=Split-Path -Parent $cursor; if ($parent -eq $cursor) { break }; $cursor=$parent }
$encoding = New-Object System.Text.UTF8Encoding($false)
$jsonl = Join-Path $output 'resources.jsonl'
$csv = Join-Path $output 'host.csv'
$statusPath = Join-Path $output 'status.json'
$started = [DateTime]::UtcNow
$stopSignal = Join-Path $output 'STOP-SAMPLER'
$expectedContainerIds = @()
function Write-AuditStatus([bool]$Stop, [string]$Reason, $Cpu, $Ram) {
  $status=@{at=[DateTime]::UtcNow.ToString('o');runId=$RunId;phase=$Phase;samplerPid=$PID;samplerStartedAt=$started.ToString('o');stop=$Stop;reason=$Reason;cpuPercent=$Cpu;ramUsedPercent=$Ram}
  $temporary=Join-Path $output 'status.tmp'
  [IO.File]::WriteAllText($temporary,($status|ConvertTo-Json -Compress),$encoding)
  Move-Item -LiteralPath $temporary -Destination $statusPath -Force
}
$highRamSince = $null; $highCpuSince = $null; $healthFailures=0; $nextHealth=[DateTime]::MinValue
$stopReason=$null; $initialRestarts=@{}
while (([DateTime]::UtcNow - $started).TotalSeconds -lt $DurationSeconds) {
  $now=[DateTime]::UtcNow
  if (Test-Path -LiteralPath $stopSignal) { $stopReason='operator_stop_requested'; break }
  try {
    $os=Get-CimInstance Win32_OperatingSystem
    $cpu=[math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average,2)
    $usedRam=[math]::Round(100*(1-$os.FreePhysicalMemory/$os.TotalVisibleMemorySize),2)
    $disk=Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" | Select-Object -First 1
    $wsl=Get-Process -Name 'vmmem*' -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum
    if(-not $expectedContainerIds.Count){
      foreach($project in $ComposeProjects){
        $projectIds=@(& docker ps -q --filter "label=com.docker.compose.project=$project")
        if($LASTEXITCODE -ne 0 -or -not $projectIds.Count){throw 'An audit Compose project has no running containers.'}
        $expectedContainerIds+=@($projectIds | Where-Object {$_})
      }
      $expectedContainerIds=@($expectedContainerIds | Select-Object -Unique)
    }
    # Keep the phase's initial live set. Completed one-off bootstrap containers
    # are excluded, while exit/removal/restart of a monitored service fails shut.
    $containerIds=$expectedContainerIds
    $containerStats=@(& docker stats --no-stream --format '{{json .}}' @containerIds | ForEach-Object {ConvertFrom-Json $_})
    if($LASTEXITCODE -ne 0){throw 'docker stats failed.'}
    $states=@(& docker inspect --format '{{json .}}' @containerIds | ForEach-Object {ConvertFrom-Json $_})
    if($LASTEXITCODE -ne 0){throw 'docker inspect failed.'}
    foreach($state in $states){
      if(-not $initialRestarts.ContainsKey($state.Id)){$initialRestarts[$state.Id]=[int]$state.RestartCount}
      if($state.State.OOMKilled -or [int]$state.RestartCount -gt $initialRestarts[$state.Id] -or -not $state.State.Running){$stopReason='audit_container_oom_restart_or_exit'}
    }
    if($usedRam -gt 90){if(-not $highRamSince){$highRamSince=$now};if(($now-$highRamSince).TotalSeconds -ge 60){$stopReason='host_ram_over_90_percent_60s'}}else{$highRamSince=$null}
    if($cpu -gt 95){if(-not $highCpuSince){$highCpuSince=$now};if(($now-$highCpuSince).TotalSeconds -ge 120){$stopReason='host_cpu_over_95_percent_120s'}}else{$highCpuSince=$null}
    if($ProductionHealthUrl -and $now -ge $nextHealth){
      try{$health=Invoke-WebRequest -UseBasicParsing -Uri $ProductionHealthUrl -TimeoutSec 5;if($health.StatusCode -ne 200){throw 'Health failed'};$healthFailures=0;$nextHealth=$now.AddSeconds(30)}
      catch{$healthFailures++;$nextHealth=$now.AddSeconds(5);if($healthFailures -ge 2){$stopReason='production_health_failed_twice'}}
    }
    $hostRow=[pscustomobject]@{at=$now.ToString('o');runId=$RunId;phase=$Phase;cpuPercent=$cpu;ramUsedPercent=$usedRam;ramFreeMiB=[math]::Round($os.FreePhysicalMemory/1024);wslWorkingSetMiB=[math]::Round($wsl.Sum/1MB);diskQueue=$disk.CurrentDiskQueueLength;diskSecondsPerTransfer=$disk.AvgDisksecPerTransfer;healthFailures=$healthFailures}
    $hostRow | Export-Csv -LiteralPath $csv -NoTypeInformation -Append -Encoding UTF8
    $row=@{at=$now.ToString('o');runId=$RunId;phase=$Phase;host=$hostRow;containers=$containerStats;states=@($states|ForEach-Object {@{id=$_.Id;name=$_.Name;running=$_.State.Running;oomKilled=$_.State.OOMKilled;restartCount=$_.RestartCount}});stop=[bool]$stopReason;reason=$stopReason}
    [IO.File]::AppendAllText($jsonl,($row|ConvertTo-Json -Depth 12 -Compress)+[Environment]::NewLine,$encoding)
    Write-AuditStatus ([bool]$stopReason) $stopReason $cpu $usedRam
    if($stopReason){[IO.File]::WriteAllText((Join-Path $output 'STOP'),$stopReason,$encoding);break}
  } catch {
    $stopReason='resource_sampler_failed'
    Write-AuditStatus $true $stopReason $null $null
    [IO.File]::WriteAllText((Join-Path $output 'STOP'),$stopReason,$encoding)
    throw 'Resource sampler failed; load must stop. Inspect local sampler diagnostics without exposing secrets.'
  }
  Start-Sleep -Seconds $IntervalSeconds
}
if(-not $stopReason){$stopReason='resource_sampler_finished'}
Write-AuditStatus $true $stopReason $null $null
[IO.File]::WriteAllText((Join-Path $output 'sampler-finished.json'),(@{at=[DateTime]::UtcNow.ToString('o');runId=$RunId;phase=$Phase;reason=$stopReason}|ConvertTo-Json -Compress),$encoding)

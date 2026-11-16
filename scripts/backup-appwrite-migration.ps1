param(
  [Parameter(Mandatory=$true)][string]$RepoPath,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$ApiContainer='interactivefoodmenu-api-1',
  [string]$WebContainer='interactivefoodmenu-web-1',
  [string]$ProxyContainer='interactivefoodmenu-proxy-1',
  [string]$AppwriteContainer='appwrite',
  [string]$DatabaseContainer='appwrite-postgresql',
  [string[]]$AdditionalConfig=@(),
  [switch]$SourceFrozen
)
$ErrorActionPreference='Stop'
if(-not $SourceFrozen){throw 'Stop all application writers and confirm -SourceFrozen. This script never stops services.'}
$repo=(Resolve-Path -LiteralPath $RepoPath).Path
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $output){throw 'Use a new external backup directory.'}
$cursor=Split-Path -Parent $output
while($cursor){
 if(Test-Path -LiteralPath (Join-Path $cursor '.git')){throw 'Backup must be outside every Git repository.'}
 $parent=Split-Path -Parent $cursor;if($parent -eq $cursor){break};$cursor=$parent
}
function Inspect-One([string]$Name){
 $raw=docker inspect $Name
 if($LASTEXITCODE){throw "Cannot inspect $Name"}
 return @($raw|ConvertFrom-Json)[0]
}
$api=Inspect-One $ApiContainer
$web=Inspect-One $WebContainer
$proxy=Inspect-One $ProxyContainer
$appwrite=Inspect-One $AppwriteContainer
$db=Inspect-One $DatabaseContainer
if($api.Config.Labels.'com.docker.compose.project' -ne 'interactivefoodmenu' -or
   $web.Config.Labels.'com.docker.compose.project' -ne 'interactivefoodmenu' -or
   $proxy.Config.Labels.'com.docker.compose.project' -ne 'interactivefoodmenu' -or
   $appwrite.Config.Labels.'com.docker.compose.project' -ne 'appwrite' -or
   $db.Config.Labels.'com.docker.compose.project' -ne 'appwrite'){throw 'Unexpected source container project.'}
if($api.State.Running){throw 'Application API must already be stopped; this script will not stop it.'}
if(-not $db.State.Running){throw 'Source PostgreSQL is stopped. Restore source availability before backup.'}
if(-not @($appwrite.Mounts|Where-Object {$_.Destination -eq '/storage/uploads'}).Count){throw 'Source storage mount missing.'}
$appwritePath=$appwrite.Config.Labels.'com.docker.compose.project.working_dir'
$files=@((Join-Path $repo '.env.backend'),(Join-Path $repo '.env.deploy'),(Join-Path $repo 'compose.yaml'),
 (Join-Path $appwritePath '.env'),(Join-Path $appwritePath 'docker-compose.yml'))+@($AdditionalConfig)
foreach($file in $files){if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'A required backup configuration file is missing.'}}
New-Item -ItemType Directory -Path $output|Out-Null
# Configuration copies include secrets: remove inherited broad directory access.
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $output -AclObject $acl
$temporary='/tmp/ifm-backup-'+[guid]::NewGuid().ToString('N')+'.dump'
try{
 # Binary dump stays in Docker until copied; never pipe it through PowerShell.
 $dumpCommand='pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f '+$temporary
 docker exec $DatabaseContainer sh -c $dumpCommand
 if($LASTEXITCODE){throw 'Source database dump failed.'}
 docker exec $DatabaseContainer pg_restore --list $temporary |Out-Null
 if($LASTEXITCODE){throw 'Source archive catalog cannot be read.'}
 docker cp ($DatabaseContainer+':'+$temporary) (Join-Path $output 'appwrite.dump')
 if($LASTEXITCODE){throw 'Source dump copy failed.'}
 # Reuse the installed image; no pull. Source volumes are mounted read-only.
 docker run --rm --network none --read-only --volumes-from ($AppwriteContainer+':ro') --volume ($output+':/backup') --entrypoint sh $appwrite.Image -c 'tar -cf /backup/appwrite-storage.tar -C /storage .'
 if($LASTEXITCODE){throw 'Appwrite storage archive failed.'}
 docker image save --output (Join-Path $output 'rollback-images.tar') $api.Image $web.Image $proxy.Image
 if($LASTEXITCODE){throw 'Rollback image export failed.'}
 $configMap=@();$n=0
 foreach($file in $files){$n++;$name=('config-'+$n+'-'+[IO.Path]::GetFileName($file));Copy-Item -LiteralPath $file -Destination (Join-Path $output $name);$configMap+=@{source=$file;backup=$name}}
 $rollback=@{services=@{api=@{image=$api.Image;environment=@{DATABASE_PROVIDER='appwrite'}};web=@{image=$web.Image};proxy=@{image=$proxy.Image}}}
 [IO.File]::WriteAllText((Join-Path $output 'rollback.compose.json'),($rollback|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
 $hashes=@(Get-ChildItem -LiteralPath $output -File|ForEach-Object {@{file=$_.Name;bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}})
 $manifest=@{format='ifm-appwrite-backup-v1';at=[DateTime]::UtcNow.ToString('o');sourceFrozenConfirmed=$true;
  sourceApiImage=$api.Image;sourceAppwriteImage=$appwrite.Image;sourceDatabaseImage=$db.Image;configFiles=$configMap;files=$hashes;
  archiveCatalogVerified=$true;restoreRehearsed=$false;nginxConfigIncluded=($AdditionalConfig.Count -gt 0)}
 [IO.File]::WriteAllText((Join-Path $output 'manifest.json'),($manifest|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
 Write-Output 'Backup saved with checksums. Rehearse restoration on an isolated database before cutover; preserve this directory off-host.'
}finally{
 docker exec $DatabaseContainer rm -f $temporary |Out-Null
}

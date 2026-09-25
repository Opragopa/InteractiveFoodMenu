param(
  [string]$WebBase = "https://foodmenu.cloudopragopa.online",
  [string]$ApiBase = "https://api.foodmenu.cloudopragopa.online"
)

$ErrorActionPreference = "Stop"
$checks = @(
  @{ Name = "web staff"; Url = "$WebBase/staff"; Expected = 200 },
  @{ Name = "api health"; Url = "$ApiBase/health"; Expected = 200 },
  @{ Name = "api ready"; Url = "$ApiBase/ready"; Expected = 200 }
)

foreach ($check in $checks) {
  $response = Invoke-WebRequest -Uri $check.Url -Method Get -UseBasicParsing
  if ($response.StatusCode -ne $check.Expected) { throw "$($check.Name): HTTP $($response.StatusCode)" }
  Write-Host "OK  $($check.Name)  HTTP $($response.StatusCode)"
}

$cors = Invoke-WebRequest -Uri "$ApiBase/api/auth/staff" -Method Options -Headers @{
  Origin = $WebBase
  "Access-Control-Request-Method" = "POST"
  "Access-Control-Request-Headers" = "content-type"
} -UseBasicParsing
if ($cors.StatusCode -notin @(200, 204) -or $cors.Headers["Access-Control-Allow-Origin"] -ne $WebBase) {
  throw "CORS preflight failed for $WebBase"
}
Write-Host "OK  CORS  $($cors.Headers['Access-Control-Allow-Origin'])"

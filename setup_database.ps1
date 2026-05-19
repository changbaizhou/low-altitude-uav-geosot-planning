$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Import-EnvFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }

  Get-Content $Path | ForEach-Object {
    $Line = $_.Trim()
    if ($Line -and -not $Line.StartsWith("#") -and $Line.Contains("=")) {
      $Parts = $Line.Split("=", 2)
      $Key = $Parts[0].Trim()
      $Value = $Parts[1].Trim().Trim('"').Trim("'")
      if ($Key -and -not [Environment]::GetEnvironmentVariable($Key, "Process")) {
        [Environment]::SetEnvironmentVariable($Key, $Value, "Process")
      }
    }
  }
}

Import-EnvFile (Join-Path $RootDir ".env")

$env:PGHOST = if ($env:PGHOST) { $env:PGHOST } else { "localhost" }
$env:PGPORT = if ($env:PGPORT) { $env:PGPORT } else { "5432" }
$env:PGUSER = if ($env:PGUSER) { $env:PGUSER } else { "postgres" }
$env:PGPASSWORD = if ($env:PGPASSWORD) { $env:PGPASSWORD } else { "" }
$env:PGDATABASE = if ($env:PGDATABASE) { $env:PGDATABASE } else { "uav-db" }

Set-Location (Join-Path $RootDir "backend")

if (-not (Test-Path "node_modules")) {
  npm install
}

npm run setup:database

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $RootDir "backend")

$env:PGHOST = if ($env:PGHOST) { $env:PGHOST } else { "localhost" }
$env:PGPORT = if ($env:PGPORT) { $env:PGPORT } else { "5432" }
$env:PGUSER = if ($env:PGUSER) { $env:PGUSER } else { "postgres" }
$env:PGPASSWORD = if ($env:PGPASSWORD) { $env:PGPASSWORD } else { "" }
$env:PGDATABASE = if ($env:PGDATABASE) { $env:PGDATABASE } else { "uav-db" }
$env:PORT = if ($env:PORT) { $env:PORT } else { "3000" }

if (-not (Test-Path "node_modules")) {
  npm install
}

npm start

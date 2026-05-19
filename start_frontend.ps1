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

Set-Location (Join-Path $RootDir "frontend")

if (-not (Test-Path "node_modules")) {
  npm install
}

npm run dev -- --host 127.0.0.1 --port 5173 --strictPort

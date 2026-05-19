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

$BackupFile = if ($args.Count -gt 0) { $args[0] } else { Join-Path $RootDir "database\uav-db_current.backup" }
$SchemaPatchFile = Join-Path $RootDir "database\latest_schema_patch_20260518.sql"

$env:PGHOST = if ($env:PGHOST) { $env:PGHOST } else { "localhost" }
$env:PGPORT = if ($env:PGPORT) { $env:PGPORT } else { "5432" }
$env:PGUSER = if ($env:PGUSER) { $env:PGUSER } else { "postgres" }
$env:PGPASSWORD = if ($env:PGPASSWORD) { $env:PGPASSWORD } else { "" }
$env:PGDATABASE = if ($env:PGDATABASE) { $env:PGDATABASE } else { "uav-db" }

if (-not (Test-Path $BackupFile)) {
  throw "数据库备份不存在：$BackupFile"
}

foreach ($cmd in @("psql", "createdb", "pg_restore")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "缺少命令：$cmd。请先把 PostgreSQL 的 bin 目录加入 PATH，例如：`$env:Path = `"C:\Program Files\PostgreSQL\18\bin;`$env:Path`""
  }
}

$exists = & psql -h $env:PGHOST -p $env:PGPORT -U $env:PGUSER -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$env:PGDATABASE';"
if (($exists -join "").Trim() -ne "1") {
  & createdb -h $env:PGHOST -p $env:PGPORT -U $env:PGUSER $env:PGDATABASE
}

& psql -h $env:PGHOST -p $env:PGPORT -U $env:PGUSER -d $env:PGDATABASE -c "CREATE EXTENSION IF NOT EXISTS postgis;"
& pg_restore --clean --if-exists --no-owner --no-privileges -h $env:PGHOST -p $env:PGPORT -U $env:PGUSER -d $env:PGDATABASE $BackupFile

if (Test-Path $SchemaPatchFile) {
  & psql -h $env:PGHOST -p $env:PGPORT -U $env:PGUSER -d $env:PGDATABASE -f $SchemaPatchFile
}

Write-Host "数据库已恢复到：$env:PGDATABASE"

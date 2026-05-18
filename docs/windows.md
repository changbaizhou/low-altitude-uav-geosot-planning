# Windows Running Notes

Recommended environment:

- Windows 10/11
- VS Code
- Node.js 20+
- PostgreSQL + PostGIS
- pgAdmin or psql tools

## 1. Prepare Environment Variables

In PowerShell:

```powershell
$env:PGHOST="localhost"
$env:PGPORT="5432"
$env:PGUSER="postgres"
$env:PGPASSWORD="your_postgresql_password"
$env:PGDATABASE="uav-db"
$env:VITE_API_BASE="http://localhost:3000"
```

Optional:

```powershell
$env:QWEATHER_API_KEY="your_qweather_key"
$env:VITE_CESIUM_ION_TOKEN="your_cesium_ion_token"
```

## 2. Start Backend

```powershell
cd path\to\low-altitude-uav-geosot-planning
powershell -ExecutionPolicy Bypass -File .\start_backend.ps1
```

## 3. Start Frontend

Open another PowerShell terminal:

```powershell
cd path\to\low-altitude-uav-geosot-planning
powershell -ExecutionPolicy Bypass -File .\start_frontend.ps1
```

Open:

```text
http://127.0.0.1:5173/
```

## 4. Database Restore

If you have a private PostgreSQL backup file:

```powershell
powershell -ExecutionPolicy Bypass -File .\restore_database.ps1 .\database\your_private_backup.backup
```

Backup files are intentionally excluded from Git.


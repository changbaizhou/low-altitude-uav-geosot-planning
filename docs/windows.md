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
cd path\to\low-altitude-uav-geosot-planning
Copy-Item .env.example .env
notepad .env
```

Edit `.env` and replace `PGPASSWORD=your_postgresql_password` with your local PostgreSQL password. Optional Cesium and weather keys can stay blank.

## 2. Initialize Database

Run this once before the first backend start:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup_database.ps1
```

The script creates the configured database when possible, enables PostGIS extensions, generates GeoSOT grid tables, imports obstacle constraints and L22 surface weights, and applies the schema patch.

## 3. Start Backend

```powershell
cd path\to\low-altitude-uav-geosot-planning
powershell -ExecutionPolicy Bypass -File .\start_backend.ps1
```

## 4. Start Frontend

Open another PowerShell terminal:

```powershell
cd path\to\low-altitude-uav-geosot-planning
powershell -ExecutionPolicy Bypass -File .\start_frontend.ps1
```

Open:

```text
http://127.0.0.1:5173/
```

## 5. Database Restore

If you have a private PostgreSQL backup file:

```powershell
powershell -ExecutionPolicy Bypass -File .\restore_database.ps1 .\database\your_private_backup.backup
```

Backup files are intentionally excluded from Git.

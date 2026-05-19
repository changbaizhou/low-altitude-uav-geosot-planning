# Database Setup

The prototype uses PostgreSQL + PostGIS. A full local backup is not committed to this repository to avoid publishing large runtime data.

## Recommended Local Database

```text
database: uav-db
extension: postgis
optional extension: btree_gist
```

## Minimal Initialization Flow

1. Create a PostgreSQL database.
2. Enable PostGIS.
3. Run the grid generation script.
4. Import obstacle and surface weight data.
5. Apply the latest schema patch if needed.

The recommended public-release command performs these steps automatically:

```bash
cd backend
npm install
npm run setup:database
```

Example:

```bash
createdb -h localhost -U postgres uav-db
psql -h localhost -U postgres -d uav-db -c "CREATE EXTENSION IF NOT EXISTS postgis;"

cd backend
npm install
npm run generate:grids
npm run import:obstacles
npm run import:surface-weights

psql -h localhost -U postgres -d uav-db -f ../database/latest_schema_patch_20260518.sql
```

Set `PGPASSWORD` before running the commands if your local PostgreSQL user requires a password.

`latest_schema_patch_20260518.sql` is only a schema patch. It expects `airspace_grid` to exist, so do not run it alone on an empty database.

## Optional Backup Restore

If you have a private `.backup` file, place it under `database/` locally and run:

```bash
./restore_database.sh database/your_private_backup.backup
```

The `.gitignore` file excludes `.backup` files from version control.

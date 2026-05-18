# Low-Altitude UAV GeoSOT Route Planning

[中文说明](./README.zh-CN.md)

This repository contains a prototype system for low-altitude UAV route planning based on GeoSOT airspace subdivision units and state control.

The project was developed for research on converting continuous low-altitude airspace into codable, queryable and state-aware three-dimensional grid units, and then using these units for route planning, temporary control, weather control, route archiving and spatiotemporal occupancy analysis.

## Features

- Multi-level GeoSOT airspace grid display
- Three-dimensional airspace unit visualization
- L22 ground-feature weight grid for roads, water and buildings
- Temporary control areas with time windows
- Weather control and risk adjustment
- Improved A* route planning with state constraints
- Dijkstra baseline comparison
- Route archive and replay
- Route occupancy timestamps for future multi-UAV conflict checking
- Cesium-based 3D visualization interface

## Project Structure

```text
.
├── backend          # Node.js / Express API and planning logic
├── frontend        # Vue + Vite + Cesium frontend
├── database                   # Schema patch and database notes
├── docs                       # Windows-oriented running notes
├── start_backend.*            # Helper scripts
├── start_frontend.*           # Helper scripts
├── restore_database.*         # Optional restore scripts for local backups
├── .env.example               # Environment variable template
├── README.md                  # English documentation
└── README.zh-CN.md            # Chinese documentation
```

## Requirements

- Node.js 20+
- PostgreSQL with PostGIS
- npm

The system expects a PostgreSQL database named `uav-db` by default. Connection settings are controlled by environment variables. Copy `.env.example` to `.env` or set the variables in your terminal.

## Run Backend

```bash
cd backend
npm install

export PGHOST=localhost
export PGPORT=5432
export PGUSER=postgres
export PGPASSWORD=your_postgresql_password
export PGDATABASE=uav-db
export QWEATHER_API_KEY=

npm start
```

Backend default URL:

```text
http://localhost:3000
```

Health check:

```text
http://localhost:3000/api/levels
```

## Run Frontend

```bash
cd frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Frontend URL:

```text
http://127.0.0.1:5173/
```

If the backend is not running on `localhost:3000`, set `VITE_API_BASE` before starting the frontend.

## Database Notes

This repository does not include full database backup files by default. Full `.backup` files may contain large local runtime data and should not be committed when the repository is made public.

The `database/latest_schema_patch_20260518.sql` file contains the latest runtime schema additions for route archives, route occupancy, helipads, temporary control areas and several state/query indexes. For a complete fresh database, run the backend initialization scripts and grid generation scripts described in `database/README.md`.

## Security Notes

Do not commit real credentials or tokens.

- PostgreSQL password: set `PGPASSWORD` locally.
- Cesium Ion token: set `VITE_CESIUM_ION_TOKEN` locally if required.
- QWeather key: set `QWEATHER_API_KEY` locally if weather sync is required.

## License

MIT License.

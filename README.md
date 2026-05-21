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

## Screenshots

The following screenshots show selected interface states of the prototype system.

### System Overview

<img src="./docs/images/overview.jpg" alt="System overview" width="100%">

### Core Demonstrations

| 3D scene and base layers | Multi-level GeoSOT grid |
| --- | --- |
| <img src="./docs/images/model-scene.jpg" alt="3D scene and base layers" width="100%"> | <img src="./docs/images/geosot-l15-grid.jpg" alt="Multi-level GeoSOT grid" width="100%"> |

| L22 surface weight layer | Helipad management |
| --- | --- |
| <img src="./docs/images/l22-surface-weights.jpg" alt="L22 surface weight layer" width="100%"> | <img src="./docs/images/helipads.jpg" alt="Helipad management" width="100%"> |

| Route planning without control area | State-constrained route rerouting |
| --- | --- |
| <img src="./docs/images/route-planning.jpg" alt="Route planning without control area" width="100%"> | <img src="./docs/images/controlled-route-reroute.jpg" alt="State-constrained route rerouting" width="100%"> |

| Temporary control area | Cross-scale 3D grid display |
| --- | --- |
| <img src="./docs/images/temporary-control.jpg" alt="Temporary control area" width="100%"> | <img src="./docs/images/cross-scale-flight.jpg" alt="Cross-scale 3D grid display" width="100%"> |

## Project Structure

```text
.
├── backend          # Node.js / Express API and planning logic
├── frontend        # Vue + Vite + Cesium frontend
├── database                   # Schema patch and database notes
├── docs                       # Windows-oriented running notes and screenshots
├── setup_database.*           # First-time database initialization scripts
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

The system expects a PostgreSQL database named `uav-db` by default. Connection settings are controlled by environment variables. Copy `.env.example` to `.env`, edit the PostgreSQL password, and then run the database setup command before starting the backend.

## First-Time Setup

```bash
cp .env.example .env
# Edit .env and replace PGPASSWORD=your_postgresql_password with your local PostgreSQL password.
```

Initialize the database and import the public demo data:

```bash
cd backend
npm install
npm run setup:database
```

The setup command will create the configured database when possible, enable PostGIS extensions, generate GeoSOT grid tables, import obstacle constraints, import L22 surface weights, and apply the latest schema patch.

## Run Backend

```bash
cd backend
npm install
npm start
```

You can also use the helper script from the repository root:

```bash
./start_backend.sh
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

If the backend is not running on `localhost:3000`, set `VITE_API_BASE` in `.env` before starting the frontend.

## Database Notes

This repository does not include full database backup files by default. Full `.backup` files may contain large local runtime data and should not be committed when the repository is made public.

The `database/latest_schema_patch_20260518.sql` file contains the latest runtime schema additions for route archives, route occupancy, helipads, temporary control areas and several state/query indexes. It is a patch for an existing grid database, not a complete fresh initialization script. For a complete fresh database, run `cd backend && npm run setup:database`.

## Security Notes

Do not commit real credentials or tokens.

- PostgreSQL password: set `PGPASSWORD` locally.
- Cesium Ion token: set `VITE_CESIUM_ION_TOKEN` locally if required.
- QWeather key: set `QWEATHER_API_KEY` locally if weather sync is required.

## License

MIT License.

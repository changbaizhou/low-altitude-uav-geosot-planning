-- Latest runtime schema patch for the UAV GeoSOT planning demo.
-- Apply after restoring uav-db_current.backup if the restored database was exported before
-- route occupancy, helipad management, temporary control areas, or surface/weather indexes
-- were added. The backend also runs equivalent IF NOT EXISTS checks on startup.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS surface_type TEXT DEFAULT 'normal';
ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS surface_weight NUMERIC DEFAULT 1;
ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS surface_updated_at TIMESTAMPTZ;
ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS weather_risk_level NUMERIC DEFAULT 0;
ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS weather_fly_weight NUMERIC DEFAULT 1;
ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS weather_traffic_density NUMERIC DEFAULT 0;
ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS weather_updated_at TIMESTAMPTZ;
ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS control_start_at TIMESTAMPTZ;
ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS control_end_at TIMESTAMPTZ;
ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS airspace_grid_state_history (
    id BIGSERIAL PRIMARY KEY,
    geosot_id TEXT NOT NULL,
    status INTEGER NOT NULL,
    fly_weight NUMERIC,
    traffic_density NUMERIC,
    weather_limit BOOLEAN,
    control_start_at TIMESTAMPTZ,
    control_end_at TIMESTAMPTZ,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS airspace_grid_geosot_time_idx
    ON airspace_grid (grid_level, geosot_code, geosot_z, current_status, weather_limit);
CREATE INDEX IF NOT EXISTS airspace_grid_control_time_idx
    ON airspace_grid (grid_level, control_start_at, control_end_at);
CREATE INDEX IF NOT EXISTS airspace_grid_history_spacetime_idx
    ON airspace_grid_state_history (geosot_id, created_at DESC, status, weather_limit);
CREATE INDEX IF NOT EXISTS airspace_grid_weather_scope_idx
    ON airspace_grid (grid_level, weather_limit, weather_risk_level);
CREATE INDEX IF NOT EXISTS airspace_grid_surface_idx
    ON airspace_grid (grid_level, surface_type, surface_weight);

CREATE TABLE IF NOT EXISTS planned_routes (
    id BIGSERIAL PRIMARY KEY,
    route_name TEXT NOT NULL,
    route_type TEXT DEFAULT 'mission',
    objective TEXT,
    start_lon NUMERIC,
    start_lat NUMERIC,
    start_alt NUMERIC,
    end_lon NUMERIC,
    end_lat NUMERIC,
    end_alt NUMERIC,
    distance_m NUMERIC DEFAULT 0,
    estimated_seconds NUMERIC DEFAULT 0,
    grid_count INTEGER DEFAULT 0,
    waypoint_count INTEGER DEFAULT 0,
    risk_level TEXT,
    risk_score NUMERIC DEFAULT 0,
    route_geojson JSONB,
    grid_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
    track_geom geometry(LineStringZ, 4326),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS planned_routes_created_idx ON planned_routes (created_at DESC);
CREATE INDEX IF NOT EXISTS planned_routes_track_gix ON planned_routes USING GIST (track_geom);

CREATE TABLE IF NOT EXISTS planned_route_occupancy (
    id BIGSERIAL PRIMARY KEY,
    route_id BIGINT REFERENCES planned_routes(id) ON DELETE CASCADE,
    sequence INTEGER,
    geosot_id TEXT,
    geosot_code TEXT,
    grid_level TEXT,
    geosot_level INTEGER,
    geosot_x BIGINT,
    geosot_y BIGINT,
    geosot_z INTEGER,
    alt_bottom NUMERIC,
    alt_top NUMERIC,
    entered_at TIMESTAMPTZ,
    exited_at TIMESTAMPTZ,
    eta_at TIMESTAMPTZ,
    uav_id TEXT,
    mission_id TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    source TEXT NOT NULL DEFAULT 'route_archive',
    geom geometry(Polygon, 4326),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS planned_route_occupancy_route_seq_idx
    ON planned_route_occupancy (route_id, sequence);
CREATE INDEX IF NOT EXISTS planned_route_occupancy_time_idx
    ON planned_route_occupancy (grid_level, geosot_id, entered_at, exited_at)
    WHERE status IN ('planned', 'active');
CREATE INDEX IF NOT EXISTS planned_route_occupancy_route_idx
    ON planned_route_occupancy (route_id, sequence);
CREATE INDEX IF NOT EXISTS planned_route_occupancy_geom_gix
    ON planned_route_occupancy USING GIST (geom);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'planned_route_occupancy_no_overlap'
    ) THEN
        ALTER TABLE planned_route_occupancy
        ADD CONSTRAINT planned_route_occupancy_no_overlap
        EXCLUDE USING gist (
            grid_level WITH =,
            geosot_id WITH =,
            tstzrange(entered_at, exited_at, '[)') WITH &&
        )
        WHERE (status IN ('planned', 'active'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS helipads (
    id BIGSERIAL PRIMARY KEY,
    helipad_code VARCHAR(32) UNIQUE NOT NULL,
    name VARCHAR(120) NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    alt DOUBLE PRECISION NOT NULL DEFAULT 30,
    status VARCHAR(24) NOT NULL DEFAULT 'active',
    notes TEXT,
    geom geometry(Point, 4326)
        GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS helipads_code_idx ON helipads (helipad_code);
CREATE INDEX IF NOT EXISTS helipads_status_idx ON helipads (status);
CREATE INDEX IF NOT EXISTS helipads_geom_gix ON helipads USING GIST (geom);

INSERT INTO helipads (helipad_code, name, lon, lat, alt, notes)
VALUES
    ('H-01', '西北停机坪', 118.776350, 31.919350, 30, 'university northwest helipad'),
    ('H-02', '东北停机坪', 118.785750, 31.919350, 30, 'university northeast helipad'),
    ('H-03', '西南停机坪', 118.776350, 31.913550, 30, 'university southwest helipad'),
    ('H-04', '东南停机坪', 118.785750, 31.913550, 30, 'university southeast helipad')
ON CONFLICT (helipad_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS control_areas (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    west DOUBLE PRECISION NOT NULL,
    south DOUBLE PRECISION NOT NULL,
    east DOUBLE PRECISION NOT NULL,
    north DOUBLE PRECISION NOT NULL,
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'active',
    affected_grid_count INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    geom geometry(Polygon, 4326) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS control_areas_time_idx ON control_areas (start_at, end_at);
CREATE INDEX IF NOT EXISTS control_areas_status_idx ON control_areas (status);
CREATE INDEX IF NOT EXISTS control_areas_geom_gix ON control_areas USING GIST (geom);

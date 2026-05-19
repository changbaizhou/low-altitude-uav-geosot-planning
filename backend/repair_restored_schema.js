/*
 * @file repair_restored_schema.js
 * @author changbai
 * @project 基于GeoSOT空域剖分单元状态管控的低空无人机飞行线路规划系统
 * @date 2026-05-08
 * @description 数据库恢复后的表结构兼容与状态字段修复脚本。
 */

const { createPool } = require('./dbConfig');
const { GRID_LEVEL_SPECS, cellFromLonLat, altitudeToLayer } = require('./geosot');

const pool = createPool();

const BATCH_SIZE = Number(process.env.REPAIR_BATCH_SIZE || 2000);

/**
 * 确保ensure compatible schema所需的表结构、字段或索引存在，保证后续流程可以重复执行。
 */
async function ensureCompatibleSchema(client) {
    await client.query(`
        CREATE EXTENSION IF NOT EXISTS postgis;

        DROP VIEW IF EXISTS active_control_view CASCADE;
        DROP VIEW IF EXISTS valid_airspace_grid CASCADE;

        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS geosot_code TEXT;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS geosot_level INTEGER;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS geosot_x BIGINT;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS geosot_y BIGINT;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS geosot_z INTEGER;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS max_flight_altitude NUMERIC;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS traffic_density NUMERIC DEFAULT 0;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS surface_type TEXT DEFAULT 'normal';
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS surface_weight NUMERIC DEFAULT 1;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS surface_updated_at TIMESTAMPTZ;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS control_start_at TIMESTAMPTZ;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS control_end_at TIMESTAMPTZ;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS risk_level NUMERIC DEFAULT 0;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS weather_risk_level NUMERIC DEFAULT 0;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS weather_fly_weight NUMERIC DEFAULT 1;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS weather_traffic_density NUMERIC DEFAULT 0;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS weather_updated_at TIMESTAMPTZ;
        ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

        ALTER TABLE airspace_grid
            ALTER COLUMN fly_weight TYPE NUMERIC USING COALESCE(fly_weight::numeric, 1),
            ALTER COLUMN alt_bottom TYPE NUMERIC USING alt_bottom::numeric,
            ALTER COLUMN alt_top TYPE NUMERIC USING alt_top::numeric,
            ALTER COLUMN max_flight_altitude TYPE NUMERIC USING max_flight_altitude::numeric,
            ALTER COLUMN traffic_density TYPE NUMERIC USING COALESCE(traffic_density::numeric, 0),
            ALTER COLUMN surface_weight TYPE NUMERIC USING COALESCE(surface_weight::numeric, 1),
            ALTER COLUMN risk_level TYPE NUMERIC USING COALESCE(risk_level::numeric, 0),
            ALTER COLUMN weather_risk_level TYPE NUMERIC USING COALESCE(weather_risk_level::numeric, 0),
            ALTER COLUMN weather_fly_weight TYPE NUMERIC USING COALESCE(weather_fly_weight::numeric, 1),
            ALTER COLUMN weather_traffic_density TYPE NUMERIC USING COALESCE(weather_traffic_density::numeric, 0);

        ALTER TABLE airspace_grid
            ALTER COLUMN weather_limit TYPE BOOLEAN
            USING CASE
                WHEN weather_limit IS NULL THEN FALSE
                WHEN lower(weather_limit::text) IN ('true', 't', 'yes', 'y', '1', 'on') THEN TRUE
                ELSE FALSE
            END;

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

        CREATE INDEX IF NOT EXISTS airspace_grid_geom_gix ON airspace_grid USING GIST (geom);
        CREATE INDEX IF NOT EXISTS airspace_grid_level_xyz_idx ON airspace_grid (grid_level, geosot_x, geosot_y, geosot_z);
        CREATE INDEX IF NOT EXISTS airspace_grid_code_idx ON airspace_grid (geosot_code);
        CREATE INDEX IF NOT EXISTS airspace_grid_status_idx ON airspace_grid (grid_level, current_status, weather_limit);
        CREATE INDEX IF NOT EXISTS airspace_grid_surface_idx ON airspace_grid (grid_level, surface_type, surface_weight);
        CREATE INDEX IF NOT EXISTS airspace_grid_history_code_time_idx ON airspace_grid_state_history (geosot_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS airspace_grid_geosot_time_idx ON airspace_grid (grid_level, geosot_code, geosot_z, current_status, weather_limit);
        CREATE INDEX IF NOT EXISTS airspace_grid_control_time_idx ON airspace_grid (grid_level, control_start_at, control_end_at);
        CREATE INDEX IF NOT EXISTS airspace_grid_history_spacetime_idx ON airspace_grid_state_history (geosot_id, created_at DESC, status, weather_limit);
        CREATE INDEX IF NOT EXISTS airspace_grid_weather_scope_idx ON airspace_grid (grid_level, weather_limit, weather_risk_level);
    `);
}

/**
 * 更新update values状态，使界面、缓存和计算结果保持一致。
 */
function updateValues(rows) {
    const params = [];
    const values = [];

    rows.forEach((row, index) => {
        const spec = GRID_LEVEL_SPECS[row.grid_level];
        const lon = Number(row.lon);
        const lat = Number(row.lat);
        const bottom = Number(row.alt_bottom || 0);
        const gridLayer = row.grid_layer == null ? altitudeToLayer(bottom, spec) : Number(row.grid_layer);
        const cell = cellFromLonLat(lon, lat, spec.geosotLevel);
        const start = index * 8;

        params.push(
            Number(row.id),
            cell.geosotCode,
            spec.geosotLevel,
            cell.x,
            cell.y,
            gridLayer,
            spec.maxAltitude,
            gridLayer,
        );
        values.push(`(
            $${start + 1}::integer,
            $${start + 2}::text,
            $${start + 3}::integer,
            $${start + 4}::bigint,
            $${start + 5}::bigint,
            $${start + 6}::integer,
            $${start + 7}::numeric,
            $${start + 8}::integer
        )`);
    });

    return { params, values };
}

/**
 * 封装repair grid coordinates相关逻辑，保持调用处简洁并便于后续维护。
 */
async function repairGridCoordinates(client) {
    let total = 0;

    while (true) {
        const { rows } = await client.query(`
            SELECT
                id,
                grid_level,
                grid_layer,
                alt_bottom,
                ST_X(ST_Centroid(geom)) AS lon,
                ST_Y(ST_Centroid(geom)) AS lat
            FROM airspace_grid
            WHERE grid_level = ANY($1)
              AND geom IS NOT NULL
              AND (
                  geosot_code IS NULL
                  OR geosot_level IS NULL
                  OR geosot_x IS NULL
                  OR geosot_y IS NULL
                  OR geosot_z IS NULL
                  OR max_flight_altitude IS NULL
              )
            ORDER BY id
            LIMIT $2;
        `, [Object.keys(GRID_LEVEL_SPECS), BATCH_SIZE]);

        if (rows.length === 0) break;

        const { params, values } = updateValues(rows);
        await client.query(`
            UPDATE airspace_grid AS g
            SET
                geosot_code = v.geosot_code,
                geosot_level = v.geosot_level,
                geosot_x = v.geosot_x,
                geosot_y = v.geosot_y,
                geosot_z = v.geosot_z,
                max_flight_altitude = v.max_flight_altitude,
                grid_layer = COALESCE(g.grid_layer, v.grid_layer),
                traffic_density = COALESCE(g.traffic_density, 0),
                risk_level = COALESCE(g.risk_level, 0),
                updated_at = NOW()
            FROM (
                VALUES ${values.join(',')}
            ) AS v(id, geosot_code, geosot_level, geosot_x, geosot_y, geosot_z, max_flight_altitude, grid_layer)
            WHERE g.id = v.id;
        `, params);

        total += rows.length;
        console.log(`updated ${total} airspace_grid rows`);
    }
}

/**
 * 封装repair views相关逻辑，保持调用处简洁并便于后续维护。
 */
async function repairViews(client) {
    await client.query(`
        CREATE OR REPLACE VIEW valid_airspace_grid AS
        SELECT *
        FROM airspace_grid
        WHERE current_status = 0
          AND COALESCE(weather_limit, false) = false;

        CREATE OR REPLACE VIEW active_control_view AS
        SELECT
            g.geosot_id,
            g.geom,
            COALESCE(d.status, g.current_status) AS final_status,
            d.control_type,
            d.description
        FROM airspace_grid g
        LEFT JOIN airspace_dynamic_control d
          ON g.geosot_id::text = d.geosot_id::text
         AND now() >= d.start_time
         AND now() <= d.end_time;
    `);
}

/**
 * 封装main相关逻辑，保持调用处简洁并便于后续维护。
 */
async function main() {
    const client = await pool.connect();

    try {
        await ensureCompatibleSchema(client);
        await repairGridCoordinates(client);
        await repairViews(client);
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

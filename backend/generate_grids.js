/*
 * @file generate_grids.js
 * @author changbai
 * @project 基于GeoSOT空域剖分单元状态管控的低空无人机飞行线路规划系统
 * @date 2026-05-08
 * @description 空域网格生成脚本，用于构建不同层级的三维GeoSOT网格单元。
 */

const { createPool } = require('./dbConfig');
const {
    GRID_LEVEL_SPECS,
    dmsAlignedAxisCells,
    encodeSurface,
    altitudeLayerRange,
    make3DCode,
    estimateResolutionMeters,
} = require('./geosot');

const pool = createPool();

const BATCH_SIZE = Number(process.env.GRID_BATCH_SIZE || 1000);
const KEEP_EXISTING_GRIDS = process.env.KEEP_EXISTING_GRIDS === '1';
const ONLY_LEVELS = (process.env.ONLY_LEVELS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const DEFAULT_GENERATED_LEVELS = new Set(['L16', 'L19', 'L22']);

/**
 * 获取selected specs对应对象或配置，集中处理选择规则。
 */
function selectedSpecs() {
    const specs = Object.values(GRID_LEVEL_SPECS);
    if (ONLY_LEVELS.length === 0) {
        return specs.filter((spec) => DEFAULT_GENERATED_LEVELS.has(spec.key));
    }
    if (ONLY_LEVELS.some((item) => item.toLowerCase() === 'all')) return specs;
    const wanted = new Set(ONLY_LEVELS);
    return specs.filter((spec) => wanted.has(spec.key) || wanted.has(String(spec.geosotLevel)));
}

/**
 * 封装column data type相关逻辑，保持调用处简洁并便于后续维护。
 */
async function columnDataType(client, columnName) {
    const result = await client.query(`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'airspace_grid'
          AND column_name = $1;
    `, [columnName]);
    return result.rows[0]?.data_type || null;
}

/**
 * 封装alter column type if needed相关逻辑，保持调用处简洁并便于后续维护。
 */
async function alterColumnTypeIfNeeded(client, columnName, expectedType, alterExpression) {
    const currentType = await columnDataType(client, columnName);
    if (currentType === expectedType) return;
    await client.query(`ALTER TABLE airspace_grid ALTER COLUMN ${columnName} TYPE ${alterExpression};`);
}

/**
 * 确保ensure schema所需的表结构、字段或索引存在，保证后续流程可以重复执行。
 */
async function ensureSchema(client) {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');

    await client.query('DROP VIEW IF EXISTS active_control_view CASCADE;');
    await client.query('DROP VIEW IF EXISTS valid_airspace_grid CASCADE;');

    await client.query(`
        CREATE TABLE IF NOT EXISTS airspace_grid (
            id BIGSERIAL PRIMARY KEY,
            geosot_id TEXT NOT NULL,
            geosot_code TEXT,
            grid_level VARCHAR(16),
            geosot_level INTEGER,
            geosot_x BIGINT,
            geosot_y BIGINT,
            geosot_z INTEGER,
            type INTEGER DEFAULT 0,
            fly_weight NUMERIC DEFAULT 1,
            surface_type TEXT DEFAULT 'normal',
            surface_weight NUMERIC DEFAULT 1,
            surface_updated_at TIMESTAMPTZ,
            current_status INTEGER DEFAULT 0,
            alt_bottom NUMERIC NOT NULL,
            alt_top NUMERIC NOT NULL,
            grid_layer INTEGER,
            max_flight_altitude NUMERIC,
            traffic_density NUMERIC DEFAULT 0,
            weather_limit BOOLEAN DEFAULT FALSE,
            weather_risk_level NUMERIC DEFAULT 0,
            weather_fly_weight NUMERIC DEFAULT 1,
            weather_traffic_density NUMERIC DEFAULT 0,
            weather_updated_at TIMESTAMPTZ,
            control_start_at TIMESTAMPTZ,
            control_end_at TIMESTAMPTZ,
            risk_level NUMERIC DEFAULT 0,
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            geom geometry(Polygon, 4326)
        );
    `);

    const columns = [
        ['geosot_id', 'TEXT'],
        ['geosot_code', 'TEXT'],
        ['grid_level', 'VARCHAR(16)'],
        ['geosot_level', 'INTEGER'],
        ['geosot_x', 'BIGINT'],
        ['geosot_y', 'BIGINT'],
        ['geosot_z', 'INTEGER'],
        ['type', 'INTEGER DEFAULT 0'],
        ['fly_weight', 'NUMERIC DEFAULT 1'],
        ['surface_type', "TEXT DEFAULT 'normal'"],
        ['surface_weight', 'NUMERIC DEFAULT 1'],
        ['surface_updated_at', 'TIMESTAMPTZ'],
        ['current_status', 'INTEGER DEFAULT 0'],
        ['alt_bottom', 'NUMERIC'],
        ['alt_top', 'NUMERIC'],
        ['grid_layer', 'INTEGER'],
        ['max_flight_altitude', 'NUMERIC'],
        ['traffic_density', 'NUMERIC DEFAULT 0'],
        ['weather_limit', 'BOOLEAN DEFAULT FALSE'],
        ['weather_risk_level', 'NUMERIC DEFAULT 0'],
        ['weather_fly_weight', 'NUMERIC DEFAULT 1'],
        ['weather_traffic_density', 'NUMERIC DEFAULT 0'],
        ['weather_updated_at', 'TIMESTAMPTZ'],
        ['control_start_at', 'TIMESTAMPTZ'],
        ['control_end_at', 'TIMESTAMPTZ'],
        ['risk_level', 'NUMERIC DEFAULT 0'],
        ['updated_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ];

    for (const [name, type] of columns) {
        await client.query(`ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS ${name} ${type};`);
    }

    await alterColumnTypeIfNeeded(client, 'fly_weight', 'numeric', 'NUMERIC USING fly_weight::numeric');
    await alterColumnTypeIfNeeded(client, 'surface_weight', 'numeric', 'NUMERIC USING COALESCE(surface_weight::numeric, 1)');
    await alterColumnTypeIfNeeded(client, 'alt_bottom', 'numeric', 'NUMERIC USING alt_bottom::numeric');
    await alterColumnTypeIfNeeded(client, 'alt_top', 'numeric', 'NUMERIC USING alt_top::numeric');
    await alterColumnTypeIfNeeded(client, 'max_flight_altitude', 'numeric', 'NUMERIC USING max_flight_altitude::numeric');
    await alterColumnTypeIfNeeded(client, 'traffic_density', 'numeric', 'NUMERIC USING traffic_density::numeric');
    await alterColumnTypeIfNeeded(client, 'risk_level', 'numeric', 'NUMERIC USING risk_level::numeric');
    await alterColumnTypeIfNeeded(client, 'weather_limit', 'boolean', `BOOLEAN USING CASE
        WHEN weather_limit IS NULL THEN FALSE
        WHEN lower(weather_limit::text) IN ('true', 't', 'yes', 'y', '1', 'on') THEN TRUE
        ELSE FALSE
    END`);

    await client.query(`
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
    `);

    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS airspace_grid_geosot_id_uidx ON airspace_grid (geosot_id);');
    await client.query('CREATE INDEX IF NOT EXISTS airspace_grid_geom_gix ON airspace_grid USING GIST (geom);');
    await client.query('CREATE INDEX IF NOT EXISTS airspace_grid_level_xyz_idx ON airspace_grid (grid_level, geosot_x, geosot_y, geosot_z);');
    await client.query('CREATE INDEX IF NOT EXISTS airspace_grid_code_idx ON airspace_grid (geosot_code);');
    await client.query('CREATE INDEX IF NOT EXISTS airspace_grid_status_idx ON airspace_grid (grid_level, current_status, weather_limit);');
    await client.query('CREATE INDEX IF NOT EXISTS airspace_grid_surface_idx ON airspace_grid (grid_level, surface_type, surface_weight);');
    await client.query('CREATE INDEX IF NOT EXISTS airspace_grid_history_code_time_idx ON airspace_grid_state_history (geosot_id, created_at DESC);');
    await client.query('CREATE INDEX IF NOT EXISTS airspace_grid_geosot_time_idx ON airspace_grid (grid_level, geosot_code, geosot_z, current_status, weather_limit);');
    await client.query('CREATE INDEX IF NOT EXISTS airspace_grid_control_time_idx ON airspace_grid (grid_level, control_start_at, control_end_at);');
    await client.query('CREATE INDEX IF NOT EXISTS airspace_grid_history_spacetime_idx ON airspace_grid_state_history (geosot_id, created_at DESC, status, weather_limit);');

    await client.query(`
        CREATE OR REPLACE VIEW valid_airspace_grid AS
        SELECT *
        FROM airspace_grid
        WHERE current_status = 0
          AND COALESCE(weather_limit, false) = false;
    `);

    await client.query(`
        DO $$
        BEGIN
            IF to_regclass('public.airspace_dynamic_control') IS NOT NULL THEN
                EXECUTE '
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
                     AND now() <= d.end_time
                ';
            END IF;
        END $$;
    `);
}

/**
 * 封装insert batch相关逻辑，保持调用处简洁并便于后续维护。
 */
async function insertBatch(client, rows) {
    if (rows.length === 0) return;

    const values = [];
    const params = [];

    rows.forEach((row) => {
        const start = params.length + 1;
        values.push(`(
            $${start}, $${start + 1}, $${start + 2}, $${start + 3}, $${start + 4},
            $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8}, $${start + 9},
            $${start + 10}, $${start + 11}, $${start + 12}, $${start + 13}, $${start + 14},
            $${start + 15}, $${start + 16}, $${start + 17}, $${start + 18},
            ST_MakeEnvelope($${start + 19}, $${start + 20}, $${start + 21}, $${start + 22}, 4326)
        )`);
        params.push(
            row.geosotId,
            row.geosotCode,
            row.gridLevel,
            row.geosotLevel,
            row.x,
            row.y,
            row.z,
            0,
            1,
            'normal',
            1,
            0,
            row.bottom,
            row.top,
            row.z,
            row.maxFlightAltitude,
            0,
            false,
            0,
            row.west,
            row.south,
            row.east,
            row.north,
        );
    });

    await client.query(`
        INSERT INTO airspace_grid (
            geosot_id, geosot_code, grid_level, geosot_level, geosot_x,
            geosot_y, geosot_z, type, fly_weight, surface_type, surface_weight, current_status,
            alt_bottom, alt_top, grid_layer, max_flight_altitude, traffic_density,
            weather_limit, risk_level, geom
        )
        VALUES ${values.join(',')}
        ON CONFLICT (geosot_id) DO UPDATE SET
            geosot_code = EXCLUDED.geosot_code,
            grid_level = EXCLUDED.grid_level,
            geosot_level = EXCLUDED.geosot_level,
            geosot_x = EXCLUDED.geosot_x,
            geosot_y = EXCLUDED.geosot_y,
            geosot_z = EXCLUDED.geosot_z,
            surface_type = COALESCE(airspace_grid.surface_type, EXCLUDED.surface_type),
            surface_weight = COALESCE(airspace_grid.surface_weight, EXCLUDED.surface_weight),
            alt_bottom = EXCLUDED.alt_bottom,
            alt_top = EXCLUDED.alt_top,
            grid_layer = EXCLUDED.grid_layer,
            max_flight_altitude = EXCLUDED.max_flight_altitude,
            geom = EXCLUDED.geom,
            updated_at = NOW();
    `, params);
}

/**
 * 封装generate level相关逻辑，保持调用处简洁并便于后续维护。
 */
async function generateLevel(client, spec) {
    const resolution = estimateResolutionMeters(spec.geosotLevel, 32);
    const lonCells = dmsAlignedAxisCells(spec.bounds.minLon, spec.bounds.maxLon, spec.geosotLevel);
    const latCells = dmsAlignedAxisCells(spec.bounds.minLat, spec.bounds.maxLat, spec.geosotLevel);
    const layerCount = Math.ceil(spec.maxAltitude / spec.verticalStep);

    console.log(`\n${spec.displayName}`);
    console.log(`  水平网格: ${lonCells.length} x ${latCells.length}, 垂直层数: ${layerCount}`);
    console.log(`  南京附近名义尺寸: ${resolution.lonMeters.toFixed(1)}m x ${resolution.latMeters.toFixed(1)}m`);

    let batch = [];
    let total = 0;
    console.time(`  ${spec.key} 写入耗时`);

    for (let z = 0; z < layerCount; z += 1) {
        const altitude = altitudeLayerRange(z, spec);
        for (const lonCell of lonCells) {
            for (const latCell of latCells) {
                const geosotCode = encodeSurface(lonCell.center, latCell.center, spec.geosotLevel);
                batch.push({
                    geosotId: make3DCode(geosotCode, z),
                    geosotCode,
                    gridLevel: spec.key,
                    geosotLevel: spec.geosotLevel,
                    x: lonCell.index,
                    y: latCell.index,
                    z,
                    bottom: altitude.bottom,
                    top: altitude.top,
                    maxFlightAltitude: spec.maxAltitude,
                    west: lonCell.lower,
                    south: latCell.lower,
                    east: lonCell.upper,
                    north: latCell.upper,
                });

                if (batch.length >= BATCH_SIZE) {
                    await insertBatch(client, batch);
                    total += batch.length;
                    batch = [];
                }
            }
        }
    }

    await insertBatch(client, batch);
    total += batch.length;
    console.timeEnd(`  ${spec.key} 写入耗时`);
    console.log(`  已生成 ${total} 个 GeoSOT 三维网格`);
}

/**
 * 封装generate all lodgrids相关逻辑，保持调用处简洁并便于后续维护。
 */
async function generateAllLODGrids() {
    const client = await pool.connect();
    const specs = selectedSpecs();

    try {
        await ensureSchema(client);

        if (!KEEP_EXISTING_GRIDS) {
            await client.query(`
                DO $$
                BEGIN
                    IF to_regclass('public.airspace_dynamic_control') IS NOT NULL THEN
                        EXECUTE 'CREATE TABLE IF NOT EXISTS airspace_dynamic_control_legacy_backup AS TABLE airspace_dynamic_control WITH NO DATA';
                        EXECUTE 'INSERT INTO airspace_dynamic_control_legacy_backup SELECT * FROM airspace_dynamic_control';
                        EXECUTE 'TRUNCATE airspace_dynamic_control';
                    END IF;
                END $$;
            `);

            await client.query(
                'DELETE FROM airspace_grid WHERE grid_level IS NULL OR grid_level <> ALL($1)',
                [Object.keys(GRID_LEVEL_SPECS)],
            );
            await client.query(
                'DELETE FROM airspace_grid WHERE grid_level = ANY($1)',
                [Object.keys(GRID_LEVEL_SPECS)],
            );
        }

        for (const spec of specs) {
            await generateLevel(client, spec);
        }

        console.log('\nGeoSOT 标准网格生成完成。');
        console.log('提示：默认只预生成 L16/L19/L22；如需指定层级，可设置 ONLY_LEVELS=L18,L20；如确需全量可设置 ONLY_LEVELS=ALL。');
    } catch (error) {
        console.error('GeoSOT 标准网格生成失败:', error);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

generateAllLODGrids();

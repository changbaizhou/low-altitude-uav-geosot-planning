/*
 * @file import_surface_weights.js
 * @author changbai
 * @project 基于GeoSOT空域剖分单元状态管控的低空无人机飞行线路规划系统
 * @date 2026-05-10
 * @description L22地物语义权重导入脚本：道路、水域赋予可飞代价，建筑占用高度层设为禁飞。
 */

const fs = require('fs');
const path = require('path');
const { createPool } = require('./dbConfig');

const pool = createPool();

const FRONTEND_SCENE_DIR = path.join(__dirname, '..', 'frontend', 'public', 'scene');
const ROADS_FILE = process.env.SURFACE_ROADS_GEOJSON || path.join(FRONTEND_SCENE_DIR, 'university_roads.geojson');
const WATER_FILE = process.env.SURFACE_WATER_GEOJSON || path.join(FRONTEND_SCENE_DIR, 'university_water.geojson');
const BUILDING_FILE = process.env.BUILDING_GEOJSON || path.join(__dirname, 'buildings.geojson');

const ROAD_WEIGHT = Number(process.env.SURFACE_ROAD_WEIGHT || 3);
const WATER_WEIGHT = Number(process.env.SURFACE_WATER_WEIGHT || 5);
const BUILDING_WEIGHT = Number(process.env.SURFACE_BUILDING_WEIGHT || 20);
const ROAD_BUFFER_M = Number(process.env.SURFACE_ROAD_BUFFER_M || 8);
const WATER_LINE_BUFFER_M = Number(process.env.SURFACE_WATER_LINE_BUFFER_M || 8);
const VERTICAL_CLEARANCE_M = Number(process.env.VERTICAL_CLEARANCE_M || 10);

/**
 * 读取read json输入数据，并做必要的容错处理。
 */
function readJson(filePath, fallback = { type: 'FeatureCollection', features: [] }) {
    if (!fs.existsSync(filePath)) {
        console.warn(`未找到文件，跳过：${filePath}`);
        return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * 封装first positive number相关逻辑，保持调用处简洁并便于后续维护。
 */
function firstPositiveNumber(value) {
    if (value === undefined || value === null) return null;
    const match = String(value).match(/\d+(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0]);
    return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * 读取read building height输入数据，并做必要的容错处理。
 */
function readBuildingHeight(properties = {}) {
    const explicitHeight = firstPositiveNumber(properties.height || properties['height:roof']);
    if (explicitHeight) return explicitHeight;
    const levels = firstPositiveNumber(properties['building:levels']);
    if (levels) return levels * 3.5;
    return 30;
}

/**
 * 判断is linear geometry条件是否成立，供上层流程决定是否继续执行。
 */
function isLinearGeometry(type) {
    return type === 'LineString' || type === 'MultiLineString';
}

/**
 * 判断is area geometry条件是否成立，供上层流程决定是否继续执行。
 */
function isAreaGeometry(type) {
    return type === 'Polygon' || type === 'MultiPolygon';
}

/**
 * 封装feature buffer meters相关逻辑，保持调用处简洁并便于后续维护。
 */
function featureBufferMeters(feature, fallbackMeters) {
    const width = firstPositiveNumber(feature.properties?.width_m || feature.properties?.width);
    if (!width) return fallbackMeters;
    return Math.max(fallbackMeters, width / 2);
}

/**
 * 确保ensure schema所需的表结构、字段或索引存在，保证后续流程可以重复执行。
 */
async function ensureSchema(client) {
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    await client.query("ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS surface_type TEXT DEFAULT 'normal';");
    await client.query('ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS surface_weight NUMERIC DEFAULT 1;');
    await client.query('ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS surface_updated_at TIMESTAMPTZ;');
    const surfaceWeightType = await client.query(`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'airspace_grid'
          AND column_name = 'surface_weight';
    `);
    if (surfaceWeightType.rows[0]?.data_type !== 'numeric') {
        await client.query('ALTER TABLE airspace_grid ALTER COLUMN surface_weight TYPE NUMERIC USING COALESCE(surface_weight::numeric, 1);');
    }
    await client.query('CREATE INDEX IF NOT EXISTS airspace_grid_surface_idx ON airspace_grid (grid_level, surface_type, surface_weight);');
}

/**
 * 封装reset l22 surface相关逻辑，保持调用处简洁并便于后续维护。
 */
async function resetL22Surface(client) {
    const result = await client.query(`
        UPDATE airspace_grid
        SET current_status = CASE
                WHEN surface_type = 'building' AND current_status = 1 THEN 0
                ELSE current_status
            END,
            fly_weight = CASE
                WHEN surface_type = 'building' AND fly_weight >= $1::numeric THEN 1
                ELSE fly_weight
            END,
            risk_level = CASE
                WHEN surface_type = 'building' AND risk_level >= 5 THEN 0
                ELSE risk_level
            END,
            surface_type = 'normal',
            surface_weight = 1,
            surface_updated_at = NOW(),
            updated_at = NOW()
        WHERE grid_level = 'L22';
    `, [BUILDING_WEIGHT]);
    return result.rowCount;
}

/**
 * 封装surface rows from collection相关逻辑，保持调用处简洁并便于后续维护。
 */
function surfaceRowsFromCollection(geojson, surfaceType, weight, defaultBufferMeters) {
    const rows = [];
    for (const feature of geojson.features || []) {
        const geometryType = feature.geometry?.type;
        if (!isLinearGeometry(geometryType) && !isAreaGeometry(geometryType)) continue;
        rows.push({
            surface_type: surfaceType,
            weight,
            buffer_meters: isLinearGeometry(geometryType) ? featureBufferMeters(feature, defaultBufferMeters) : 0,
            geometry: JSON.stringify(feature.geometry),
        });
    }
    return rows;
}

/**
 * 构建building rows from collection所需的数据结构，供后续查询、渲染或路径计算复用。
 */
function buildingRowsFromCollection(geojson) {
    const rows = [];
    for (const feature of geojson.features || []) {
        if (!isAreaGeometry(feature.geometry?.type)) continue;
        rows.push({
            top_altitude: readBuildingHeight(feature.properties) + VERTICAL_CLEARANCE_M,
            geometry: JSON.stringify(feature.geometry),
        });
    }
    return rows;
}

/**
 * 创建create surface temp table所需的临时表、实体或交互对象。
 */
async function createSurfaceTempTable(client, rows) {
    await client.query('DROP TABLE IF EXISTS temp_l22_surface_weight_geoms;');
    await client.query(`
        CREATE TEMP TABLE temp_l22_surface_weight_geoms (
            surface_type TEXT NOT NULL,
            weight NUMERIC NOT NULL,
            geom geometry
        ) ON COMMIT DROP;
    `);
    if (rows.length === 0) return;
    await client.query(`
        INSERT INTO temp_l22_surface_weight_geoms (surface_type, weight, geom)
        SELECT
            item.surface_type,
            item.weight,
            CASE
                WHEN item.buffer_meters > 0 THEN
                    ST_Multi(ST_Buffer(ST_SetSRID(ST_GeomFromGeoJSON(item.geometry), 4326)::geography, item.buffer_meters)::geometry)
                ELSE
                    ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(item.geometry), 4326))
            END AS geom
        FROM jsonb_to_recordset($1::jsonb) AS item(
            surface_type TEXT,
            weight NUMERIC,
            buffer_meters NUMERIC,
            geometry TEXT
        );
    `, [JSON.stringify(rows)]);
    await client.query('CREATE INDEX temp_l22_surface_weight_geoms_gix ON temp_l22_surface_weight_geoms USING GIST (geom);');
    await client.query('ANALYZE temp_l22_surface_weight_geoms;');
}

/**
 * 创建create building temp table所需的临时表、实体或交互对象。
 */
async function createBuildingTempTable(client, rows) {
    await client.query('DROP TABLE IF EXISTS temp_l22_building_surface_geoms;');
    await client.query(`
        CREATE TEMP TABLE temp_l22_building_surface_geoms (
            top_altitude NUMERIC NOT NULL,
            geom geometry
        ) ON COMMIT DROP;
    `);
    if (rows.length === 0) return;
    await client.query(`
        INSERT INTO temp_l22_building_surface_geoms (top_altitude, geom)
        SELECT
            item.top_altitude,
            ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(item.geometry), 4326)) AS geom
        FROM jsonb_to_recordset($1::jsonb) AS item(
            top_altitude NUMERIC,
            geometry TEXT
        );
    `, [JSON.stringify(rows)]);
    await client.query('CREATE INDEX temp_l22_building_surface_geoms_gix ON temp_l22_building_surface_geoms USING GIST (geom);');
    await client.query('ANALYZE temp_l22_building_surface_geoms;');
}

/**
 * 应用apply surface type结果到数据库、实体样式或业务状态中。
 */
async function applySurfaceType(client, surfaceType, weight) {
    const result = await client.query(`
        UPDATE airspace_grid AS grid
        SET surface_type = $1,
            surface_weight = GREATEST(surface_weight, $2::numeric),
            surface_updated_at = NOW()
        WHERE grid.grid_level = 'L22'
          AND EXISTS (
              SELECT 1
              FROM temp_l22_surface_weight_geoms AS surface
              WHERE surface.surface_type = $1
                AND ST_Intersects(grid.geom, surface.geom)
          );
    `, [surfaceType, weight]);
    return result.rowCount;
}

/**
 * 应用apply building restrictions结果到数据库、实体样式或业务状态中。
 */
async function applyBuildingRestrictions(client) {
    const result = await client.query(`
        UPDATE airspace_grid AS grid
        SET current_status = 1,
            fly_weight = GREATEST(fly_weight, $1::numeric),
            risk_level = GREATEST(risk_level, 5),
            surface_type = 'building',
            surface_weight = GREATEST(surface_weight, $1::numeric),
            surface_updated_at = NOW(),
            updated_at = NOW()
        WHERE grid.grid_level = 'L22'
          AND EXISTS (
              SELECT 1
              FROM temp_l22_building_surface_geoms AS building
              WHERE grid.alt_bottom < building.top_altitude
                AND ST_Intersects(grid.geom, building.geom)
          );
    `, [BUILDING_WEIGHT]);
    return result.rowCount;
}

/**
 * 封装import surface weights相关逻辑，保持调用处简洁并便于后续维护。
 */
async function importSurfaceWeights() {
    const client = await pool.connect();
    try {
        const roads = readJson(ROADS_FILE);
        const water = readJson(WATER_FILE);
        const buildings = readJson(BUILDING_FILE);
        const roadRows = surfaceRowsFromCollection(roads, 'road', ROAD_WEIGHT, ROAD_BUFFER_M);
        const waterRows = surfaceRowsFromCollection(water, 'water', WATER_WEIGHT, WATER_LINE_BUFFER_M);
        const buildingRows = buildingRowsFromCollection(buildings);

        await client.query('BEGIN');
        await ensureSchema(client);
        await createSurfaceTempTable(client, [...roadRows, ...waterRows]);
        await createBuildingTempTable(client, buildingRows);
        const resetCount = await resetL22Surface(client);
        const roadTouched = await applySurfaceType(client, 'road', ROAD_WEIGHT);
        const waterTouched = await applySurfaceType(client, 'water', WATER_WEIGHT);
        const buildingTouched = await applyBuildingRestrictions(client);
        await client.query('COMMIT');

        console.log('L22地物权重导入完成：');
        console.log(`  重置 L22 网格：${resetCount}`);
        console.log(`  道路要素：${roadRows.length}，更新网格：${roadTouched}，权重：${ROAD_WEIGHT}`);
        console.log(`  水域要素：${waterRows.length}，更新网格：${waterTouched}，权重：${WATER_WEIGHT}`);
        console.log(`  建筑要素：${buildingRows.length}，禁飞高度层网格：${buildingTouched}`);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('L22地物权重导入失败:', error);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

importSurfaceWeights();

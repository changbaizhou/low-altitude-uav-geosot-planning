/*
 * @file import_obstacles.js
 * @author changbai
 * @project 基于GeoSOT空域剖分单元状态管控的低空无人机飞行线路规划系统
 * @date 2026-05-08
 * @description 障碍物数据导入脚本，用于根据建筑物高度生成空域占用约束。
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.PGUSER || 'postgres',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'uav-db',
    password: process.env.PGPASSWORD,
    port: Number(process.env.PGPORT || 5432),
});

const BUILDING_FILE = process.env.BUILDING_GEOJSON || path.join(__dirname, 'buildings.geojson');
const VERTICAL_CLEARANCE_M = Number(process.env.VERTICAL_CLEARANCE_M || 10);

/**
 * 读取read building height输入数据，并做必要的容错处理。
 */
function readBuildingHeight(properties = {}) {
    if (properties.height) {
        const height = Number(String(properties.height).replace(/[^\d.]/g, ''));
        if (Number.isFinite(height) && height > 0) return height;
    }
    if (properties['building:levels']) {
        const levels = Number(properties['building:levels']);
        if (Number.isFinite(levels) && levels > 0) return levels * 3.5;
    }
    return 30;
}

/**
 * 封装mark obstacles相关逻辑，保持调用处简洁并便于后续维护。
 */
async function markObstacles() {
    console.log('Reading building GeoJSON and mapping obstacles onto GeoSOT grids...');
    const client = await pool.connect();

    try {
        const rawData = fs.readFileSync(BUILDING_FILE, 'utf-8');
        const geojson = JSON.parse(rawData);
        const features = geojson.features || [];
        const totals = new Map();

        await client.query('BEGIN');

        for (const feature of features) {
            if (!feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) continue;

            const topAltitude = readBuildingHeight(feature.properties) + VERTICAL_CLEARANCE_M;
            const geometry = JSON.stringify(feature.geometry);

            const result = await client.query(`
                WITH changed AS (
                    UPDATE airspace_grid
                    SET current_status = 1,
                        fly_weight = GREATEST(fly_weight, 20),
                        risk_level = GREATEST(risk_level, 1),
                        updated_at = NOW()
                    WHERE alt_bottom < $1
                      AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))
                    RETURNING grid_level
                )
                SELECT grid_level, COUNT(*)::integer AS count
                FROM changed
                GROUP BY grid_level;
            `, [topAltitude, geometry]);

            for (const row of result.rows) {
                totals.set(row.grid_level, (totals.get(row.grid_level) || 0) + row.count);
            }
        }

        await client.query('COMMIT');
        console.log('Obstacle mapping finished:');
        for (const [level, count] of totals.entries()) {
            console.log(`  ${level}: ${count} cells marked restricted`);
        }
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Obstacle mapping failed:', error);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

markObstacles();

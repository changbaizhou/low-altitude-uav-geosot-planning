/*
 * @file import_data.js
 * @author changbai
 * @project 基于GeoSOT空域剖分单元状态管控的低空无人机飞行线路规划系统
 * @date 2026-05-08
 * @description 基础空间数据导入脚本，用于写入建筑、道路、水系等数据。
 */

const fs = require('fs');
const { createPool } = require('./dbConfig');

const pool = createPool();

/**
 * 导入匿名化示例大学区域的建筑数据，并映射为基础空域约束。
 */
async function processUniversityData() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 导入示例研究区建筑轮廓，并按楼层数估算屋顶高度。
        console.log('正在导入建筑模型...');
        const data = JSON.parse(fs.readFileSync('university_buildings.json', 'utf8'));
        for (const f of data.features) {
            const height = (f.properties['building:levels'] || 4) * 3.5;
            await client.query(
                `INSERT INTO base_geographic_features (name, type, category, fly_weight, roof_height, geom)
                 VALUES ($1, $2, $3, $4, $5, ST_GeomFromGeoJSON($6))`,
                [
                    'university building',
                    'building',
                    'university_base',
                    10.0,
                    height,
                    JSON.stringify(f.geometry),
                ],
            );
        }

        // 将建筑底面与低于屋顶的空域网格做三维碰撞，形成禁飞约束。
        console.log('正在计算空域网格与建筑的 3D 碰撞...');
        const result = await client.query(`
            UPDATE airspace_grid g
            SET current_status = 2, fly_weight = 10
            FROM base_geographic_features b
            WHERE ST_Intersects(g.geom, b.geom) 
              AND g.alt_bottom < b.roof_height;
        `);

        await client.query('COMMIT');
        console.log(`处理完成！已标记 ${result.rowCount} 个网格为禁飞区。`);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
    } finally {
        client.release();
    }
}
processUniversityData();

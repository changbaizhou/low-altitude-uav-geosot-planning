/*
 * @file setup_database.js
 * @author changbai
 * @description Reproducible database initialization entry for public releases.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createPool, getPostgresConfig } = require('./dbConfig');

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

async function ensureDatabaseExists() {
    const targetDatabase = getPostgresConfig().database;
    if (targetDatabase === 'postgres') return;

    const adminPool = createPool({ database: 'postgres' });
    try {
        const existing = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1;', [targetDatabase]);
        if (existing.rowCount > 0) return;

        console.log(`Creating PostgreSQL database: ${targetDatabase}`);
        await adminPool.query(`CREATE DATABASE ${quoteIdentifier(targetDatabase)};`);
    } catch (error) {
        throw new Error(
            `Unable to create or inspect database "${targetDatabase}". `
            + 'Create it manually, then rerun npm run setup:database. '
            + `Original error: ${error.message}`,
        );
    } finally {
        await adminPool.end();
    }
}

async function ensureExtensions() {
    const pool = createPool();
    try {
        await pool.query('CREATE EXTENSION IF NOT EXISTS postgis;');
        await pool.query('CREATE EXTENSION IF NOT EXISTS btree_gist;');
    } finally {
        await pool.end();
    }
}

function runNodeScript(scriptName) {
    console.log(`\nRunning ${scriptName}...`);
    const result = spawnSync(process.execPath, [path.join(__dirname, scriptName)], {
        cwd: __dirname,
        env: process.env,
        stdio: 'inherit',
    });

    if (result.status !== 0) {
        throw new Error(`${scriptName} failed with exit code ${result.status}.`);
    }
}

async function applySchemaPatch() {
    const patchFile = path.join(__dirname, '..', 'database', 'latest_schema_patch_20260518.sql');
    if (!fs.existsSync(patchFile)) {
        console.log('No schema patch found, skipping.');
        return;
    }

    console.log('\nApplying latest schema patch...');
    const pool = createPool();
    try {
        const sql = fs.readFileSync(patchFile, 'utf8');
        await pool.query(sql);
    } finally {
        await pool.end();
    }
}

async function main() {
    await ensureDatabaseExists();
    await ensureExtensions();
    runNodeScript('generate_grids.js');
    runNodeScript('import_obstacles.js');
    runNodeScript('import_surface_weights.js');
    await applySchemaPatch();
    console.log('\nDatabase setup completed.');
}

main().catch((error) => {
    console.error('\nDatabase setup failed:');
    console.error(error.message || error);
    process.exit(1);
});

/*
 * @file dbConfig.js
 * @author changbai
 * @description Centralized PostgreSQL environment loading and connection helpers.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT_DIR = path.join(__dirname, '..');
const ENV_FILES = [
    path.join(ROOT_DIR, '.env'),
    path.join(__dirname, '.env'),
];

let envLoaded = false;

function parseEnvLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) return null;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (!key) return null;

    if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
    ) {
        value = value.slice(1, -1);
    }

    return { key, value };
}

function loadEnvFiles() {
    if (envLoaded) return;
    envLoaded = true;

    for (const filePath of ENV_FILES) {
        if (!fs.existsSync(filePath)) continue;

        const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const parsed = parseEnvLine(line);
            if (!parsed) continue;
            if (process.env[parsed.key] === undefined) {
                process.env[parsed.key] = parsed.value;
            }
        }
    }
}

function normalizePassword(value) {
    if (value === undefined || value === null) return '';
    const password = String(value);
    const placeholders = new Set([
        'your_postgresql_password',
        'your_password',
        'password',
        'changeme',
    ]);

    if (placeholders.has(password.trim().toLowerCase())) {
        throw new Error(
            'PGPASSWORD is still a placeholder. Edit .env or set PGPASSWORD to your real local PostgreSQL password.',
        );
    }

    return password;
}

function getPostgresConfig(overrides = {}) {
    loadEnvFiles();

    return {
        user: overrides.user || process.env.PGUSER || 'postgres',
        host: overrides.host || process.env.PGHOST || 'localhost',
        database: overrides.database || process.env.PGDATABASE || 'uav-db',
        password: normalizePassword(overrides.password ?? process.env.PGPASSWORD),
        port: Number(overrides.port || process.env.PGPORT || 5432),
    };
}

function createPool(overrides = {}) {
    return new Pool(getPostgresConfig(overrides));
}

module.exports = {
    ROOT_DIR,
    loadEnvFiles,
    getPostgresConfig,
    createPool,
};

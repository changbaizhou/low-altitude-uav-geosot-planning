/*
 * @file server.js
 * @author changbai
 * @project 基于GeoSOT空域剖分单元状态管控的低空无人机飞行线路规划系统
 * @date 2026-05-08
 * @description 后端服务入口文件，负责接口路由、数据库访问与服务启动。
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { createPool } = require('./dbConfig');
const {
    normalizeLevelKey,
    getLevelSpec,
    cellFromLonLat,
    cellSizeDegreesForLevel,
    estimateResolutionMeters,
    altitudeToLayer,
    altitudeLayerRange,
    dmsAlignedAxisCells,
    encodeSurface,
    make3DCode,
    buildLevelMetadata,
} = require('./geosot');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// 数据库连接由 dbConfig 统一读取 .env / 环境变量，避免不同脚本配置不一致。
const pool = createPool();

const UAV_PROFILE = {
    cruiseSpeedMps: 18,
    climbRateMps: 3,
    descendRateMps: 2.5,
    preferredCruiseAlt: 80,
    turnRadiusM: 45,
    maxTurnDeg: 120,
    turnPenaltyM: 420,
    maxIterationsFactor: 30,
};

// 不同规划目标只调整代价权重，搜索框架保持一致，便于和 Dijkstra 基线做公平对比。
const OBJECTIVE_PROFILES = {
    balanced: { riskWeight: 1.0, trafficWeight: 1.0, turnWeight: 3.2, altitudeWeight: 1.0 },
    shortest: { riskWeight: 0.35, trafficWeight: 0.4, turnWeight: 1.8, altitudeWeight: 0.4 },
    safest: { riskWeight: 2.0, trafficWeight: 1.6, turnWeight: 3.6, altitudeWeight: 1.0 },
};

const DEFAULT_TERRAIN_CLEARANCE_M = 60;
const DEFAULT_LEVEL = 'L22';
const MIN_OPERATIONAL_GEOSOT_LEVEL = 15;
const AXIS_TOUCH_TOLERANCE_DEG = 1e-11;
const DISPLAY_GRID_LIMIT = 40000;
const DEFAULT_DISPLAY_GRID_LIMIT = 8000;
const DATABASE_DISPLAY_LEVELS = new Set(['L16', 'L19', 'L22']);
const DATABASE_OBSTACLE_LEVELS = new Set(['L16', 'L19', 'L22']);
// Only real-time occupied airspace should block new planning. Archived route traces remain for replay/statistics.
const OCCUPANCY_ACTIVE_STATUSES = ['active'];
const OCCUPANCY_ARCHIVE_STATUS = 'archived';
const OCCUPANCY_TIME_BUFFER_MS = Number(process.env.OCCUPANCY_TIME_BUFFER_MS || 500);
const OCCUPANCY_ARCHIVE_BUFFER_SECONDS = Number(process.env.OCCUPANCY_ARCHIVE_BUFFER_SECONDS || 0.5);
const OCCUPANCY_SAMPLE_INTERVAL_SECONDS = Number(process.env.OCCUPANCY_SAMPLE_INTERVAL_SECONDS || 0.5);
const OCCUPANCY_QUERY_PADDING_SECONDS = Number(process.env.OCCUPANCY_QUERY_PADDING_SECONDS || 60);
const BUILDING_GEOJSON_FILE = process.env.BUILDING_GEOJSON || path.join(__dirname, 'buildings.geojson');
const OBSTACLE_VERTICAL_CLEARANCE_M = Number(process.env.VERTICAL_CLEARANCE_M || 10);
const BUILDING_SURFACE_WEIGHT = Number(process.env.BUILDING_SURFACE_WEIGHT || 20);
const QWEATHER_API_KEY = process.env.QWEATHER_API_KEY || '';
const QWEATHER_API_HOST = process.env.QWEATHER_API_HOST || 'https://devapi.qweather.com';
const QWEATHER_LOCATION = process.env.QWEATHER_LOCATION || '118.78,31.92';
const WEATHER_CONTROL_LEVELS = (process.env.WEATHER_CONTROL_LEVELS || 'L22')
    .split(',')
    .map((level) => normalizeLevelKey(level))
    .filter((level, index, levels) => DATABASE_DISPLAY_LEVELS.has(level) && levels.indexOf(level) === index);
if (WEATHER_CONTROL_LEVELS.length === 0) WEATHER_CONTROL_LEVELS.push('L22');
const WEATHER_CONTROL_WIND_SCALE_LIMIT = Number(process.env.WEATHER_CONTROL_WIND_SCALE_LIMIT || 6);
const WEATHER_CONTROL_STRONG_WIND_SCALE_LIMIT = Number(process.env.WEATHER_CONTROL_STRONG_WIND_SCALE_LIMIT || 8);
const WEATHER_CONTROL_VISIBILITY_KM_LIMIT = Number(process.env.WEATHER_CONTROL_VISIBILITY_KM_LIMIT || 2);
const WEATHER_SEVERE_TEXT_PATTERNS = ['雷', '暴雨', '冰雹', '台风', '大雾', '浓雾', '强风'];
const WEATHER_RISK_TEXT_PATTERNS = ['雨', '雪', '雾', '霾', '沙尘', '扬沙', '浮尘', '大风'];

// 默认停机坪作为演示数据兜底；数据库中没有记录时会自动写入这些初始点。
const DEFAULT_HELIPADS = [
    {
        helipadCode: 'H-01',
        name: '西北停机坪',
        lon: 118.776350,
        lat: 31.919350,
        alt: 30,
        notes: 'university northwest helipad',
    },
    {
        helipadCode: 'H-02',
        name: '东北停机坪',
        lon: 118.785750,
        lat: 31.919350,
        alt: 30,
        notes: 'university northeast helipad',
    },
    {
        helipadCode: 'H-03',
        name: '西南停机坪',
        lon: 118.776350,
        lat: 31.913550,
        alt: 30,
        notes: 'university southwest helipad',
    },
    {
        helipadCode: 'H-04',
        name: '东南停机坪',
        lon: 118.785750,
        lat: 31.913550,
        alt: 30,
        notes: 'university southeast helipad',
    },
];
let obstacleGeojsonCache = null;

/**
 * 封装to finite number相关逻辑，保持调用处简洁并便于后续维护。
 */
function toFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
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
 * 解析parse display limit输入值，并在异常或缺省时给出可控的默认结果。
 */
function parseDisplayLimit(value) {
    const limit = Number(value);
    if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_DISPLAY_GRID_LIMIT;
    return Math.max(500, Math.min(DISPLAY_GRID_LIMIT, Math.floor(limit)));
}

/**
 * 解析parse display altitude输入值，并在异常或缺省时给出可控的默认结果。
 */
function parseDisplayAltitude(value, spec) {
    const altitude = Number(value);
    if (!Number.isFinite(altitude)) return null;
    return Math.max(0, Math.min(altitude, spec.maxAltitude - 0.000001));
}

/**
 * 封装geometry bounds相关逻辑，保持调用处简洁并便于后续维护。
 */
function geometryBounds(geometry) {
    const bounds = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };

    /**
     * 封装visit相关逻辑，保持调用处简洁并便于后续维护。
     */
    function visit(coordinates) {
        if (!Array.isArray(coordinates)) return;
        if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
            const lon = Number(coordinates[0]);
            const lat = Number(coordinates[1]);
            if (Number.isFinite(lon) && Number.isFinite(lat)) {
                bounds.west = Math.min(bounds.west, lon);
                bounds.south = Math.min(bounds.south, lat);
                bounds.east = Math.max(bounds.east, lon);
                bounds.north = Math.max(bounds.north, lat);
            }
            return;
        }
        coordinates.forEach(visit);
    }

    visit(geometry?.coordinates);
    if (![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) return null;
    return bounds;
}

/**
 * 封装query bounds相关逻辑，保持调用处简洁并便于后续维护。
 */
function queryBounds(query) {
    const bounds = {
        west: Number(query.west),
        south: Number(query.south),
        east: Number(query.east),
        north: Number(query.north),
    };
    if (![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) return null;
    return bounds;
}

/**
 * 封装bounds intersect相关逻辑，保持调用处简洁并便于后续维护。
 */
function boundsIntersect(a, b) {
    return a.west <= b.east
        && a.east >= b.west
        && a.south <= b.north
        && a.north >= b.south;
}

/**
 * 加载load obstacle geojson相关数据，并把结果同步到当前模块状态。
 */
function loadObstacleGeojson() {
    if (!fs.existsSync(BUILDING_GEOJSON_FILE)) {
        return { type: 'FeatureCollection', features: [] };
    }

    const stat = fs.statSync(BUILDING_GEOJSON_FILE);
    if (obstacleGeojsonCache?.mtimeMs === stat.mtimeMs) {
        return obstacleGeojsonCache.data;
    }

    const source = JSON.parse(fs.readFileSync(BUILDING_GEOJSON_FILE, 'utf-8'));
    const features = (source.features || [])
        .filter((feature) => feature?.geometry && ['Polygon', 'MultiPolygon'].includes(feature.geometry.type))
        .map((feature, index) => {
            const properties = feature.properties || {};
            const height = readBuildingHeight(properties);
            const obstacleTop = height + OBSTACLE_VERTICAL_CLEARANCE_M;
            const bbox = geometryBounds(feature.geometry);
            if (!bbox) return null;

            return {
                ...feature,
                id: feature.id || properties['@id'] || `obstacle-${index + 1}`,
                bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
                properties: {
                    ...properties,
                    obstacle_height_m: Number(height.toFixed(2)),
                    obstacle_clearance_m: Number(OBSTACLE_VERTICAL_CLEARANCE_M.toFixed(2)),
                    obstacle_top_m: Number(obstacleTop.toFixed(2)),
                    obstacle_source: path.basename(BUILDING_GEOJSON_FILE),
                },
            };
        })
        .filter(Boolean);

    const data = {
        type: 'FeatureCollection',
        name: source.name || '建筑障碍物',
        features,
    };
    obstacleGeojsonCache = { mtimeMs: stat.mtimeMs, data };
    return data;
}

/**
 * 规范化normalize surface type输入，减少接口参数和内部数据格式差异带来的判断分支。
 */
function normalizeSurfaceType(type) {
    return String(type || 'normal').trim().toLowerCase() || 'normal';
}

/**
 * 判断is building surface条件是否成立，供上层流程决定是否继续执行。
 */
function isBuildingSurface(type) {
    return normalizeSurfaceType(type) === 'building';
}

/**
 * 解析parse grid row输入值，并在异常或缺省时给出可控的默认结果。
 */
function parseGridRow(row) {
    const surfaceType = normalizeSurfaceType(row.surface_type);
    const surfaceWeight = Number(row.surface_weight || 1);
    const buildingBlocked = isBuildingSurface(surfaceType);
    const storedStatus = Number(row.current_status || 0);
    return {
        id: String(row.id),
        geosotId: row.geosot_id,
        geosotCode: row.geosot_code,
        gridLevel: row.grid_level,
        geosotLevel: Number(row.geosot_level),
        x: Number(row.geosot_x),
        y: Number(row.geosot_y),
        z: Number(row.geosot_z),
        lon: Number(row.lon),
        lat: Number(row.lat),
        west: Number(row.west),
        south: Number(row.south),
        east: Number(row.east),
        north: Number(row.north),
        bottom: Number(row.alt_bottom),
        top: Number(row.alt_top),
        currentStatus: buildingBlocked ? 1 : storedStatus,
        storedStatus,
        surfaceType,
        surfaceWeight,
        flyWeight: Math.max(
            Number(row.fly_weight || 1),
            surfaceWeight,
            Number(row.weather_fly_weight || 1),
            buildingBlocked ? BUILDING_SURFACE_WEIGHT : 1,
        ),
        trafficDensity: Math.max(Number(row.traffic_density || 0), Number(row.weather_traffic_density || 0)),
        weatherLimit: Boolean(row.weather_limit),
        controlStartAt: row.control_start_at,
        controlEndAt: row.control_end_at,
        riskLevel: Math.max(
            Number(row.risk_level || 0),
            Number(row.weather_risk_level || 0),
            buildingBlocked ? 5 : 0,
        ),
        geometryText: row.geometry_text,
    };
}

/**
 * 判断is control active条件是否成立，供上层流程决定是否继续执行。
 */
function isControlActive(grid, now = Date.now()) {
    if (!grid.controlStartAt || !grid.controlEndAt) return false;
    return new Date(grid.controlStartAt).getTime() <= now && now <= new Date(grid.controlEndAt).getTime();
}

/**
 * 封装occupancy window to ms相关逻辑，保持调用处简洁并便于后续维护。
 */
function occupancyWindowToMs(window) {
    if (!window) return null;
    const enterMs = Number.isFinite(window.enterMs)
        ? window.enterMs
        : new Date(window.entered_at || window.enteredAt).getTime();
    const leaveMs = Number.isFinite(window.leaveMs)
        ? window.leaveMs
        : new Date(window.exited_at || window.exitedAt || window.leave_at).getTime();
    if (!Number.isFinite(enterMs) || !Number.isFinite(leaveMs) || enterMs >= leaveMs) return null;
    return { enterMs, leaveMs };
}

/**
 * 判断is grid occupied during条件是否成立，供上层流程决定是否继续执行。
 */
function isGridOccupiedDuring(grid, startMs, endMs, bufferMs = OCCUPANCY_TIME_BUFFER_MS) {
    const windows = Array.isArray(grid?.occupancyWindows) ? grid.occupancyWindows : [];
    if (windows.length === 0) return false;
    const from = Math.min(startMs, endMs) - bufferMs;
    const to = Math.max(startMs, endMs) + bufferMs;
    return windows.some((window) => {
        const range = occupancyWindowToMs(window);
        return range && range.enterMs < to && range.leaveMs > from;
    });
}

/**
 * 判断is grid occupied at条件是否成立，供上层流程决定是否继续执行。
 */
function isGridOccupiedAt(grid, timeMs, bufferMs = OCCUPANCY_TIME_BUFFER_MS) {
    return isGridOccupiedDuring(grid, timeMs, timeMs, bufferMs);
}

/**
 * 判断is grid usable at条件是否成立，供上层流程决定是否继续执行。
 */
function isGridUsableAt(grid, timeMs = Date.now()) {
    if (!grid || grid.weatherLimit) return false;
    if (isBuildingSurface(grid.surfaceType || grid.surface_type)) return false;
    if (grid.currentStatus !== 0) return false;
    const hasTimedControl = Boolean(grid.controlStartAt && grid.controlEndAt);
    if (hasTimedControl && isControlActive(grid, timeMs)) return false;
    if (isGridOccupiedAt(grid, timeMs)) return false;
    return true;
}

/**
 * 判断is grid usable条件是否成立，供上层流程决定是否继续执行。
 */
function isGridUsable(grid) {
    return isGridUsableAt(grid, Date.now());
}

/**
 * 解析parse departure time输入值，并在异常或缺省时给出可控的默认结果。
 */
function parseDepartureTime(value) {
    if (!value) return Date.now();
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : Date.now();
}

/**
 * 封装client error message相关逻辑，保持调用处简洁并便于后续维护。
 */
function clientErrorMessage(error, fallback = '服务器内部错误') {
    const refused = error?.code === 'ECONNREFUSED'
        || error?.errors?.some?.((item) => item.code === 'ECONNREFUSED');
    if (refused) {
        return '无法连接本机 PostGIS 数据库：请先启动 PostgreSQL/PostGIS，再重新生成 GeoSOT 网格。';
    }
    return error?.message || fallback;
}

/**
 * 确保ensure spatiotemporal index schema所需的表结构、字段或索引存在，保证后续流程可以重复执行。
 */
async function ensureSpatiotemporalIndexSchema() {
    // 这些字段和索引用于支撑“GeoSOT 编码 + 状态 + 时间”的快速过滤。
    await pool.query("ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS surface_type TEXT DEFAULT 'normal';");
    await pool.query('ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS surface_weight NUMERIC DEFAULT 1;');
    await pool.query('ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS surface_updated_at TIMESTAMPTZ;');
    await pool.query('ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS weather_risk_level NUMERIC DEFAULT 0;');
    await pool.query('ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS weather_fly_weight NUMERIC DEFAULT 1;');
    await pool.query('ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS weather_traffic_density NUMERIC DEFAULT 0;');
    await pool.query('ALTER TABLE airspace_grid ADD COLUMN IF NOT EXISTS weather_updated_at TIMESTAMPTZ;');
    await pool.query('CREATE INDEX IF NOT EXISTS airspace_grid_geosot_time_idx ON airspace_grid (grid_level, geosot_code, geosot_z, current_status, weather_limit);');
    await pool.query('CREATE INDEX IF NOT EXISTS airspace_grid_control_time_idx ON airspace_grid (grid_level, control_start_at, control_end_at);');
    await pool.query('CREATE INDEX IF NOT EXISTS airspace_grid_history_spacetime_idx ON airspace_grid_state_history (geosot_id, created_at DESC, status, weather_limit);');
    await pool.query('CREATE INDEX IF NOT EXISTS airspace_grid_weather_scope_idx ON airspace_grid (grid_level, weather_limit, weather_risk_level);');
    await pool.query('CREATE INDEX IF NOT EXISTS airspace_grid_surface_idx ON airspace_grid (grid_level, surface_type, surface_weight);');
}

/**
 * 启动服务前确认基础网格表已经生成，避免新环境直接启动时报晦涩的数据库错误。
 */
async function ensureBaseGridSchemaReady() {
    const result = await pool.query(`
        SELECT
            to_regclass('public.airspace_grid') AS grid_table,
            to_regclass('public.airspace_grid_state_history') AS history_table;
    `);
    const row = result.rows[0] || {};

    if (!row.grid_table || !row.history_table) {
        throw new Error(
            'Database is not initialized. Run "cd backend && npm install && npm run setup:database" first.',
        );
    }
}

/**
 * 解析parse wind scale输入值，并在异常或缺省时给出可控的默认结果。
 */
function parseWindScale(value) {
    const matches = String(value || '').match(/\d+(?:\.\d+)?/g);
    if (!matches) return null;
    const numbers = matches.map(Number).filter(Number.isFinite);
    return numbers.length ? Math.max(...numbers) : null;
}

/**
 * 解析parse visibility km输入值，并在异常或缺省时给出可控的默认结果。
 */
function parseVisibilityKm(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * 规范化normalize weather payload输入，减少接口参数和内部数据格式差异带来的判断分支。
 */
function normalizeWeatherPayload(data, location) {
    const now = data.now || {};
    return {
        location,
        text: now.text || '未知',
        temp: now.temp || '--',
        feelsLike: now.feelsLike || '--',
        windDir: now.windDir || '--',
        windScale: now.windScale || '--',
        windSpeed: now.windSpeed || '--',
        humidity: now.humidity || '--',
        precip: now.precip || '--',
        vis: now.vis || '--',
        obsTime: now.obsTime || data.updateTime || null,
        updateTime: data.updateTime || null,
    };
}

/**
 * 封装fetch weather now相关逻辑，保持调用处简洁并便于后续维护。
 */
async function fetchWeatherNow(location = QWEATHER_LOCATION) {
    const cleanLocation = String(location || QWEATHER_LOCATION).trim();
    const url = new URL('/v7/weather/now', QWEATHER_API_HOST);
    url.searchParams.set('location', cleanLocation);
    url.searchParams.set('key', QWEATHER_API_KEY);

    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    if (!response.ok || data.code !== '200') {
        throw new Error(data?.message || data?.code || `天气接口异常 ${response.status}`);
    }
    return normalizeWeatherPayload(data, cleanLocation);
}

// 气象策略只负责判定影响强度：雷雨/大雾等硬约束禁飞，普通降水或中等风力提高风险。
function assessWeatherControl(weather) {
    const text = String(weather?.text || '');
    const severeText = WEATHER_SEVERE_TEXT_PATTERNS.filter((pattern) => text.includes(pattern));
    const riskText = WEATHER_RISK_TEXT_PATTERNS.filter((pattern) => text.includes(pattern));
    const windScale = parseWindScale(weather?.windScale);
    const visibilityKm = parseVisibilityKm(weather?.vis);
    const reasons = [];
    let action = 'none';
    let level = '低';
    let weatherLimit = false;
    let riskLevel = 0;
    let flyWeight = 1;
    let trafficDensity = 0;

    /**
     * 封装raise risk相关逻辑，保持调用处简洁并便于后续维护。
     */
    function raiseRisk(nextLevel, risk, weight, traffic, reason) {
        action = action === 'restrict' ? 'restrict' : 'risk';
        level = nextLevel === '高' || level === '高' ? '高' : '中';
        riskLevel = Math.max(riskLevel, risk);
        flyWeight = Math.max(flyWeight, weight);
        trafficDensity = Math.max(trafficDensity, traffic);
        if (reason) reasons.push(reason);
    }

    /**
     * 封装restrict相关逻辑，保持调用处简洁并便于后续维护。
     */
    function restrict(nextLevel, reason) {
        action = 'restrict';
        weatherLimit = true;
        level = nextLevel;
        riskLevel = Math.max(riskLevel, 1);
        flyWeight = Math.max(flyWeight, 3);
        trafficDensity = Math.max(trafficDensity, 12);
        if (reason) reasons.push(reason);
    }

    if (severeText.length) {
        restrict('高', `严重天气${text}`);
    } else if (riskText.length) {
        raiseRisk(text.includes('大雨') || text.includes('大风') || text.includes('沙尘') ? '高' : '中', 0.45, 1.5, 4, `天气${text}`);
    }

    if (windScale !== null) {
        if (windScale >= WEATHER_CONTROL_STRONG_WIND_SCALE_LIMIT) {
            restrict('高', `强风${weather.windScale}级`);
        } else if (windScale >= WEATHER_CONTROL_WIND_SCALE_LIMIT) {
            raiseRisk('高', 0.65, 1.9, 7, `风力${weather.windScale}级`);
        }
    }

    if (visibilityKm !== null) {
        if (visibilityKm <= 1) {
            restrict('高', `能见度${visibilityKm}km`);
        } else if (visibilityKm <= WEATHER_CONTROL_VISIBILITY_KM_LIMIT) {
            raiseRisk('高', 0.7, 2.1, 8, `能见度${visibilityKm}km`);
        }
    }

    return {
        restricted: weatherLimit,
        action,
        level,
        reason: reasons.length ? reasons.join(' / ') : `天气${text || '正常'}，风力${weather?.windScale || '--'}级`,
        weatherLimit,
        riskLevel,
        flyWeight,
        trafficDensity,
        windScale,
        visibilityKm,
        severeText,
        riskText,
    };
}

/**
 * 规范化normalize weather scope输入，减少接口参数和内部数据格式差异带来的判断分支。
 */
function normalizeWeatherScope(input = {}) {
    const rawLevels = Array.isArray(input.levels)
        ? input.levels
        : (typeof input.levels === 'string' ? input.levels.split(',') : WEATHER_CONTROL_LEVELS);
    const levels = rawLevels
        .map((level) => normalizeLevelKey(level))
        .filter((level) => DATABASE_DISPLAY_LEVELS.has(level));
    const west = Number(input.west);
    const south = Number(input.south);
    const east = Number(input.east);
    const north = Number(input.north);
    const hasBounds = [west, south, east, north].every(Number.isFinite) && west < east && south < north;
    return {
        levels: levels.length ? Array.from(new Set(levels)) : WEATHER_CONTROL_LEVELS,
        bounds: hasBounds ? { west, south, east, north } : null,
    };
}

/**
 * 根据当前视野或任务范围拼接气象管控的空间过滤条件，避免全域无差别更新。
 */
function weatherScopeSql(scope, startIndex = 1) {
    const values = [scope.levels];
    let clause = `grid_level = ANY($${startIndex}::text[])`;
    if (scope.bounds) {
        values.push(scope.bounds.west, scope.bounds.south, scope.bounds.east, scope.bounds.north);
        clause += ` AND ST_Intersects(geom, ST_SetSRID(ST_MakeEnvelope($${startIndex + 1}::numeric, $${startIndex + 2}::numeric, $${startIndex + 3}::numeric, $${startIndex + 4}::numeric), 4326))`;
    }
    return { clause, values };
}

/**
 * 封装weather control counts相关逻辑，保持调用处简洁并便于后续维护。
 */
async function weatherControlCounts(levels = WEATHER_CONTROL_LEVELS, bounds = null) {
    const scope = normalizeWeatherScope({ levels, ...(bounds || {}) });
    const scoped = weatherScopeSql(scope, 1);
    const result = await pool.query(`
        SELECT
            COUNT(*)::int AS total_count,
            COUNT(*) FILTER (WHERE weather_limit IS TRUE)::int AS restricted_count,
            COUNT(*) FILTER (WHERE weather_limit IS TRUE OR weather_risk_level > 0)::int AS affected_count
        FROM airspace_grid
        WHERE ${scoped.clause};
    `, scoped.values);
    return {
        total: Number(result.rows[0]?.total_count || 0),
        restricted: Number(result.rows[0]?.restricted_count || 0),
        affected: Number(result.rows[0]?.affected_count || 0),
    };
}

/**
 * 封装latest weather control event相关逻辑，保持调用处简洁并便于后续维护。
 */
async function latestWeatherControlEvent(scope = normalizeWeatherScope()) {
    const scoped = weatherScopeSql(scope, 1);
    const result = await pool.query(`
        SELECT history.weather_limit, history.status, history.reason, history.created_at
        FROM airspace_grid_state_history history
        JOIN airspace_grid grid_cell ON grid_cell.geosot_id = history.geosot_id
        WHERE history.reason LIKE '气象自动%'
          AND ${scoped.clause.replace(/\bgrid_level\b/g, 'grid_cell.grid_level').replace(/\bgeom\b/g, 'grid_cell.geom')}
        ORDER BY history.created_at DESC
        LIMIT 1;
    `, scoped.values);
    return result.rows[0] || null;
}

// 气象管控写入主表，同时追加状态历史，保证当前规划和论文中的历史回放使用同一套数据。
async function applyWeatherControlPolicy(policy, reason, scope = normalizeWeatherScope()) {
    const scoped = weatherScopeSql(scope, 5);
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const result = await client.query(`
            WITH updated AS (
                UPDATE airspace_grid
                SET weather_limit = $1,
                    weather_risk_level = $2,
                    weather_fly_weight = $3,
                    weather_traffic_density = $4,
                    weather_updated_at = NOW(),
                    updated_at = NOW()
                WHERE ${scoped.clause}
                  AND (
                    weather_limit IS DISTINCT FROM $1
                    OR weather_risk_level IS DISTINCT FROM $2
                    OR weather_fly_weight IS DISTINCT FROM $3
                    OR weather_traffic_density IS DISTINCT FROM $4
                  )
                RETURNING
                    geosot_id, current_status, weather_limit,
                    GREATEST(fly_weight, weather_fly_weight) AS fly_weight,
                    GREATEST(traffic_density, weather_traffic_density) AS traffic_density
            ), history AS (
                INSERT INTO airspace_grid_state_history (
                    geosot_id, status, fly_weight, traffic_density, weather_limit,
                    control_start_at, control_end_at, reason
                )
                SELECT
                    geosot_id,
                    CASE WHEN weather_limit THEN 1 ELSE current_status END,
                    fly_weight,
                    traffic_density,
                    weather_limit,
                    NULL,
                    NULL,
                    $${scoped.values.length + 5}
                FROM updated
                RETURNING 1
            )
            SELECT COUNT(*)::int AS updated_count FROM updated;
        `, [
            Boolean(policy.weatherLimit),
            Number(policy.riskLevel || 0),
            Number(policy.flyWeight || 1),
            Number(policy.trafficDensity || 0),
            ...scoped.values,
            reason,
        ]);
        await client.query('COMMIT');
        return Number(result.rows[0]?.updated_count || 0);
    } catch (error) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('气象管控回滚失败:', rollbackError);
            }
        }
        throw error;
    } finally {
        if (client) client.release();
    }
}

/**
 * 清理clear weather control policy相关状态，避免旧图层、旧结果或临时数据影响下一次操作。
 */
function clearWeatherControlPolicy() {
    return {
        weatherLimit: false,
        riskLevel: 0,
        flyWeight: 1,
        trafficDensity: 0,
    };
}

/**
 * 确保ensure route archive schema所需的表结构、字段或索引存在，保证后续流程可以重复执行。
 */
async function ensureRouteArchiveSchema() {
    await pool.query(`
        CREATE EXTENSION IF NOT EXISTS postgis;
        CREATE EXTENSION IF NOT EXISTS btree_gist;

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
            route_geojson JSONB NOT NULL,
            grid_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
            track_geom geometry(LineStringZ, 4326),
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS planned_routes_created_idx ON planned_routes (created_at DESC);
        CREATE INDEX IF NOT EXISTS planned_routes_track_gix ON planned_routes USING GIST (track_geom);

        CREATE TABLE IF NOT EXISTS planned_route_occupancy (
            id BIGSERIAL PRIMARY KEY,
            route_id BIGINT REFERENCES planned_routes(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            geosot_id TEXT NOT NULL,
            geosot_code TEXT,
            grid_level TEXT NOT NULL,
            geosot_level INTEGER,
            geosot_x BIGINT,
            geosot_y BIGINT,
            geosot_z INTEGER,
            alt_bottom NUMERIC,
            alt_top NUMERIC,
            entered_at TIMESTAMPTZ NOT NULL,
            exited_at TIMESTAMPTZ NOT NULL,
            eta_at TIMESTAMPTZ,
            uav_id TEXT,
            mission_id TEXT,
            status TEXT NOT NULL DEFAULT 'planned',
            source TEXT NOT NULL DEFAULT 'route_archive',
            geom geometry(Polygon, 4326),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (entered_at < exited_at)
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
    `);
    await pool.query(`
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS route_type TEXT DEFAULT 'mission';
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS objective TEXT;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS start_lon NUMERIC;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS start_lat NUMERIC;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS start_alt NUMERIC;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS end_lon NUMERIC;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS end_lat NUMERIC;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS end_alt NUMERIC;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS distance_m NUMERIC DEFAULT 0;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS estimated_seconds NUMERIC DEFAULT 0;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS grid_count INTEGER DEFAULT 0;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS waypoint_count INTEGER DEFAULT 0;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS risk_level TEXT;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS risk_score NUMERIC DEFAULT 0;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS route_geojson JSONB;
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS grid_ids TEXT[] DEFAULT ARRAY[]::TEXT[];
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS track_geom geometry(LineStringZ, 4326);
        ALTER TABLE planned_routes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS route_id BIGINT REFERENCES planned_routes(id) ON DELETE CASCADE;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS sequence INTEGER;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS geosot_id TEXT;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS geosot_code TEXT;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS grid_level TEXT;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS geosot_level INTEGER;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS geosot_x BIGINT;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS geosot_y BIGINT;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS geosot_z INTEGER;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS alt_bottom NUMERIC;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS alt_top NUMERIC;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS entered_at TIMESTAMPTZ;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS exited_at TIMESTAMPTZ;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS eta_at TIMESTAMPTZ;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS uav_id TEXT;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS mission_id TEXT;
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planned';
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'route_archive';
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS geom geometry(Polygon, 4326);
        ALTER TABLE planned_route_occupancy ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);
    await pool.query(`
        UPDATE planned_route_occupancy
        SET status = $1
        WHERE source = 'route_archive'
          AND status <> $1;
    `, [OCCUPANCY_ARCHIVE_STATUS]);
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
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
    `);
}

/**
 * 确保ensure helipad schema所需的表结构、字段或索引存在，保证后续流程可以重复执行。
 */
async function ensureHelipadSchema() {
    await pool.query(`
        CREATE EXTENSION IF NOT EXISTS postgis;

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
    `);

    const defaultCodes = DEFAULT_HELIPADS.map((helipad) => helipad.helipadCode);
    const existingDefaults = await pool.query(`
        SELECT helipad_code
        FROM helipads
        WHERE helipad_code = ANY($1::varchar[]);
    `, [defaultCodes]);
    const existingCodes = new Set(existingDefaults.rows.map((row) => row.helipad_code));

    for (const helipad of DEFAULT_HELIPADS) {
        if (existingCodes.has(helipad.helipadCode)) continue;
        await pool.query(`
            INSERT INTO helipads (helipad_code, name, lon, lat, alt, notes)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (helipad_code) DO NOTHING;
        `, [
            helipad.helipadCode,
            helipad.name,
            helipad.lon,
            helipad.lat,
            helipad.alt,
            helipad.notes,
        ]);
    }
}

/**
 * 确保ensure control area schema所需的表结构、字段或索引存在，保证后续流程可以重复执行。
 */
async function ensureControlAreaSchema() {
    await pool.query(`
        CREATE EXTENSION IF NOT EXISTS postgis;

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
    `);
}

/**
 * 封装finite or null相关逻辑，保持调用处简洁并便于后续维护。
 */
function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * 规范化normalize helipad row输入，减少接口参数和内部数据格式差异带来的判断分支。
 */
function normalizeHelipadRow(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        helipad_code: row.helipad_code,
        code: row.helipad_code,
        name: row.name,
        lon: Number(row.lon),
        lat: Number(row.lat),
        alt: Number(row.alt || 0),
        status: row.status,
        notes: row.notes || '',
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

/**
 * 规范化normalize control area row输入，减少接口参数和内部数据格式差异带来的判断分支。
 */
function normalizeControlAreaRow(row) {
    if (!row) return null;
    const now = Date.now();
    const startMs = new Date(row.start_at).getTime();
    const endMs = new Date(row.end_at).getTime();
    return {
        id: Number(row.id),
        name: row.name,
        west: Number(row.west),
        south: Number(row.south),
        east: Number(row.east),
        north: Number(row.north),
        start_at: row.start_at,
        end_at: row.end_at,
        status: row.status,
        active_now: row.status !== 'deleted' && startMs <= now && now <= endMs,
        affected_grid_count: Number(row.affected_grid_count || 0),
        notes: row.notes || '',
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

/**
 * 封装expire finished control areas相关逻辑，保持调用处简洁并便于后续维护。
 */
async function expireFinishedControlAreas() {
    await ensureControlAreaSchema();
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const expired = await client.query(`
            UPDATE control_areas
            SET status = 'expired',
                updated_at = NOW()
            WHERE status = 'active' AND end_at < NOW()
            RETURNING id, name, start_at, end_at, geom;
        `);

        for (const area of expired.rows) {
            const clear = await client.query(`
                UPDATE airspace_grid
                SET control_start_at = NULL,
                    control_end_at = NULL,
                    updated_at = NOW()
                WHERE ST_Intersects(geom, $1::geometry)
                  AND control_start_at = $2
                  AND control_end_at = $3
                RETURNING geosot_id, current_status;
            `, [area.geom, area.start_at, area.end_at]);

            if (clear.rows.length) {
                await client.query(`
                    INSERT INTO airspace_grid_state_history (
                        geosot_id, status, fly_weight, traffic_density, weather_limit,
                        control_start_at, control_end_at, reason
                    )
                    SELECT geosot_id, status, NULL, NULL, NULL, NULL, NULL, $2
                    FROM jsonb_to_recordset($1::jsonb) AS item(geosot_id text, status integer);
                `, [JSON.stringify(clear.rows.map((row) => ({
                    geosot_id: row.geosot_id,
                    status: Number(row.current_status || 0),
                }))), `管控区到期自动解除：${area.name}`]);
            }
        }

        await client.query('COMMIT');
        return expired.rowCount;
    } catch (error) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('管控区到期回滚失败:', rollbackError);
            }
        }
        throw error;
    } finally {
        if (client) client.release();
    }
}

/**
 * 规范化normalize archive point输入，减少接口参数和内部数据格式差异带来的判断分支。
 */
function normalizeArchivePoint(point) {
    if (!point) return null;
    const lon = finiteOrNull(point.lon);
    const lat = finiteOrNull(point.lat);
    if (lon == null || lat == null) return null;
    return {
        lon,
        lat,
        alt: finiteOrNull(point.alt) ?? 0,
    };
}

/**
 * 封装compact number相关逻辑，保持调用处简洁并便于后续维护。
 */
function compactNumber(value, digits = 9) {
    return Number(value).toFixed(digits).replace(/\.?0+$/, '');
}

/**
 * 封装route line wkt相关逻辑，保持调用处简洁并便于后续维护。
 */
function routeLineWkt(waypoints) {
    const points = (waypoints || []).map(normalizeArchivePoint).filter(Boolean);
    if (points.length < 2) return null;
    return `LINESTRING Z (${points.map((point) => [
        compactNumber(point.lon),
        compactNumber(point.lat),
        compactNumber(point.alt, 3),
    ].join(' ')).join(', ')})`;
}

/**
 * 封装route type label相关逻辑，保持调用处简洁并便于后续维护。
 */
function routeTypeLabel(routeType) {
    if (routeType === 'comparison') return '方案对比';
    return '规划航线';
}

/**
 * 封装default route name相关逻辑，保持调用处简洁并便于后续维护。
 */
function defaultRouteName(routeType) {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    return `${routeTypeLabel(routeType)} ${stamp}`;
}

/**
 * 封装archive route summary相关逻辑，保持调用处简洁并便于后续维护。
 */
function archiveRouteSummary(row) {
    return {
        id: Number(row.id),
        name: row.route_name,
        route_name: row.route_name,
        route_type: row.route_type,
        objective: row.objective,
        created_at: row.created_at,
        start: {
            lon: Number(row.start_lon),
            lat: Number(row.start_lat),
            alt: Number(row.start_alt || 0),
        },
        end: {
            lon: Number(row.end_lon),
            lat: Number(row.end_lat),
            alt: Number(row.end_alt || 0),
        },
        distance_m: Number(row.distance_m || 0),
        estimated_seconds: Number(row.estimated_seconds || 0),
        grid_count: Number(row.grid_count || 0),
        waypoint_count: Number(row.waypoint_count || 0),
        risk_level: row.risk_level || '低',
        risk_score: Number(row.risk_score || 0),
    };
}

/**
 * 解析parse iso ms输入值，并在异常或缺省时给出可控的默认结果。
 */
function parseIsoMs(value) {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
}

/**
 * 封装route timeline items相关逻辑，保持调用处简洁并便于后续维护。
 */
function routeTimelineItems(route) {
    const timeline = Array.isArray(route?.route?.timeline) ? route.route.timeline : [];
    if (timeline.length) {
        return timeline
            .map((item, index) => ({
                sequence: index,
                geosotId: item.geosot_id,
                gridLevel: item.grid_level,
                etaMs: parseIsoMs(item.eta),
            }))
            .filter((item) => item.geosotId && item.gridLevel && Number.isFinite(item.etaMs));
    }

    const features = Array.isArray(route?.features) ? route.features : [];
    const departureMs = parseDepartureTime(route?.metadata?.departure_time);
    const estimatedSeconds = Math.max(1, Number(route?.metadata?.estimated_seconds || features.length || 1));
    const stepSeconds = estimatedSeconds / Math.max(1, features.length);
    return features
        .map((feature, index) => ({
            sequence: index,
            geosotId: feature?.properties?.geosot_id,
            gridLevel: feature?.properties?.grid_level,
            etaMs: departureMs + stepSeconds * index * 1000,
        }))
        .filter((item) => item.geosotId && item.gridLevel && Number.isFinite(item.etaMs));
}

/**
 * 封装route waypoint items相关逻辑，保持调用处简洁并便于后续维护。
 */
function routeWaypointItems(route) {
    return (Array.isArray(route?.route?.waypoints) ? route.route.waypoints : [])
        .map(normalizeArchivePoint)
        .filter((point) => point && Number.isFinite(point.lon) && Number.isFinite(point.lat));
}

/**
 * 封装dominant route level相关逻辑，保持调用处简洁并便于后续维护。
 */
function dominantRouteLevel(route) {
    const counts = new Map();
    const addLevel = (level) => {
        try {
            const key = normalizeLevelKey(level);
            if (DATABASE_DISPLAY_LEVELS.has(key)) counts.set(key, (counts.get(key) || 0) + 1);
        } catch {
            // Ignore malformed historical route metadata.
        }
    };

    addLevel(route?.metadata?.level);
    for (const phase of route?.metadata?.phases || []) addLevel(phase.level || phase.requested_level);
    for (const feature of route?.features || []) addLevel(feature?.properties?.grid_level);

    if (counts.size === 0) return DEFAULT_LEVEL;
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * 封装level at route time相关逻辑，保持调用处简洁并便于后续维护。
 */
function levelAtRouteTime(timeline, timeMs, fallbackLevel) {
    if (!timeline.length) return fallbackLevel;
    let nearest = timeline[0];
    let nearestDelta = Math.abs(timeMs - nearest.etaMs);
    for (let index = 1; index < timeline.length; index += 1) {
        const candidate = timeline[index];
        const delta = Math.abs(timeMs - candidate.etaMs);
        if (delta < nearestDelta) {
            nearest = candidate;
            nearestDelta = delta;
        }
    }
    return nearest.gridLevel || fallbackLevel;
}

/**
 * 封装grid identity at point相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridIdentityAtPoint(point, levelKey) {
    const spec = getLevelSpec(levelKey);
    const cell = cellFromLonLat(point.lon, point.lat, spec.geosotLevel);
    const safeAlt = Math.max(0, Math.min(Number(point.alt || 0), spec.maxAltitude - 1e-6));
    const z = altitudeToLayer(safeAlt, spec);
    const geosotCode = encodeSurface(point.lon, point.lat, spec.geosotLevel);
    return {
        geosotId: make3DCode(geosotCode, z),
        geosotCode,
        gridLevel: spec.key,
    };
}

/**
 * 把航线时间轴离散为网格占用记录，使无人机飞到哪里就占用对应空域体元。
 */
function buildRouteOccupancyRecords(route, routeId, options = {}) {
    const waypoints = routeWaypointItems(route);
    if (waypoints.length < 2) return [];
    const timeline = routeTimelineItems(route);
    const departureMs = parseDepartureTime(route?.metadata?.departure_time);
    const fallbackLevel = dominantRouteLevel(route);
    const sampleInterval = Math.max(0.2, Number(options.sampleIntervalSeconds || OCCUPANCY_SAMPLE_INTERVAL_SECONDS));
    const bufferMs = Math.max(0, Number(options.bufferSeconds ?? OCCUPANCY_ARCHIVE_BUFFER_SECONDS)) * 1000;
    const uavId = String(options.uavId || options.uav_id || `route-${routeId}`).slice(0, 80);
    const missionId = options.missionId || options.mission_id || null;
    const records = [];
    let active = null;
    let elapsedSeconds = 0;
    let sequence = 0;

    /**
     * 封装close active相关逻辑，保持调用处简洁并便于后续维护。
     */
    function closeActive(exitMs) {
        if (!active) return;
        const enteredMs = active.enteredMs - bufferMs;
        const exitedMs = Math.max(exitMs + bufferMs, enteredMs + 200);
        records.push({
            sequence: sequence,
            geosot_id: active.geosotId,
            grid_level: active.gridLevel,
            entered_at: new Date(enteredMs).toISOString(),
            exited_at: new Date(exitedMs).toISOString(),
            eta_at: new Date((enteredMs + exitedMs) / 2).toISOString(),
            uav_id: uavId,
            mission_id: missionId,
        });
        sequence += 1;
        active = null;
    }

    /**
     * 封装visit point相关逻辑，保持调用处简洁并便于后续维护。
     */
    function visitPoint(point, timeMs) {
        const level = levelAtRouteTime(timeline, timeMs, fallbackLevel);
        const identity = gridIdentityAtPoint(point, level);
        if (active && active.geosotId === identity.geosotId && active.gridLevel === identity.gridLevel) {
            active.lastMs = timeMs;
            return;
        }
        closeActive(timeMs);
        active = { ...identity, enteredMs: timeMs, lastMs: timeMs };
    }

    visitPoint(waypoints[0], departureMs);

    for (let index = 1; index < waypoints.length; index += 1) {
        const prev = waypoints[index - 1];
        const next = waypoints[index];
        const segmentSeconds = waypointSegmentSeconds(prev, next);
        const samples = Math.max(1, Math.ceil(segmentSeconds / sampleInterval));
        for (let sample = 1; sample <= samples; sample += 1) {
            const ratio = sample / samples;
            const segmentElapsed = segmentSeconds * ratio;
            const timeMs = departureMs + (elapsedSeconds + segmentElapsed) * 1000;
            visitPoint(pointAtRatio(prev, next, ratio), timeMs);
        }
        elapsedSeconds += segmentSeconds;
    }

    closeActive(departureMs + elapsedSeconds * 1000);
    return records;
}

/**
 * 在保存航线后写入网格占用时间窗，为后续避让规划和容量统计提供依据。
 */
async function insertRouteOccupancy(client, routeId, route, options = {}) {
    const records = buildRouteOccupancyRecords(route, routeId, options);
    if (records.length === 0) return 0;

    const result = await client.query(`
        WITH items AS (
            SELECT *
            FROM jsonb_to_recordset($2::jsonb) AS item(
                sequence integer,
                geosot_id text,
                grid_level text,
                entered_at timestamptz,
                exited_at timestamptz,
                eta_at timestamptz,
                uav_id text,
                mission_id text
            )
        )
        INSERT INTO planned_route_occupancy (
            route_id, sequence, geosot_id, geosot_code, grid_level,
            geosot_level, geosot_x, geosot_y, geosot_z,
            alt_bottom, alt_top, entered_at, exited_at, eta_at,
            uav_id, mission_id, status, source, geom
        )
        SELECT
            $1,
            item.sequence,
            grid_cell.geosot_id,
            grid_cell.geosot_code,
            grid_cell.grid_level,
            grid_cell.geosot_level,
            grid_cell.geosot_x,
            grid_cell.geosot_y,
            grid_cell.geosot_z,
            grid_cell.alt_bottom,
            grid_cell.alt_top,
            item.entered_at,
            item.exited_at,
            item.eta_at,
            item.uav_id,
            item.mission_id,
            $3,
            'route_archive',
            grid_cell.geom
        FROM items item
        JOIN airspace_grid grid_cell ON grid_cell.geosot_id = item.geosot_id
        ON CONFLICT (route_id, sequence) DO NOTHING;
    `, [routeId, JSON.stringify(records), OCCUPANCY_ARCHIVE_STATUS]);

    return result.rowCount;
}

/**
 * 封装grid key相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridKey(x, y, z) {
    return `${x}:${y}:${z}`;
}

/**
 * 封装key of grid相关逻辑，保持调用处简洁并便于后续维护。
 */
function keyOfGrid(grid) {
    return gridKey(grid.x, grid.y, grid.z);
}

/**
 * 封装center altitude相关逻辑，保持调用处简洁并便于后续维护。
 */
function centerAltitude(grid) {
    return (grid.bottom + grid.top) / 2;
}

/**
 * 封装distance3 d相关逻辑，保持调用处简洁并便于后续维护。
 */
function distance3D(a, b) {
    const avgLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
    const dx = (a.lon - b.lon) * 111320 * Math.cos(avgLat);
    const dy = (a.lat - b.lat) * 110574;
    const dz = (a.alt - b.alt);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 封装vector meters相关逻辑，保持调用处简洁并便于后续维护。
 */
function vectorMeters(from, to) {
    const avgLat = ((from.lat + to.lat) / 2) * Math.PI / 180;
    return {
        x: (to.lon - from.lon) * 111320 * Math.cos(avgLat),
        y: (to.lat - from.lat) * 110574,
        z: to.alt - from.alt,
    };
}

/**
 * 封装horizontal distance meters相关逻辑，保持调用处简洁并便于后续维护。
 */
function horizontalDistanceMeters(a, b) {
    const avgLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
    const dx = (a.lon - b.lon) * 111320 * Math.cos(avgLat);
    const dy = (a.lat - b.lat) * 110574;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 规范化normalize terrain profile输入，减少接口参数和内部数据格式差异带来的判断分支。
 */
function normalizeTerrainProfile(options = {}) {
    const raw = options.terrain || options.terrainProfile;
    const samples = Array.isArray(raw?.samples)
        ? raw.samples.map((sample) => ({
            lon: finiteOrNull(sample.lon),
            lat: finiteOrNull(sample.lat),
            height: finiteOrNull(sample.height ?? sample.elevation ?? sample.alt),
        })).filter((sample) => sample.lon != null && sample.lat != null && sample.height != null)
        : [];

    const rawClearance = raw?.minClearanceM
        ?? raw?.min_clearance_m
        ?? raw?.minAgl
        ?? raw?.min_agl_m
        ?? options.minTerrainClearanceM
        ?? DEFAULT_TERRAIN_CLEARANCE_M;

    return {
        enabled: samples.length > 0,
        minClearanceM: Math.max(0, Math.min(300, toFiniteNumber(rawClearance, DEFAULT_TERRAIN_CLEARANCE_M))),
        sampleCount: samples.length,
        samples,
        heightCache: new Map(),
    };
}

/**
 * 封装terrain metadata相关逻辑，保持调用处简洁并便于后续维护。
 */
function terrainMetadata(terrain) {
    return {
        enabled: Boolean(terrain?.enabled),
        min_clearance_m: terrain?.enabled ? terrain.minClearanceM : 0,
        sample_count: terrain?.sampleCount || 0,
    };
}

/**
 * 封装terrain height at相关逻辑，保持调用处简洁并便于后续维护。
 */
function terrainHeightAt(lon, lat, terrain) {
    if (!terrain?.enabled) return null;

    const cacheKey = `${lon.toFixed(6)}:${lat.toFixed(6)}`;
    if (terrain.heightCache.has(cacheKey)) return terrain.heightCache.get(cacheKey);

    let nearest = [];
    for (const sample of terrain.samples) {
        const distance = horizontalDistanceMeters({ lon, lat }, sample);
        if (distance < 0.5) {
            terrain.heightCache.set(cacheKey, sample.height);
            return sample.height;
        }
        nearest.push({ sample, distance });
    }

    nearest.sort((a, b) => a.distance - b.distance);
    nearest = nearest.slice(0, 6);
    let weightedHeight = 0;
    let weightSum = 0;
    for (const item of nearest) {
        const weight = 1 / Math.max(1, item.distance * item.distance);
        weightedHeight += item.sample.height * weight;
        weightSum += weight;
    }

    const height = weightSum > 0 ? weightedHeight / weightSum : 0;
    terrain.heightCache.set(cacheKey, height);
    return height;
}

/**
 * 封装terrain clearance at相关逻辑，保持调用处简洁并便于后续维护。
 */
function terrainClearanceAt(point, terrain) {
    if (!terrain?.enabled) return Infinity;
    // 系统中的网格高度是相对地面的飞行高度，不是海拔高程。
    // 地形采样只用于确认离地净空，不能把 DEM 高程再次叠加到规划高度上。
    const agl = point.agl ?? point.alt;
    return Number.isFinite(Number(agl)) ? Number(agl) : Infinity;
}

/**
 * 判断is point terrain safe条件是否成立，供上层流程决定是否继续执行。
 */
function isPointTerrainSafe(point, terrain) {
    if (!terrain?.enabled) return true;
    return terrainClearanceAt(point, terrain) >= terrain.minClearanceM;
}

/**
 * 判断is grid terrain usable条件是否成立，供上层流程决定是否继续执行。
 */
function isGridTerrainUsable(grid, terrain) {
    if (!terrain?.enabled) return true;
    return isPointTerrainSafe(gridCenterPoint(grid), terrain);
}

/**
 * 封装grid center point相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridCenterPoint(grid) {
    return {
        lon: grid.lon,
        lat: grid.lat,
        alt: centerAltitude(grid),
        geosot_id: grid.geosotId,
    };
}

/**
 * 校验validate point输入，提前阻断不合法的任务参数。
 */
function validatePoint(point, name) {
    if (!point || !Number.isFinite(Number(point.lon)) || !Number.isFinite(Number(point.lat))) {
        const label = name === 'start' ? '起点' : (name === 'end' ? '终点' : name);
        const error = new Error(`${label}缺少经纬度`);
        error.statusCode = 400;
        throw error;
    }

    return {
        lon: Number(point.lon),
        lat: Number(point.lat),
        alt: toFiniteNumber(point.alt, 0),
    };
}

/**
 * 获取get grid by coords对应对象或配置，集中处理选择规则。
 */
async function getGridByCoords(lon, lat, alt, levelKey) {
    const spec = getLevelSpec(levelKey);
    const fallback = await pool.query(`
        SELECT
            id::text,
            geosot_id,
            geosot_code,
            grid_level,
            geosot_level,
            geosot_x,
            geosot_y,
            geosot_z,
            ST_X(ST_Centroid(geom)) AS lon,
            ST_Y(ST_Centroid(geom)) AS lat,
            ST_XMin(geom) AS west,
            ST_YMin(geom) AS south,
            ST_XMax(geom) AS east,
            ST_YMax(geom) AS north,
            alt_bottom,
            alt_top,
            current_status,
            fly_weight,
            surface_type,
            surface_weight,
            weather_fly_weight,
            traffic_density,
            weather_traffic_density,
            weather_limit,
            control_start_at,
            control_end_at,
            risk_level,
            weather_risk_level,
            ST_AsGeoJSON(geom) AS geometry_text
        FROM airspace_grid
        WHERE grid_level = $4
          AND alt_bottom <= $3::numeric
          AND alt_top > $3::numeric
          AND ST_Covers(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
        ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
        LIMIT 1;
    `, [lon, lat, Math.max(0, alt), spec.key]);

    return fallback.rows[0] ? parseGridRow(fallback.rows[0]) : null;
}

/**
 * 按起终点外包范围读取候选空域网格，并补齐起终点所在体元，控制搜索规模。
 */
async function fetchPlanningRows(start, end, levelKey, startGrid, endGrid) {
    const spec = getLevelSpec(levelKey);
    const step = cellSizeDegreesForLevel(spec.geosotLevel);
    const horizontalDistance = distance3D({ ...start, alt: 0 }, { ...end, alt: 0 });
    const distanceDegrees = horizontalDistance / 111000;
    const isFineLevel = spec.key === 'L22';
    const margin = isFineLevel
        ? Math.max(step * 30, 0.006, distanceDegrees * 0.35)
        : Math.max(step * 12, 0.002, distanceDegrees * 0.18);
    const minLon = Math.max(spec.bounds.minLon, Math.min(start.lon, end.lon) - margin);
    const maxLon = Math.min(spec.bounds.maxLon, Math.max(start.lon, end.lon) + margin);
    const minLat = Math.max(spec.bounds.minLat, Math.min(start.lat, end.lat) - margin);
    const maxLat = Math.min(spec.bounds.maxLat, Math.max(start.lat, end.lat) + margin);
    const verticalBuffer = isFineLevel ? spec.maxAltitude : spec.verticalStep * 2;
    const lowerAlt = isFineLevel
        ? 0
        : Math.max(0, Math.min(start.alt, end.alt, startGrid.bottom, endGrid.bottom) - verticalBuffer);
    const upperAlt = isFineLevel
        ? spec.maxAltitude
        : Math.min(spec.maxAltitude, Math.max(start.alt, end.alt, startGrid.top, endGrid.top) + verticalBuffer);

    const result = await pool.query(`
        SELECT
            id::text,
            geosot_id,
            geosot_code,
            grid_level,
            geosot_level,
            geosot_x,
            geosot_y,
            geosot_z,
            ST_X(ST_Centroid(geom)) AS lon,
            ST_Y(ST_Centroid(geom)) AS lat,
            ST_XMin(geom) AS west,
            ST_YMin(geom) AS south,
            ST_XMax(geom) AS east,
            ST_YMax(geom) AS north,
            alt_bottom,
            alt_top,
            current_status,
            fly_weight,
            surface_type,
            surface_weight,
            weather_fly_weight,
            traffic_density,
            weather_traffic_density,
            weather_limit,
            control_start_at,
            control_end_at,
            risk_level,
            weather_risk_level,
            ST_AsGeoJSON(geom) AS geometry_text
        FROM airspace_grid
        WHERE grid_level = $1
          AND alt_top > $6::numeric
          AND alt_bottom < $7::numeric
          AND ST_Intersects(geom, ST_SetSRID(ST_MakeEnvelope($2, $3, $4, $5), 4326));
    `, [spec.key, minLon, minLat, maxLon, maxLat, lowerAlt, upperAlt]);

    return result.rows.map(parseGridRow);
}

/**
 * 判断should avoid occupancy条件是否成立，供上层流程决定是否继续执行。
 */
function shouldAvoidOccupancy(options = {}) {
    return options.avoidOccupancy !== false;
}

/**
 * 封装planning rows bounds相关逻辑，保持调用处简洁并便于后续维护。
 */
function planningRowsBounds(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows.reduce((bounds, row) => ({
        west: Math.min(bounds.west, row.west),
        south: Math.min(bounds.south, row.south),
        east: Math.max(bounds.east, row.east),
        north: Math.max(bounds.north, row.north),
        minAlt: Math.min(bounds.minAlt, row.bottom),
        maxAlt: Math.max(bounds.maxAlt, row.top),
    }), {
        west: Infinity,
        south: Infinity,
        east: -Infinity,
        north: -Infinity,
        minAlt: Infinity,
        maxAlt: -Infinity,
    });
}

/**
 * 计算estimate planning horizon seconds指标，用于路径评价、界面显示或约束判断。
 */
function estimatePlanningHorizonSeconds(start, end, options = {}) {
    const requested = Number(options.occupancyHorizonSeconds || options.expectedFlightSeconds || 0);
    if (Number.isFinite(requested) && requested > 0) return Math.max(60, requested);
    const directSeconds = distance3D(start, end) / Math.max(1, UAV_PROFILE.cruiseSpeedMps);
    return Math.max(180, directSeconds * 4 + 120);
}

/**
 * 给候选网格附加已规划航线的占用时间窗，路径搜索时可按时间避让。
 */
async function attachOccupancyWindows(rows, levelKey, departureMs, horizonSeconds, options = {}) {
    if (!shouldAvoidOccupancy(options) || !Array.isArray(rows) || rows.length === 0) {
        return { active: false, occupied_cells: 0, occupancy_windows: 0 };
    }

    const bounds = planningRowsBounds(rows);
    if (!bounds) return { active: true, occupied_cells: 0, occupancy_windows: 0 };
    const from = new Date(departureMs - OCCUPANCY_QUERY_PADDING_SECONDS * 1000);
    const to = new Date(departureMs + (horizonSeconds + OCCUPANCY_QUERY_PADDING_SECONDS) * 1000);
    const excludeRouteId = Number.isInteger(Number(options.excludeRouteId)) ? Number(options.excludeRouteId) : null;

    const result = await pool.query(`
        SELECT
            geosot_id,
            route_id,
            uav_id,
            mission_id,
            entered_at,
            exited_at
        FROM planned_route_occupancy
        WHERE status = ANY($1::text[])
          AND grid_level = $2
          AND entered_at < $4
          AND exited_at > $3
          AND alt_top > $9::numeric
          AND alt_bottom < $10::numeric
          AND ($11::bigint IS NULL OR route_id <> $11::bigint)
          AND ST_Intersects(
              geom,
              ST_SetSRID(ST_MakeEnvelope($5::numeric, $6::numeric, $7::numeric, $8::numeric), 4326)
          );
    `, [
        OCCUPANCY_ACTIVE_STATUSES,
        levelKey,
        from,
        to,
        bounds.west,
        bounds.south,
        bounds.east,
        bounds.north,
        bounds.minAlt,
        bounds.maxAlt,
        excludeRouteId,
    ]);

    const byGrid = new Map();
    for (const row of result.rows) {
        const enterMs = new Date(row.entered_at).getTime();
        const leaveMs = new Date(row.exited_at).getTime();
        if (!Number.isFinite(enterMs) || !Number.isFinite(leaveMs)) continue;
        if (!byGrid.has(row.geosot_id)) byGrid.set(row.geosot_id, []);
        byGrid.get(row.geosot_id).push({
            enterMs,
            leaveMs,
            routeId: row.route_id == null ? null : Number(row.route_id),
            uavId: row.uav_id,
            missionId: row.mission_id,
        });
    }

    let occupiedCells = 0;
    for (const row of rows) {
        const windows = byGrid.get(row.geosotId) || [];
        row.occupancyWindows = windows;
        if (windows.length) occupiedCells += 1;
    }

    return {
        active: true,
        occupied_cells: occupiedCells,
        occupancy_windows: result.rows.length,
        query_from: from.toISOString(),
        query_to: to.toISOString(),
    };
}

/**
 * 封装copy occupancy from rows相关逻辑，保持调用处简洁并便于后续维护。
 */
function copyOccupancyFromRows(targetGrid, rows) {
    const found = rows.find((row) => keyOfGrid(row) === keyOfGrid(targetGrid));
    targetGrid.occupancyWindows = found?.occupancyWindows || [];
    return found || targetGrid;
}

/**
 * 定义MinHeap类，封装本模块中需要复用的数据结构和操作。
 */
class MinHeap {
    /**
     * 封装constructor相关逻辑，保持调用处简洁并便于后续维护。
     */
    constructor() {
        this.items = [];
    }

    /**
     * 封装push相关逻辑，保持调用处简洁并便于后续维护。
     */
    push(item) {
        this.items.push(item);
        this.bubbleUp(this.items.length - 1);
    }

    /**
     * 封装pop相关逻辑，保持调用处简洁并便于后续维护。
     */
    pop() {
        if (this.items.length === 0) return null;
        const top = this.items[0];
        const last = this.items.pop();
        if (this.items.length > 0) {
            this.items[0] = last;
            this.bubbleDown(0);
        }
        return top;
    }

    /**
     * 返回当前堆中待扩展节点数量，A*主循环用它判断搜索是否结束。
     */
    get length() {
        return this.items.length;
    }

    /**
     * 新节点入堆后向上调整，保证队首始终是总代价最小的候选节点。
     */
    bubbleUp(index) {
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.items[parent].f <= this.items[index].f) break;
            [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
            index = parent;
        }
    }

    /**
     * 弹出队首后向下调整，维持最小堆的优先级顺序。
     */
    bubbleDown(index) {
        const length = this.items.length;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            let smallest = index;

            if (left < length && this.items[left].f < this.items[smallest].f) smallest = left;
            if (right < length && this.items[right].f < this.items[smallest].f) smallest = right;
            if (smallest === index) break;

            [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
            index = smallest;
        }
    }
}

/**
 * 构建build directions所需的数据结构，供后续查询、渲染或路径计算复用。
 */
function buildDirections() {
    return [
        { dx: 1, dy: 0, dz: 0 },
        { dx: -1, dy: 0, dz: 0 },
        { dx: 0, dy: 1, dz: 0 },
        { dx: 0, dy: -1, dz: 0 },
        { dx: 0, dy: 0, dz: 1 },
        { dx: 0, dy: 0, dz: -1 },
    ];
}

const NEIGHBOR_DIRECTIONS = buildDirections();

// GeoSOT 网格索引不一定是连续整数，先建立相邻轴映射，再判断真实相接的六邻域。
function buildAxisLookup(rows) {
    const xBounds = new Map();
    const yBounds = new Map();

    /**
     * 封装remember bounds相关逻辑，保持调用处简洁并便于后续维护。
     */
    function rememberBounds(map, key, lower, upper) {
        if (!Number.isFinite(key) || !Number.isFinite(lower) || !Number.isFinite(upper)) return;
        const prev = map.get(key);
        if (!prev) {
            map.set(key, { lower, upper });
            return;
        }
        prev.lower = Math.min(prev.lower, lower);
        prev.upper = Math.max(prev.upper, upper);
    }

    for (const row of rows) {
        rememberBounds(xBounds, row.x, row.west, row.east);
        rememberBounds(yBounds, row.y, row.south, row.north);
    }

    const xs = Array.from(xBounds.keys()).sort((a, b) => a - b);
    const ys = Array.from(yBounds.keys()).sort((a, b) => a - b);
    const xNext = new Map();
    const xPrev = new Map();
    const yNext = new Map();
    const yPrev = new Map();

    /**
     * 封装link touching axes相关逻辑，保持调用处简洁并便于后续维护。
     */
    function linkTouchingAxes(values, bounds, nextMap, prevMap) {
        for (let i = 0; i < values.length - 1; i += 1) {
            const left = bounds.get(values[i]);
            const right = bounds.get(values[i + 1]);
            if (!left || !right) continue;
            if (Math.abs(left.upper - right.lower) <= AXIS_TOUCH_TOLERANCE_DEG) {
                nextMap.set(values[i], values[i + 1]);
                prevMap.set(values[i + 1], values[i]);
            }
        }
    }

    linkTouchingAxes(xs, xBounds, xNext, xPrev);
    linkTouchingAxes(ys, yBounds, yNext, yPrev);

    return {
        xs,
        ys,
        xNext,
        xPrev,
        yNext,
        yPrev,
    };
}

/**
 * 封装neighbor key相关逻辑，保持调用处简洁并便于后续维护。
 */
function neighborKey(curr, direction, axisLookup) {
    let nextX = curr.x;
    let nextY = curr.y;
    if (direction.dx > 0) nextX = axisLookup?.xNext.get(curr.x);
    if (direction.dx < 0) nextX = axisLookup?.xPrev.get(curr.x);
    if (direction.dy > 0) nextY = axisLookup?.yNext.get(curr.y);
    if (direction.dy < 0) nextY = axisLookup?.yPrev.get(curr.y);
    const nextZ = curr.z + direction.dz;
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY) || nextZ < 0) return null;
    return gridKey(nextX, nextY, nextZ);
}

/**
 * 判断is guard cell usable条件是否成立，供上层流程决定是否继续执行。
 */
function isGuardCellUsable(key, gridMap, timeMs) {
    if (!key || !gridMap.has(key)) return false;
    return isGridUsableAt(gridMap.get(key), timeMs);
}

// 斜穿拐角时必须确认两侧桥接网格可用，防止航线从两个禁飞格之间“擦边”通过。
function passesCornerGuard(curr, direction, gridMap, axisLookup, timeMs) {
    const { dx, dy, dz } = direction;
    const checks = [];

    if (dx !== 0 && dy !== 0) {
        checks.push(neighborKey(curr, { dx, dy: 0, dz: 0 }, axisLookup));
        checks.push(neighborKey(curr, { dx: 0, dy, dz: 0 }, axisLookup));
    }
    if (dx !== 0 && dz !== 0) {
        checks.push(neighborKey(curr, { dx, dy: 0, dz: 0 }, axisLookup));
        checks.push(neighborKey(curr, { dx: 0, dy: 0, dz }, axisLookup));
    }
    if (dy !== 0 && dz !== 0) {
        checks.push(neighborKey(curr, { dx: 0, dy, dz: 0 }, axisLookup));
        checks.push(neighborKey(curr, { dx: 0, dy: 0, dz }, axisLookup));
    }

    return checks.every((key) => isGuardCellUsable(key, gridMap, timeMs));
}

/**
 * 封装segment seconds相关逻辑，保持调用处简洁并便于后续维护。
 */
function segmentSeconds(curr, next) {
    const start = gridCenterPoint(curr);
    const end = gridCenterPoint(next);
    const horizontal = distance3D({ ...start, alt: 0 }, { ...end, alt: 0 });
    const vertical = end.alt - start.alt;
    const horizontalSeconds = horizontal / UAV_PROFILE.cruiseSpeedMps;
    const verticalSeconds = Math.abs(vertical) / (vertical >= 0 ? UAV_PROFILE.climbRateMps : UAV_PROFILE.descendRateMps);
    return Math.max(horizontalSeconds, verticalSeconds, 0.1);
}

/**
 * 封装violates flight envelope相关逻辑，保持调用处简洁并便于后续维护。
 */
function violatesFlightEnvelope(curr, next) {
    const seconds = segmentSeconds(curr, next);
    const verticalRate = Math.abs(centerAltitude(next) - centerAltitude(curr)) / seconds;
    const goingUp = centerAltitude(next) >= centerAltitude(curr);
    const limit = goingUp ? UAV_PROFILE.climbRateMps : UAV_PROFILE.descendRateMps;
    return verticalRate > limit * 1.05;
}

/**
 * 封装turn angle deg相关逻辑，保持调用处简洁并便于后续维护。
 */
function turnAngleDeg(prev, curr, next) {
    if (!prev) return 0;
    const a = gridCenterPoint(prev);
    const b = gridCenterPoint(curr);
    const c = gridCenterPoint(next);
    const ab = vectorMeters(a, b);
    const bc = vectorMeters(b, c);
    const dot = ab.x * bc.x + ab.y * bc.y + ab.z * bc.z;
    const abLen = Math.sqrt(ab.x * ab.x + ab.y * ab.y + ab.z * ab.z);
    const bcLen = Math.sqrt(bc.x * bc.x + bc.y * bc.y + bc.z * bc.z);
    if (abLen === 0 || bcLen === 0) return 0;
    const cos = Math.max(-1, Math.min(1, dot / (abLen * bcLen)));
    return Math.acos(cos) * 180 / Math.PI;
}

/**
 * 封装turn angle between points相关逻辑，保持调用处简洁并便于后续维护。
 */
function turnAngleBetweenPoints(prev, curr, next) {
    if (!prev) return 0;
    const ab = vectorMeters(prev, curr);
    const bc = vectorMeters(curr, next);
    const dot = ab.x * bc.x + ab.y * bc.y + ab.z * bc.z;
    const abLen = Math.sqrt(ab.x * ab.x + ab.y * ab.y + ab.z * ab.z);
    const bcLen = Math.sqrt(bc.x * bc.x + bc.y * bc.y + bc.z * bc.z);
    if (abLen === 0 || bcLen === 0) return 0;
    const cos = Math.max(-1, Math.min(1, dot / (abLen * bcLen)));
    return Math.acos(cos) * 180 / Math.PI;
}

/**
 * 获取get objective profile对应对象或配置，集中处理选择规则。
 */
function getObjectiveProfile(objective = 'balanced') {
    return OBJECTIVE_PROFILES[objective] || OBJECTIVE_PROFILES.balanced;
}

/**
 * 判断is baseline dijkstra条件是否成立，供上层流程决定是否继续执行。
 */
function isBaselineDijkstra(options = {}) {
    const value = String(options.algorithm || options.objective || '').toLowerCase();
    return ['baseline', 'dijkstra', 'baseline-dijkstra'].includes(value);
}

/**
 * 封装search state key相关逻辑，保持调用处简洁并便于后续维护。
 */
function searchStateKey(currentKey, prevKey = '') {
    return `${prevKey || 'START'}>${currentKey}`;
}

/**
 * 封装current key from state相关逻辑，保持调用处简洁并便于后续维护。
 */
function currentKeyFromState(stateKey) {
    const index = String(stateKey).indexOf('>');
    return index >= 0 ? stateKey.slice(index + 1) : stateKey;
}

// 基线 Dijkstra 只计算距离；改进 A* 在距离上叠加状态权重、交通密度、风险和转弯惩罚。
function movementCost(curr, next, prev, options = {}) {
    const baseDistance = distance3D(gridCenterPoint(curr), gridCenterPoint(next));
    if (isBaselineDijkstra(options)) {
        return baseDistance;
    }

    const profile = getObjectiveProfile(options.objective);
    const flyWeight = Math.max(1, (curr.flyWeight + next.flyWeight) / 2);
    const trafficFactor = 1 + (Math.max(0, next.trafficDensity) / 20) * profile.trafficWeight;
    const riskFactor = 1 + Math.max(0, next.riskLevel) * 2 * profile.riskWeight;
    const altitudePenalty = Math.abs(centerAltitude(next) - UAV_PROFILE.preferredCruiseAlt) * 0.015 * profile.altitudeWeight;
    const angle = turnAngleDeg(prev, curr, next);
    const turnPenalty = (angle / 90) * UAV_PROFILE.turnPenaltyM * profile.turnWeight;
    return baseDistance * flyWeight * trafficFactor * riskFactor + altitudePenalty + turnPenalty;
}

// 六邻域时空搜索。A* 使用欧氏距离启发式，Dijkstra 基线把启发式置零。
function astar(startGrid, endGrid, rows, options = {}) {
    const gridMap = new Map();
    for (const row of rows) {
        gridMap.set(keyOfGrid(row), row);
    }
    const axisLookup = buildAxisLookup(rows);
    const terrain = options.terrainProfile || normalizeTerrainProfile(options);

    if (!gridMap.has(keyOfGrid(startGrid)) || !gridMap.has(keyOfGrid(endGrid))) {
        return { path: null, searched: 0, gridMap, terrain };
    }
    if (!isGridTerrainUsable(startGrid, terrain) || !isGridTerrainUsable(endGrid, terrain)) {
        return { path: null, searched: 0, gridMap, terrain };
    }

    const startKey = keyOfGrid(startGrid);
    const endKey = keyOfGrid(endGrid);
    const startStateKey = searchStateKey(startKey);
    const open = new MinHeap();
    const cameFrom = new Map();
    const stateGridKey = new Map([[startStateKey, startKey]]);
    const gScore = new Map([[startStateKey, 0]]);
    const timeScore = new Map([[startStateKey, 0]]);
    const closed = new Set();
    const maxIterations = Math.max(2000, rows.length * UAV_PROFILE.maxIterationsFactor);
    const departureMs = parseDepartureTime(options.departureTime);
    const baselineDijkstra = isBaselineDijkstra(options);
    const algorithm = baselineDijkstra ? 'baseline-dijkstra' : 'weighted-a-star';

    open.push({ stateKey: startStateKey, key: startKey, prevKey: null, f: 0 });
    let searched = 0;

    while (open.length > 0 && searched < maxIterations) {
        const item = open.pop();
        if (!item || closed.has(item.stateKey)) continue;
        searched += 1;
        const { stateKey: currentStateKey, key: currentKey, prevKey: incomingPrevKey } = item;
        closed.add(currentStateKey);

        if (currentKey === endKey) {
            const statePath = [currentStateKey];
            let temp = currentStateKey;
            while (cameFrom.has(temp)) {
                temp = cameFrom.get(temp);
                statePath.push(temp);
            }
            statePath.reverse();
            const pathKeys = statePath.map((state) => stateGridKey.get(state) || currentKeyFromState(state));
            const pathTimeScore = new Map();
            statePath.forEach((state, index) => {
                pathTimeScore.set(pathKeys[index], timeScore.get(state) || 0);
            });
            return {
                path: pathKeys.map((key) => gridMap.get(key)),
                searched,
                gridMap,
                gScore,
                timeScore: pathTimeScore,
                departureMs,
                terrain,
                algorithm,
            };
        }

        const curr = gridMap.get(currentKey);
        for (const direction of NEIGHBOR_DIRECTIONS) {
            const nextKey = neighborKey(curr, direction, axisLookup);
            if (!nextKey) continue;
            if (!gridMap.has(nextKey)) continue;

            const next = gridMap.get(nextKey);
            if (violatesFlightEnvelope(curr, next)) continue;
            if (!isGridTerrainUsable(next, terrain)) continue;

            const prev = incomingPrevKey ? gridMap.get(incomingPrevKey) : null;
            const angle = turnAngleDeg(prev, curr, next);
            if (angle > UAV_PROFILE.maxTurnDeg) continue;

            const nextStateKey = searchStateKey(nextKey, currentKey);
            if (closed.has(nextStateKey)) continue;

            const tentativeTime = (timeScore.get(currentStateKey) ?? 0) + segmentSeconds(curr, next);
            if (!isGridUsableAt(next, departureMs + tentativeTime * 1000)) continue;
            if (!passesCornerGuard(curr, direction, gridMap, axisLookup, departureMs + tentativeTime * 1000)) continue;

            const tentativeG = (gScore.get(currentStateKey) ?? Infinity) + movementCost(curr, next, prev, options);
            if (tentativeG >= (gScore.get(nextStateKey) ?? Infinity)) continue;

            cameFrom.set(nextStateKey, currentStateKey);
            stateGridKey.set(nextStateKey, nextKey);
            gScore.set(nextStateKey, tentativeG);
            timeScore.set(nextStateKey, tentativeTime);
            const heuristic = baselineDijkstra ? 0 : distance3D(gridCenterPoint(next), gridCenterPoint(endGrid));
            open.push({ stateKey: nextStateKey, key: nextKey, prevKey: currentKey, f: tentativeG + heuristic });
        }
    }

    return { path: null, searched, gridMap, gScore, timeScore, departureMs, terrain, algorithm };
}

// 线段可视性检查会沿航段采样，逐点验证网格状态、时间窗和地形净空。
function hasPointLineOfSight(start, end, gridMap, spec, options = {}) {
    const resolution = estimateResolutionMeters(spec.geosotLevel, (start.lat + end.lat) / 2);
    const distance = distance3D(start, end);
    const samples = Math.max(2, Math.ceil(distance / Math.max(0.5, resolution.nominalMeters * 0.08)));
    const segmentDuration = waypointSegmentSeconds(start, end);
    const departureMs = options.departureMs || Date.now();
    const startElapsed = options.startElapsed || 0;
    const terrain = options.terrainProfile || normalizeTerrainProfile(options);
    let previousSample = null;

    /**
     * 封装usable cell相关逻辑，保持调用处简洁并便于后续维护。
     */
    function usableCell(x, y, z, timeMs) {
        const grid = gridMap.get(gridKey(x, y, z));
        return grid && isGridUsableAt(grid, timeMs) && isGridTerrainUsable(grid, terrain);
    }

    for (let i = 0; i <= samples; i += 1) {
        const t = i / samples;
        const lon = start.lon + (end.lon - start.lon) * t;
        const lat = start.lat + (end.lat - start.lat) * t;
        const alt = start.alt + (end.alt - start.alt) * t;
        if (!isPointTerrainSafe({ lon, lat, alt }, terrain)) return false;
        const cell = cellFromLonLat(lon, lat, spec.geosotLevel);
        const z = altitudeToLayer(alt, spec);
        const sampleGrid = gridMap.get(gridKey(cell.x, cell.y, z));
        if (!sampleGrid) return false;
        if (!isGridUsableAt(sampleGrid, departureMs + (startElapsed + segmentDuration * t) * 1000)) {
            return false;
        }
        const timeMs = departureMs + (startElapsed + segmentDuration * t) * 1000;
        if (previousSample
            && previousSample.z === z
            && previousSample.x !== cell.x
            && previousSample.y !== cell.y) {
            const bridgeA = usableCell(cell.x, previousSample.y, z, timeMs);
            const bridgeB = usableCell(previousSample.x, cell.y, z, timeMs);
            if (!bridgeA && !bridgeB) return false;
        }
        previousSample = { x: cell.x, y: cell.y, z };
    }

    return true;
}

/**
 * 判断has line of sight条件是否成立，供上层流程决定是否继续执行。
 */
function hasLineOfSight(a, b, gridMap, spec, options = {}) {
    return hasPointLineOfSight(gridCenterPoint(a), gridCenterPoint(b), gridMap, spec, options);
}

/**
 * 封装point at ratio相关逻辑，保持调用处简洁并便于后续维护。
 */
function pointAtRatio(start, end, t) {
    return {
        lon: start.lon + (end.lon - start.lon) * t,
        lat: start.lat + (end.lat - start.lat) * t,
        alt: start.alt + (end.alt - start.alt) * t,
    };
}

/**
 * 封装clamp01相关逻辑，保持调用处简洁并便于后续维护。
 */
function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

/**
 * 在搜索结果上做可通视压缩，减少不必要折点，同时保持路径不穿越受限网格。
 */
function smoothGridPath(path, gridMap, spec, timeScore, departureMs, terrain) {
    if (!path || path.length <= 2) return path || [];
    const result = [path[0]];
    let currentIndex = 0;

    while (currentIndex < path.length - 1) {
        let nextIndex = currentIndex + 1;
        for (let candidate = path.length - 1; candidate > currentIndex + 1; candidate -= 1) {
            if (hasLineOfSight(path[currentIndex], path[candidate], gridMap, spec, {
                departureMs,
                startElapsed: timeScore?.get(keyOfGrid(path[currentIndex])) || 0,
                terrainProfile: terrain,
            })) {
                nextIndex = candidate;
                break;
            }
        }
        result.push(path[nextIndex]);
        currentIndex = nextIndex;
    }

    return result;
}

/**
 * 封装append waypoint相关逻辑，保持调用处简洁并便于后续维护。
 */
function appendWaypoint(target, point) {
    const last = target[target.length - 1];
    if (last && distance3D(last, point) < 0.2) return;
    target.push(point);
}

/**
 * 构建build waypoint candidates所需的数据结构，供后续查询、渲染或路径计算复用。
 */
function buildWaypointCandidates(start, end, gridPath, includeTerminalGridCenters = false) {
    if (!gridPath || gridPath.length === 0) return [start, end];
    const candidates = [];
    appendWaypoint(candidates, start);
    for (let index = 0; index < gridPath.length; index += 1) {
        if (!includeTerminalGridCenters && (index === 0 || index === gridPath.length - 1)) continue;
        const grid = gridPath[index];
        appendWaypoint(candidates, gridCenterPoint(grid));
    }
    appendWaypoint(candidates, end);
    return candidates;
}

/**
 * 封装shortcut waypoints相关逻辑，保持调用处简洁并便于后续维护。
 */
function shortcutWaypoints(candidates, gridMap, spec, departureMs, terrain) {
    if (!gridMap || !spec) return candidates;
    const waypoints = [candidates[0]];
    let currentIndex = 0;
    let elapsed = 0;

    while (currentIndex < candidates.length - 1) {
        let nextIndex = null;
        for (let candidate = candidates.length - 1; candidate > currentIndex; candidate -= 1) {
            const previous = waypoints.length > 1 ? waypoints[waypoints.length - 2] : null;
            const current = waypoints[waypoints.length - 1];
            const next = candidates[candidate];
            if (previous && turnAngleBetweenPoints(previous, current, next) > UAV_PROFILE.maxTurnDeg) {
                continue;
            }
            if (hasPointLineOfSight(candidates[currentIndex], candidates[candidate], gridMap, spec, {
                departureMs,
                startElapsed: elapsed,
                terrainProfile: terrain,
            })) {
                nextIndex = candidate;
                break;
            }
        }
        if (nextIndex == null) return null;

        const next = candidates[nextIndex];
        appendWaypoint(waypoints, next);
        elapsed += waypointSegmentSeconds(candidates[currentIndex], next);
        currentIndex = nextIndex;
    }

    return dedupeCollinearWaypoints(waypoints);
}

/**
 * 构建build waypoints所需的数据结构，供后续查询、渲染或路径计算复用。
 */
function buildWaypoints(start, end, gridPath, gridMap, spec, departureMs, terrain) {
    const sparseCandidates = buildWaypointCandidates(start, end, gridPath, false);
    const sparseWaypoints = shortcutWaypoints(sparseCandidates, gridMap, spec, departureMs, terrain);
    if (sparseWaypoints) return sparseWaypoints;

    const fullCandidates = buildWaypointCandidates(start, end, gridPath, true);
    return shortcutWaypoints(fullCandidates, gridMap, spec, departureMs, terrain) || fullCandidates;
}

/**
 * 封装quadratic bezier point相关逻辑，保持调用处简洁并便于后续维护。
 */
function quadraticBezierPoint(start, control, end, t) {
    const oneMinusT = 1 - t;
    return {
        lon: oneMinusT * oneMinusT * start.lon + 2 * oneMinusT * t * control.lon + t * t * end.lon,
        lat: oneMinusT * oneMinusT * start.lat + 2 * oneMinusT * t * control.lat + t * t * end.lat,
        alt: oneMinusT * oneMinusT * start.alt + 2 * oneMinusT * t * control.alt + t * t * end.alt,
    };
}

/**
 * 判断is waypoint path valid条件是否成立，供上层流程决定是否继续执行。
 */
function isWaypointPathValid(waypoints, gridMap, spec, departureMs, terrain, options = {}) {
    if (!Array.isArray(waypoints) || waypoints.length < 2) return false;
    let elapsed = options.startElapsed || 0;

    for (let i = 1; i < waypoints.length; i += 1) {
        const prev = waypoints[i - 1];
        const next = waypoints[i];
        if (!hasPointLineOfSight(prev, next, gridMap, spec, {
            departureMs,
            startElapsed: elapsed,
            terrainProfile: terrain,
        })) {
            return false;
        }
        elapsed += waypointSegmentSeconds(prev, next);
    }

    if (options.enforceTurnLimit !== false) {
        for (let i = 1; i < waypoints.length - 1; i += 1) {
            if (turnAngleBetweenPoints(waypoints[i - 1], waypoints[i], waypoints[i + 1]) > UAV_PROFILE.maxTurnDeg) {
                return false;
            }
        }
    }

    return true;
}

/**
 * 封装smooth waypoint corners相关逻辑，保持调用处简洁并便于后续维护。
 */
function smoothWaypointCorners(waypoints, gridMap, spec, departureMs, terrain) {
    if (!Array.isArray(waypoints) || waypoints.length <= 2) return waypoints || [];
    const result = [waypoints[0]];

    for (let i = 1; i < waypoints.length - 1; i += 1) {
        const prev = waypoints[i - 1];
        const curr = waypoints[i];
        const next = waypoints[i + 1];
        const turnAngle = turnAngleBetweenPoints(prev, curr, next);
        const inLength = distance3D(prev, curr);
        const outLength = distance3D(curr, next);

        if (turnAngle < 8 || inLength < 3 || outLength < 3) {
            appendWaypoint(result, curr);
            continue;
        }

        const cutDistance = Math.min(
            UAV_PROFILE.turnRadiusM * 1.6,
            inLength * 0.35,
            outLength * 0.35,
        );
        if (cutDistance < 1) {
            appendWaypoint(result, curr);
            continue;
        }

        const entry = pointAtRatio(prev, curr, clamp01(1 - cutDistance / inLength));
        const exit = pointAtRatio(curr, next, clamp01(cutDistance / outLength));
        const curveSamples = Math.max(3, Math.min(10, Math.ceil(turnAngle / 15)));
        const candidate = [entry];
        for (let sample = 1; sample < curveSamples; sample += 1) {
            candidate.push(quadraticBezierPoint(entry, curr, exit, sample / curveSamples));
        }
        candidate.push(exit);

        const testPath = [result[result.length - 1], ...candidate, next];
        if (!isWaypointPathValid(testPath, gridMap, spec, departureMs, terrain, { enforceTurnLimit: true })) {
            appendWaypoint(result, curr);
            continue;
        }

        for (const point of candidate) {
            appendWaypoint(result, point);
        }
    }

    appendWaypoint(result, waypoints[waypoints.length - 1]);
    return result;
}

// 网格搜索先给出安全走廊，再用可视性检查和圆角采样生成更接近真实飞行的航点。
// 平滑后的航线经过哪些网格，会在 collectCorridorGrids 中重新补齐，避免航线超出显示走廊。
function buildIndustrialRoute(start, end, gridPath, gridMap, spec, departureMs, terrain) {
    const hasTimedControlNearby = Array.from(gridMap?.values?.() || [])
        .some((grid) => grid?.controlStartAt && grid?.controlEndAt);
    const fallbackWaypoints = dedupeCollinearWaypoints(buildWaypointCandidates(start, end, gridPath, true));
    let waypoints = fallbackWaypoints;
    let planningMode = waypoints.length <= 2 ? '正交通道航线' : '正交绕行航线';

    const shortcut = buildWaypoints(start, end, gridPath, gridMap, spec, departureMs, terrain);
    const shortcutWaypoints = isWaypointPathValid(shortcut, gridMap, spec, departureMs, terrain)
        ? dedupeCollinearWaypoints(shortcut)
        : fallbackWaypoints;
    const rounded = smoothWaypointCorners(shortcutWaypoints, gridMap, spec, departureMs, terrain);
    waypoints = isWaypointPathValid(rounded, gridMap, spec, departureMs, terrain)
        ? rounded
        : shortcutWaypoints;
    planningMode = waypoints.length <= 2 ? '直线可视航线' : '平滑最短航线';
    if (hasTimedControlNearby) {
        planningMode = waypoints.length <= 2 ? '管控区斜向连续走廊航线' : '管控区平滑连续走廊航线';
    }

    const corridor = collectCorridorGrids(waypoints, gridMap, spec, departureMs, terrain);

    return {
        waypoints,
        corridor: corridor.length > 0 ? corridor : gridPath,
        rawGridCount: gridPath.length,
        planningMode,
    };
}

/**
 * 封装dedupe collinear waypoints相关逻辑，保持调用处简洁并便于后续维护。
 */
function dedupeCollinearWaypoints(waypoints) {
    if (!waypoints || waypoints.length <= 2) return waypoints || [];
    const result = [waypoints[0]];

    for (let i = 1; i < waypoints.length - 1; i += 1) {
        const prev = result[result.length - 1];
        const curr = waypoints[i];
        const next = waypoints[i + 1];
        const a = vectorMeters(prev, curr);
        const b = vectorMeters(curr, next);
        const cross = Math.sqrt(
            ((a.y * b.z) - (a.z * b.y)) ** 2
            + ((a.z * b.x) - (a.x * b.z)) ** 2
            + ((a.x * b.y) - (a.y * b.x)) ** 2,
        );
        const scale = Math.max(1, distance3D(prev, curr) * distance3D(curr, next));
        if (cross / scale > 0.015) {
            result.push(curr);
        }
    }

    appendWaypoint(result, waypoints[waypoints.length - 1]);
    return result;
}

/**
 * 判断is diagonal horizontal segment条件是否成立，供上层流程决定是否继续执行。
 */
function isDiagonalHorizontalSegment(start, end) {
    const vector = vectorMeters(start, end);
    return Math.abs(vector.x) > 0.05 && Math.abs(vector.y) > 0.05;
}

/**
 * 封装orthogonalize diagonal segments相关逻辑，保持调用处简洁并便于后续维护。
 */
function orthogonalizeDiagonalSegments(waypoints) {
    if (!Array.isArray(waypoints) || waypoints.length <= 1) return waypoints || [];
    const result = [waypoints[0]];

    for (let i = 1; i < waypoints.length; i += 1) {
        const prev = result[result.length - 1];
        const next = waypoints[i];
        if (isDiagonalHorizontalSegment(prev, next)) {
            appendWaypoint(result, {
                lon: prev.lon,
                lat: next.lat,
                alt: Math.max(prev.alt || 0, next.alt || 0),
            });
        }
        appendWaypoint(result, next);
    }

    return dedupeCollinearWaypoints(result);
}

// 最终走廊不只包含 A* 原始路径，还会把平滑线段经过的网格补齐给前端展示。
function collectCorridorGrids(waypoints, gridMap, spec, departureMs, terrain) {
    const corridor = [];
    const seen = new Set();
    let elapsed = 0;

    /**
     * 维护add grid集合，保证场景实体和业务状态同步。
     */
    function addGrid(grid) {
        if (!grid) return;
        const key = keyOfGrid(grid);
        if (seen.has(key)) return;
        seen.add(key);
        corridor.push(grid);
    }

    /**
     * 维护add usable cell集合，保证场景实体和业务状态同步。
     */
    function addUsableCell(x, y, z, timeMs) {
        const grid = gridMap.get(gridKey(x, y, z));
        if (grid && isGridUsableAt(grid, timeMs) && isGridTerrainUsable(grid, terrain)) {
            addGrid(grid);
        }
    }

    for (let i = 1; i < waypoints.length; i += 1) {
        const start = waypoints[i - 1];
        const end = waypoints[i];
        const distance = distance3D(start, end);
        const resolution = estimateResolutionMeters(spec.geosotLevel, (start.lat + end.lat) / 2);
        const samples = Math.max(2, Math.ceil(distance / Math.max(0.5, resolution.nominalMeters * 0.05)));
        const duration = waypointSegmentSeconds(start, end);
        let previousSample = null;

        for (let s = 0; s <= samples; s += 1) {
            const t = s / samples;
            const point = pointAtRatio(start, end, t);
            if (!isPointTerrainSafe(point, terrain)) continue;
            const cell = cellFromLonLat(point.lon, point.lat, spec.geosotLevel);
            const z = altitudeToLayer(point.alt, spec);
            const timeMs = departureMs + (elapsed + duration * t) * 1000;
            const grid = gridMap.get(gridKey(cell.x, cell.y, z));
            if (previousSample
                && previousSample.z === z
                && previousSample.x !== cell.x
                && previousSample.y !== cell.y) {
                addUsableCell(cell.x, previousSample.y, z, timeMs);
                addUsableCell(previousSample.x, cell.y, z, timeMs);
            }
            if (grid && isGridUsableAt(grid, timeMs) && isGridTerrainUsable(grid, terrain)) {
                addGrid(grid);
            }
            previousSample = { x: cell.x, y: cell.y, z };
        }

        elapsed += duration;
    }

    return corridor;
}

/**
 * 构建build corridor timeline所需的数据结构，供后续查询、渲染或路径计算复用。
 */
function buildCorridorTimeline(path, departureMs) {
    let elapsed = 0;
    return (path || []).map((grid, index) => {
        if (index > 0) elapsed += segmentSeconds(path[index - 1], grid);
        return {
            geosot_id: grid.geosotId,
            grid_level: grid.gridLevel,
            eta: new Date(departureMs + elapsed * 1000).toISOString(),
            elapsed_seconds: elapsed,
            lon: grid.lon,
            lat: grid.lat,
            alt: centerAltitude(grid),
            risk_level: grid.riskLevel,
            surface_type: grid.surfaceType,
            surface_weight: grid.surfaceWeight,
            fly_weight: grid.flyWeight,
            traffic_density: grid.trafficDensity,
        };
    });
}

/**
 * 构建build route timeline所需的数据结构，供后续查询、渲染或路径计算复用。
 */
function buildRouteTimeline(path, timeScore, departureMs) {
    return (path || []).map((grid) => {
        const seconds = timeScore?.get(keyOfGrid(grid)) || 0;
        return {
            geosot_id: grid.geosotId,
            grid_level: grid.gridLevel,
            eta: new Date(departureMs + seconds * 1000).toISOString(),
            elapsed_seconds: seconds,
            lon: grid.lon,
            lat: grid.lat,
            alt: centerAltitude(grid),
            risk_level: grid.riskLevel,
            surface_type: grid.surfaceType,
            surface_weight: grid.surfaceWeight,
            fly_weight: grid.flyWeight,
            traffic_density: grid.trafficDensity,
        };
    });
}

/**
 * 从路径经过网格中汇总风险指标，用于方案对比和论文实验结果说明。
 */
function calculateRiskSummary(path, distance) {
    if (!path || path.length === 0) {
        return {
            score: 0,
            level: '低',
            maxRisk: 0,
            averageRisk: 0,
            highRiskCells: 0,
        };
    }

    const riskValues = path.map((grid) => {
        const statusRisk = grid.currentStatus === 0 ? 0 : 1;
        const weightRisk = Math.max(0, grid.flyWeight - 1) / 19;
        const trafficRisk = Math.max(0, grid.trafficDensity) / 20;
        return Math.min(1, Math.max(statusRisk, grid.riskLevel, weightRisk, trafficRisk));
    });
    const averageRisk = riskValues.reduce((sum, value) => sum + value, 0) / riskValues.length;
    const maxRisk = Math.max(...riskValues);
    const distanceFactor = Math.min(1, distance / 10000);
    const score = Math.round(Math.min(100, averageRisk * 70 + maxRisk * 25 + distanceFactor * 5));

    return {
        score,
        level: score >= 70 ? '高' : (score >= 35 ? '中' : '低'),
        maxRisk: Number(maxRisk.toFixed(3)),
        averageRisk: Number(averageRisk.toFixed(3)),
        highRiskCells: riskValues.filter((value) => value >= 0.6).length,
    };
}

/**
 * 封装max vertical rate相关逻辑，保持调用处简洁并便于后续维护。
 */
function maxVerticalRate(waypoints) {
    let maxRate = 0;
    for (let i = 1; i < waypoints.length; i += 1) {
        const prev = waypoints[i - 1];
        const next = waypoints[i];
        const seconds = waypointSegmentSeconds(prev, next);
        maxRate = Math.max(maxRate, Math.abs(next.alt - prev.alt) / seconds);
    }
    return maxRate;
}

/**
 * 封装waypoint segment seconds相关逻辑，保持调用处简洁并便于后续维护。
 */
function waypointSegmentSeconds(prev, next) {
    const horizontal = distance3D({ ...prev, alt: 0 }, { ...next, alt: 0 });
    const vertical = next.alt - prev.alt;
    const horizontalSeconds = horizontal / UAV_PROFILE.cruiseSpeedMps;
    const verticalSeconds = Math.abs(vertical) / (vertical >= 0 ? UAV_PROFILE.climbRateMps : UAV_PROFILE.descendRateMps);
    return Math.max(horizontalSeconds, verticalSeconds, 0.1);
}

/**
 * 计算estimate flight seconds指标，用于路径评价、界面显示或约束判断。
 */
function estimateFlightSeconds(waypoints) {
    let seconds = 0;
    for (let i = 1; i < waypoints.length; i += 1) {
        seconds += waypointSegmentSeconds(waypoints[i - 1], waypoints[i]);
    }
    return seconds;
}

/**
 * 封装path distance相关逻辑，保持调用处简洁并便于后续维护。
 */
function pathDistance(waypoints) {
    let total = 0;
    for (let i = 1; i < waypoints.length; i += 1) {
        total += distance3D(waypoints[i - 1], waypoints[i]);
    }
    return total;
}

/**
 * 把数据库网格记录转换为GeoJSON要素，供Cesium直接渲染。
 */
function featureFromGrid(grid, sequence = null) {
    return {
        type: 'Feature',
        geometry: JSON.parse(grid.geometryText),
        properties: {
            id: grid.id,
            geosot_id: grid.geosotId,
            geosot_code: grid.geosotCode,
            geosot_level: grid.geosotLevel,
            grid_level: grid.gridLevel,
            bottom: grid.bottom,
            top: grid.top,
            status: grid.currentStatus,
            surface_type: grid.surfaceType,
            surface_weight: grid.surfaceWeight,
            fly_weight: grid.flyWeight,
            traffic_density: grid.trafficDensity,
            risk_level: grid.riskLevel,
            route_grid: sequence !== null,
            route_sequence: sequence,
        },
    };
}

/**
 * 封装feature from display cell相关逻辑，保持调用处简洁并便于后续维护。
 */
function featureFromDisplayCell(spec, lonCell, latCell, layer) {
    const altitude = altitudeLayerRange(layer, spec);
    const geosotCode = encodeSurface(lonCell.center, latCell.center, spec.geosotLevel);
    return {
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [lonCell.lower, latCell.lower],
                [lonCell.lower, latCell.upper],
                [lonCell.upper, latCell.upper],
                [lonCell.upper, latCell.lower],
                [lonCell.lower, latCell.lower],
            ]],
        },
        properties: {
            id: `${spec.key}-${lonCell.prefix}-${latCell.prefix}-Z${layer}`,
            geosot_id: make3DCode(geosotCode, layer),
            geosot_code: geosotCode,
            geosot_level: spec.geosotLevel,
            grid_level: spec.key,
            bottom: altitude.bottom,
            top: altitude.top,
            status: 0,
            effective_status: 0,
            fly_weight: 1,
            traffic_density: 0,
            weather_limit: false,
            control_start_at: null,
            control_end_at: null,
            risk_level: 0,
            synthetic: true,
        },
    };
}

/**
 * 为非数据库层级生成临时显示网格，保证前端不同视角下仍可快速查看层级剖分。
 */
function syntheticDisplayGridCollection(west, south, east, north, spec, maxVisibleAltitude, options = {}) {
    const minLon = Math.max(Number(west), spec.bounds.minLon);
    const minLat = Math.max(Number(south), spec.bounds.minLat);
    const maxLon = Math.min(Number(east), spec.bounds.maxLon);
    const maxLat = Math.min(Number(north), spec.bounds.maxLat);
    if (minLon >= maxLon || minLat >= maxLat) {
        return { type: 'FeatureCollection', features: [], metadata: { synthetic: true, truncated: false } };
    }

    const lonCells = dmsAlignedAxisCells(minLon, maxLon, spec.geosotLevel);
    const latCells = dmsAlignedAxisCells(minLat, maxLat, spec.geosotLevel);
    const layerCount = Math.max(
        1,
        Math.ceil(Math.min(maxVisibleAltitude, spec.maxAltitude) / spec.verticalStep),
    );
    const displayLimit = parseDisplayLimit(options.limit);
    const displayLayer = Number.isInteger(options.displayLayer)
        ? Math.max(0, Math.min(layerCount - 1, options.displayLayer))
        : null;
    const layers = displayLayer === null
        ? Array.from({ length: layerCount }, (_, index) => index)
        : [displayLayer];
    const features = [];
    let truncated = false;

    for (const z of layers) {
        for (const lonCell of lonCells) {
            for (const latCell of latCells) {
                if (features.length >= displayLimit) {
                    truncated = true;
                    break;
                }
                features.push(featureFromDisplayCell(spec, lonCell, latCell, z));
            }
            if (truncated) break;
        }
        if (truncated) break;
    }

    return {
        type: 'FeatureCollection',
        features,
        metadata: {
            synthetic: true,
            truncated,
            returned: features.length,
            display_layer: displayLayer,
            total_estimate: lonCells.length * latCells.length * layers.length,
        },
    };
}

/**
 * 封装grid corridor summary相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridCorridorSummary(path) {
    const byLevel = {};
    for (const grid of path || []) {
        byLevel[grid.gridLevel] = (byLevel[grid.gridLevel] || 0) + 1;
    }
    return {
        count: path?.length || 0,
        by_level: byLevel,
    };
}

// 单航段规划接口的核心实现：取起终点网格、加载候选网格、搜索、后处理并返回 GeoJSON。
async function planSegment(startRaw, endRaw, levelRaw, options = {}) {
    const start = validatePoint(startRaw, 'start');
    const end = validatePoint(endRaw, 'end');
    const levelKey = normalizeLevelKey(levelRaw);
    const spec = getLevelSpec(levelKey);
    const terrainProfile = normalizeTerrainProfile(options);
    const planningOptions = { ...options, terrainProfile };

    if (start.alt < 0 || end.alt < 0 || start.alt >= spec.maxAltitude || end.alt >= spec.maxAltitude) {
        const error = new Error(`${spec.displayName} 的飞行高度必须满足 0 <= 高度 < ${spec.maxAltitude} 米`);
        error.statusCode = 400;
        throw error;
    }
    if (!isPointTerrainSafe(start, terrainProfile) || !isPointTerrainSafe(end, terrainProfile)) {
        const error = new Error(`起点或终点高度低于地形安全净空 ${terrainProfile.minClearanceM} 米`);
        error.statusCode = 409;
        throw error;
    }

    const startGrid = await getGridByCoords(start.lon, start.lat, start.alt, levelKey);
    const endGrid = await getGridByCoords(end.lon, end.lat, end.alt, levelKey);

    if (!startGrid || !endGrid) {
        const missing = [
            !startGrid ? '起点' : null,
            !endGrid ? '终点' : null,
        ].filter(Boolean).join('和');
        const error = new Error(`${missing}不在${spec.displayName}已入库网格覆盖范围内`);
        error.statusCode = 404;
        throw error;
    }

    const departureMs = parseDepartureTime(options.departureTime);
    if (!isGridUsableAt(startGrid, departureMs) || !isGridUsableAt(endGrid, departureMs)) {
        const error = new Error('起点或终点所在网格当前受限，不能作为可飞空域');
        error.statusCode = 409;
        throw error;
    }
    if (!isGridTerrainUsable(startGrid, terrainProfile) || !isGridTerrainUsable(endGrid, terrainProfile)) {
        const error = new Error(`起点或终点所在网格低于地形安全净空 ${terrainProfile.minClearanceM} 米`);
        error.statusCode = 409;
        throw error;
    }

    if (keyOfGrid(startGrid) === keyOfGrid(endGrid)) {
        const waypoints = [start, end];
        const singleGridMap = new Map([[keyOfGrid(startGrid), startGrid]]);
        const singleGridOccupancy = await attachOccupancyWindows(
            [startGrid],
            levelKey,
            departureMs,
            Math.max(30, estimateFlightSeconds(waypoints) + 30),
            planningOptions,
        );
        if (shouldAvoidOccupancy(planningOptions) && isGridOccupiedAt(startGrid, departureMs)) {
            const error = new Error('起点所在网格在计划起飞时段已被其他航线占用');
            error.statusCode = 409;
            throw error;
        }
        if (!hasPointLineOfSight(start, end, singleGridMap, spec, {
            departureMs,
            terrainProfile,
        })) {
            const error = new Error('起点和终点虽位于同一网格，但线段未满足时空或地形约束');
            error.statusCode = 409;
            throw error;
        }
        const distance = pathDistance(waypoints);
        const risk = calculateRiskSummary([startGrid], distance);
        return {
            type: 'FeatureCollection',
            features: [featureFromGrid(startGrid, 0)],
            route: {
                waypoints,
                timeline: buildRouteTimeline([startGrid], new Map([[keyOfGrid(startGrid), 0]]), departureMs),
            },
            metadata: {
                status: 'success',
                level: spec.key,
                geosot_level: spec.geosotLevel,
                objective: options.objective || 'balanced',
                algorithm: isBaselineDijkstra(options) ? 'baseline-dijkstra' : 'weighted-a-star',
                departure_time: new Date(departureMs).toISOString(),
                searched_grids: 1,
                total_grids: 1,
                smoothed_waypoints: waypoints.length,
                distance_m: distance,
                estimated_seconds: estimateFlightSeconds(waypoints),
                turn_radius_m: UAV_PROFILE.turnRadiusM,
                max_vertical_rate_mps: maxVerticalRate(waypoints),
                grid_corridor: gridCorridorSummary([startGrid]),
                terrain_clearance: terrainMetadata(terrainProfile),
                occupancy: singleGridOccupancy,
                risk,
            },
        };
    }

    const rows = await fetchPlanningRows(start, end, levelKey, startGrid, endGrid);
    const occupancySummary = await attachOccupancyWindows(
        rows,
        levelKey,
        departureMs,
        estimatePlanningHorizonSeconds(start, end, planningOptions),
        planningOptions,
    );
    const searchStartGrid = copyOccupancyFromRows(startGrid, rows);
    const searchEndGrid = copyOccupancyFromRows(endGrid, rows);
    if (shouldAvoidOccupancy(planningOptions) && isGridOccupiedAt(searchStartGrid, departureMs)) {
        const error = new Error('起点所在网格在计划起飞时段已被其他航线占用');
        error.statusCode = 409;
        throw error;
    }

    const plan = astar(searchStartGrid, searchEndGrid, rows, planningOptions);

    if (!plan.path || plan.path.length === 0) {
        const error = new Error('当前空域状态下未找到满足约束的可飞航线');
        error.statusCode = 404;
        throw error;
    }

    const routeGridPath = plan.path;
    const industrialRoute = buildIndustrialRoute(
        start,
        end,
        routeGridPath,
        plan.gridMap,
        spec,
        plan.departureMs,
        terrainProfile,
    );
    const corridorPath = industrialRoute.corridor;
    const waypoints = industrialRoute.waypoints;
    const distance = pathDistance(waypoints);
    const risk = calculateRiskSummary(corridorPath, distance);

    return {
        type: 'FeatureCollection',
        features: corridorPath.map((grid, index) => featureFromGrid(grid, index)),
        route: {
            waypoints,
            timeline: buildCorridorTimeline(corridorPath, plan.departureMs),
        },
        metadata: {
            status: 'success',
            level: spec.key,
            geosot_level: spec.geosotLevel,
            objective: options.objective || 'balanced',
            algorithm: plan.algorithm || (isBaselineDijkstra(options) ? 'baseline-dijkstra' : 'weighted-a-star'),
            planning_mode: industrialRoute.planningMode,
            departure_time: new Date(plan.departureMs).toISOString(),
            searched_grids: plan.searched,
            total_grids: corridorPath.length,
            raw_grid_path_count: industrialRoute.rawGridCount,
            smoothed_waypoints: waypoints.length,
            distance_m: distance,
            estimated_seconds: estimateFlightSeconds(waypoints),
            turn_radius_m: UAV_PROFILE.turnRadiusM,
            max_vertical_rate_mps: maxVerticalRate(waypoints),
            grid_corridor: gridCorridorSummary(corridorPath),
            terrain_clearance: terrainMetadata(terrainProfile),
            occupancy: occupancySummary,
            risk,
        },
    };
}

// -----------------------------
// HTTP API
// -----------------------------

// 返回前端可选的 GeoSOT 层级、理论边长和三维显示层数。
app.get('/api/levels', (req, res) => {
    const levels = buildLevelMetadata()
        .filter((level) => Number(level.geosotLevel || 0) >= MIN_OPERATIONAL_GEOSOT_LEVEL)
        .map((level) => ({
            ...level,
            databaseBacked: DATABASE_DISPLAY_LEVELS.has(level.key),
            planningAvailable: DATABASE_DISPLAY_LEVELS.has(level.key),
        }));
    res.json({ levels, uav_profile: UAV_PROFILE });
});

// 按当前视野裁剪建筑障碍物，减少前端一次性加载的白模数据量。
app.get('/api/obstacles', (req, res) => {
    try {
        const data = loadObstacleGeojson();
        const bounds = queryBounds(req.query);
        if (!bounds) {
            return res.json(data);
        }

        return res.json({
            ...data,
            features: data.features.filter((feature) => {
                const [west, south, east, north] = feature.bbox || [];
                return boundsIntersect(bounds, { west, south, east, north });
            }),
        });
    } catch (error) {
        console.error('障碍物数据读取失败:', error);
        res.status(500).json({ message: '障碍物数据读取失败' });
    }
});

// 读取停机坪列表，前端用这些点作为起终点快捷选择和属性查看对象。
app.get('/api/helipads', async (req, res) => {
    try {
        await ensureHelipadSchema();
        const result = await pool.query(`
            SELECT id, helipad_code, name, lon, lat, alt, status, notes, created_at, updated_at
            FROM helipads
            WHERE status <> 'deleted'
            ORDER BY id ASC;
        `);
        res.json({ helipads: result.rows.map(normalizeHelipadRow) });
    } catch (error) {
        console.error('停机坪列表读取失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '停机坪列表读取失败') });
    }
});

// 新增一个停机坪点位，保存经纬度、高程和备注信息。
app.post('/api/helipads', async (req, res) => {
    try {
        await ensureHelipadSchema();
        const lon = finiteOrNull(req.body.lon);
        const lat = finiteOrNull(req.body.lat);
        const alt = finiteOrNull(req.body.alt) ?? 30;

        if (lon == null || lat == null || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
            return res.status(400).json({ message: '缺少有效的停机坪经纬度' });
        }

        let code = String(req.body.helipad_code || req.body.code || '').trim().slice(0, 32);
        if (!code) {
            const counter = await pool.query(`
                SELECT COALESCE(MAX(SUBSTRING(helipad_code FROM '^H-([0-9]+)$')::integer), 0) + 1 AS next_code
                FROM helipads
                WHERE helipad_code ~ '^H-[0-9]+$';
            `);
            code = `H-${String(Number(counter.rows[0].next_code || 1)).padStart(2, '0')}`;
        }

        const name = String(req.body.name || `停机坪 ${code}`).trim().slice(0, 120);
        const notes = String(req.body.notes || '').trim().slice(0, 500);
        const result = await pool.query(`
            INSERT INTO helipads (helipad_code, name, lon, lat, alt, notes)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, helipad_code, name, lon, lat, alt, status, notes, created_at, updated_at;
        `, [code, name || `停机坪 ${code}`, lon, lat, alt, notes]);

        res.status(201).json({ helipad: normalizeHelipadRow(result.rows[0]) });
    } catch (error) {
        console.error('停机坪新增失败:', error);
        const status = error?.code === '23505' ? 409 : 500;
        res.status(status).json({ message: clientErrorMessage(error, '停机坪新增失败') });
    }
});

// 软删除停机坪，保留历史记录但不再参与前端展示。
app.delete('/api/helipads/:id', async (req, res) => {
    try {
        await ensureHelipadSchema();
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ message: '缺少有效的停机坪编号' });
        }

        const result = await pool.query(`
            UPDATE helipads
            SET status = 'deleted', updated_at = NOW()
            WHERE id = $1 AND status <> 'deleted'
            RETURNING id, helipad_code, name, lon, lat, alt, status, notes, created_at, updated_at;
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: '未找到该停机坪' });
        }

        res.json({ helipad: normalizeHelipadRow(result.rows[0]) });
    } catch (error) {
        console.error('停机坪删除失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '停机坪删除失败') });
    }
});

// 读取临时管控区列表，并在查询前顺带过期已经结束的管控区。
app.get('/api/control-areas', async (req, res) => {
    try {
        await expireFinishedControlAreas();
        const includeDeleted = req.query.includeDeleted === 'true';
        const result = await pool.query(`
            SELECT id, name, west, south, east, north, start_at, end_at, status,
                   affected_grid_count, notes, created_at, updated_at
            FROM control_areas
            WHERE ($1::boolean OR status <> 'deleted')
            ORDER BY
                CASE
                    WHEN status <> 'deleted' AND start_at <= NOW() AND end_at >= NOW() THEN 0
                    WHEN status <> 'deleted' AND start_at > NOW() THEN 1
                    ELSE 2
                END,
                start_at DESC,
                id DESC;
        `, [includeDeleted]);
        res.json({ controlAreas: result.rows.map(normalizeControlAreaRow) });
    } catch (error) {
        console.error('管控区读取失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '管控区读取失败') });
    }
});

// 保存矩形临时管控区，并把落入范围内的空域网格写入管控时间窗。
app.post('/api/control-areas', async (req, res) => {
    let client;
    try {
        await ensureControlAreaSchema();
        const west = finiteOrNull(req.body.west);
        const south = finiteOrNull(req.body.south);
        const east = finiteOrNull(req.body.east);
        const north = finiteOrNull(req.body.north);
        if (![west, south, east, north].every((value) => Number.isFinite(value))) {
            return res.status(400).json({ message: '缺少有效的矩形范围' });
        }

        const bounds = {
            west: Math.min(west, east),
            east: Math.max(west, east),
            south: Math.min(south, north),
            north: Math.max(south, north),
        };
        if (bounds.west === bounds.east || bounds.south === bounds.north) {
            return res.status(400).json({ message: '管控区范围过小，请重新绘制矩形' });
        }

        const startAt = req.body.startAt || req.body.start_at;
        const endAt = req.body.endAt || req.body.end_at;
        const startMs = new Date(startAt).getTime();
        const endMs = new Date(endAt).getTime();
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
            return res.status(400).json({ message: '管控起止时间无效' });
        }

        const name = String(req.body.name || '').trim().slice(0, 120) || '临时管控区';
        const notes = String(req.body.notes || '').trim().slice(0, 500);
        const levels = Array.isArray(req.body.levels) && req.body.levels.length
            ? req.body.levels.map((level) => normalizeLevelKey(level)).filter(Boolean)
            : Array.from(DATABASE_DISPLAY_LEVELS);

        client = await pool.connect();
        await client.query('BEGIN');

        const insert = await client.query(`
            INSERT INTO control_areas (
                name, west, south, east, north, start_at, end_at, notes, geom
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8,
                ST_SetSRID(ST_MakeEnvelope($2, $3, $4, $5), 4326)
            )
            RETURNING id, name, west, south, east, north, start_at, end_at, status,
                      affected_grid_count, notes, created_at, updated_at;
        `, [name, bounds.west, bounds.south, bounds.east, bounds.north, new Date(startMs), new Date(endMs), notes]);

        const area = insert.rows[0];
        const update = await client.query(`
            UPDATE airspace_grid
            SET control_start_at = $5,
                control_end_at = $6,
                updated_at = NOW()
            WHERE grid_level = ANY($7::text[])
              AND ST_Intersects(geom, ST_SetSRID(ST_MakeEnvelope($1, $2, $3, $4), 4326))
            RETURNING geosot_id;
        `, [bounds.west, bounds.south, bounds.east, bounds.north, new Date(startMs), new Date(endMs), levels]);

        const geosotIds = update.rows.map((row) => row.geosot_id);
        if (geosotIds.length) {
            await client.query(`
                INSERT INTO airspace_grid_state_history (
                    geosot_id, status, fly_weight, traffic_density, weather_limit,
                    control_start_at, control_end_at, reason
                )
                SELECT geosot_id, 1, NULL, NULL, NULL, $2, $3, $4
                FROM unnest($1::text[]) AS geosot_id;
            `, [geosotIds, new Date(startMs), new Date(endMs), `矩形管控区：${name}`]);
        }

        const updatedArea = await client.query(`
            UPDATE control_areas
            SET affected_grid_count = $2,
                updated_at = NOW()
            WHERE id = $1
            RETURNING id, name, west, south, east, north, start_at, end_at, status,
                      affected_grid_count, notes, created_at, updated_at;
        `, [area.id, geosotIds.length]);

        await client.query('COMMIT');
        res.status(201).json({ controlArea: normalizeControlAreaRow(updatedArea.rows[0]) });
    } catch (error) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('管控区回滚失败:', rollbackError);
            }
        }
        console.error('管控区保存失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '管控区保存失败') });
    } finally {
        if (client) client.release();
    }
});

// 删除临时管控区，同时解除对应网格上的管控时间窗，避免地图残留限制状态。
app.delete('/api/control-areas/:id', async (req, res) => {
    let client;
    try {
        await ensureControlAreaSchema();
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ message: '缺少有效的管控区编号' });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        const found = await client.query(`
            UPDATE control_areas
            SET status = 'deleted',
                updated_at = NOW()
            WHERE id = $1 AND status <> 'deleted'
            RETURNING id, name, west, south, east, north, start_at, end_at, status,
                      affected_grid_count, notes, geom, created_at, updated_at;
        `, [id]);
        if (!found.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: '未找到该管控区' });
        }

        const area = found.rows[0];
        const clear = await client.query(`
            UPDATE airspace_grid
            SET control_start_at = NULL,
                control_end_at = NULL,
                updated_at = NOW()
            WHERE ST_Intersects(geom, $1::geometry)
              AND control_start_at = $2
              AND control_end_at = $3
            RETURNING geosot_id, current_status;
        `, [area.geom, area.start_at, area.end_at]);

        if (clear.rows.length) {
            await client.query(`
                INSERT INTO airspace_grid_state_history (
                    geosot_id, status, fly_weight, traffic_density, weather_limit,
                    control_start_at, control_end_at, reason
                )
                SELECT geosot_id, status, NULL, NULL, NULL, NULL, NULL, $2
                FROM jsonb_to_recordset($1::jsonb) AS item(geosot_id text, status integer);
            `, [JSON.stringify(clear.rows.map((row) => ({
                geosot_id: row.geosot_id,
                status: Number(row.current_status || 0),
            }))), `取消矩形管控区：${area.name}`]);
        }

        await client.query('COMMIT');
        res.json({ controlArea: normalizeControlAreaRow(area), cleared: clear.rowCount });
    } catch (error) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('管控区删除回滚失败:', rollbackError);
            }
        }
        console.error('管控区删除失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '管控区删除失败') });
    } finally {
        if (client) client.release();
    }
});

// 单方案路径规划入口，按给定目标层级、起点、终点和约束返回航线与走廊网格。
app.post('/api/plan-path', async (req, res) => {
    try {
        await expireFinishedControlAreas();
        const { start, end, level, options = {} } = req.body;
        const result = await planSegment(start, end, level || DEFAULT_LEVEL, options);
        res.json(result);
    } catch (error) {
        console.error('路径规划失败:', error);
        res.status(error.statusCode || 500).json({ message: clientErrorMessage(error, '路径规划失败') });
    }
});

// 多方案对比入口，同一组起终点分别计算综合最优、最短、最低风险和 Dijkstra 基线。
app.post('/api/plan-alternatives', async (req, res) => {
    try {
        await expireFinishedControlAreas();
        const { start, end, level, options = {} } = req.body;
        const objectives = Array.isArray(req.body.objectives) && req.body.objectives.length > 0
            ? req.body.objectives
            : ['balanced', 'shortest', 'safest', 'baseline'];
        const alternatives = [];

        for (const objective of objectives) {
            try {
                const result = await planSegment(start, end, level || DEFAULT_LEVEL, { ...options, objective });
                alternatives.push({
                    objective,
                    status: 'success',
                    route: result,
                    metrics: result.metadata,
                });
            } catch (error) {
                alternatives.push({
                    objective,
                    status: 'failed',
                    message: error.message,
                });
            }
        }

        res.json({ alternatives });
    } catch (error) {
        res.status(error.statusCode || 500).json({ message: clientErrorMessage(error, '多方案规划失败') });
    }
});

// 查询示例大学区域网格；数据库有数据时返回真实网格，缺失层级则生成仅用于显示的网格线。
app.get('/api/university-grids', async (req, res) => {
    try {
        await expireFinishedControlAreas();
        const { west, south, east, north } = req.query;
        const levelKey = normalizeLevelKey(req.query.level);
        const spec = getLevelSpec(levelKey);
        const includeObstacles = ['1', 'true', 'yes'].includes(String(req.query.includeObstacles || '').toLowerCase());
        const altitudeMode = String(req.query.altitudeMode || '').toLowerCase();
        const allLayers = altitudeMode === 'all'
            || ['1', 'true', 'yes'].includes(String(req.query.allLayers || req.query.allAltitudes || req.query.fullAltitude || '').toLowerCase());
        const displayLimit = parseDisplayLimit(req.query.limit);
        const displayAltitude = allLayers ? null : parseDisplayAltitude(req.query.displayAlt ?? req.query.alt, spec);
        const displayLayer = displayAltitude === null ? null : altitudeToLayer(displayAltitude, spec);

        if (![west, south, east, north].every((value) => Number.isFinite(Number(value)))) {
            return res.json({ type: 'FeatureCollection', features: [] });
        }

        const maxVisibleAltitude = allLayers
            ? spec.maxAltitude
            : displayAltitude !== null
            ? spec.maxAltitude
            : includeObstacles
            ? spec.maxAltitude
            : (levelKey === 'L22' ? spec.verticalStep : spec.verticalStep * 2);
        const shouldUseDatabase = DATABASE_DISPLAY_LEVELS.has(levelKey)
            || (includeObstacles && DATABASE_OBSTACLE_LEVELS.has(levelKey));
        if (!shouldUseDatabase) {
            return res.json(syntheticDisplayGridCollection(west, south, east, north, spec, maxVisibleAltitude, {
                displayLayer,
                limit: displayLimit,
            }));
        }

        const altitudeClause = displayAltitude === null
            ? 'AND alt_bottom < $6'
            : 'AND alt_bottom <= $6 AND alt_top > $6';
        const altitudeValue = displayAltitude === null ? maxVisibleAltitude : displayAltitude;

        const result = await pool.query(`
            SELECT
                id::text,
                geosot_id,
                geosot_code,
                geosot_level,
                grid_level,
                alt_bottom,
                alt_top,
                current_status,
                fly_weight,
                surface_type,
                surface_weight,
                weather_fly_weight,
                traffic_density,
                weather_traffic_density,
                weather_limit,
                control_start_at,
                control_end_at,
                risk_level,
                weather_risk_level,
                ST_AsGeoJSON(geom)::json AS geometry
            FROM airspace_grid
            WHERE grid_level = $5
              ${altitudeClause}
              AND ST_Intersects(
                  geom,
                  ST_SetSRID(ST_MakeEnvelope($1::numeric, $2::numeric, $3::numeric, $4::numeric), 4326)
              )
            ORDER BY current_status DESC, alt_bottom ASC
            LIMIT $7;
        `, [west, south, east, north, spec.key, altitudeValue, displayLimit]);

        if (result.rows.length === 0) {
            return res.json(syntheticDisplayGridCollection(west, south, east, north, spec, maxVisibleAltitude, {
                displayLayer,
                limit: displayLimit,
            }));
        }

        const features = result.rows.map((row) => {
            const status = Number(row.current_status || 0);
            const surfaceType = normalizeSurfaceType(row.surface_type);
            const surfaceWeight = Number(row.surface_weight || 1);
            const buildingBlocked = isBuildingSurface(surfaceType);
            const weatherLimit = Boolean(row.weather_limit);
            const hasTimedControl = Boolean(row.control_start_at && row.control_end_at);
            const controlledNow = isControlActive({
                controlStartAt: row.control_start_at,
                controlEndAt: row.control_end_at,
            });
            const effectiveStatus = weatherLimit || controlledNow || status !== 0 || buildingBlocked ? 1 : 0;

            return {
                type: 'Feature',
                geometry: row.geometry,
                properties: {
                    id: row.id,
                    geosot_id: row.geosot_id,
                    geosot_code: row.geosot_code,
                    geosot_level: row.geosot_level,
                    grid_level: row.grid_level,
                    bottom: Number(row.alt_bottom),
                    top: Number(row.alt_top),
                    status: effectiveStatus,
                    stored_status: status,
                    effective_status: effectiveStatus,
                    surface_type: surfaceType,
                    surface_weight: surfaceWeight,
                    fly_weight: Math.max(
                        Number(row.fly_weight || 1),
                        surfaceWeight,
                        Number(row.weather_fly_weight || 1),
                        buildingBlocked ? BUILDING_SURFACE_WEIGHT : 1,
                    ),
                    traffic_density: Math.max(Number(row.traffic_density || 0), Number(row.weather_traffic_density || 0)),
                    weather_limit: weatherLimit,
                    control_start_at: row.control_start_at,
                    control_end_at: row.control_end_at,
                    risk_level: Math.max(Number(row.risk_level || 0), Number(row.weather_risk_level || 0), buildingBlocked ? 5 : 0),
                    weather_risk_level: Number(row.weather_risk_level || 0),
                    weather_fly_weight: Number(row.weather_fly_weight || 1),
                },
            };
        });

        res.json({
            type: 'FeatureCollection',
            features,
            metadata: {
                truncated: result.rows.length >= displayLimit,
                returned: features.length,
                display_altitude: displayAltitude,
                display_layer: displayLayer,
                all_layers: allLayers,
                limit: displayLimit,
            },
        });
    } catch (error) {
        console.error('网格查询失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '网格查询失败') });
    }
});

/**
 * 封装occupancy query range相关逻辑，保持调用处简洁并便于后续维护。
 */
function occupancyQueryRange(query = {}) {
    const fromMs = parseIsoMs(query.from || query.start || query.startAt);
    const toMs = parseIsoMs(query.to || query.end || query.endAt);
    if (fromMs != null && toMs != null && fromMs < toMs) {
        return { from: new Date(fromMs), to: new Date(toMs) };
    }
    const atMs = parseIsoMs(query.at || query.time) ?? Date.now();
    return { from: new Date(atMs), to: new Date(atMs + 1000) };
}

/**
 * 封装occupancy levels from query相关逻辑，保持调用处简洁并便于后续维护。
 */
function occupancyLevelsFromQuery(value) {
    const raw = Array.isArray(value) ? value : String(value || 'L16,L19,L22').split(',');
    const levels = raw
        .map((level) => normalizeLevelKey(level))
        .filter((level, index, list) => DATABASE_DISPLAY_LEVELS.has(level) && list.indexOf(level) === index);
    return levels.length ? levels : Array.from(DATABASE_DISPLAY_LEVELS);
}

/**
 * 封装occupancy bounds params相关逻辑，保持调用处简洁并便于后续维护。
 */
function occupancyBoundsParams(bounds) {
    return bounds
        ? [bounds.west, bounds.south, bounds.east, bounds.north]
        : [null, null, null, null];
}

// 统计指定时间窗内各层级空域网格的占用数量，用于多机容量和冲突态势展示。
app.get('/api/airspace-occupancy/stats', async (req, res) => {
    try {
        await ensureRouteArchiveSchema();
        const levels = occupancyLevelsFromQuery(req.query.levels || req.query.level);
        const range = occupancyQueryRange(req.query);
        const bounds = queryBounds(req.query);
        const [west, south, east, north] = occupancyBoundsParams(bounds);

        const totalResult = await pool.query(`
            SELECT grid_level, COUNT(*)::int AS total_cells
            FROM airspace_grid
            WHERE grid_level = ANY($1::text[])
              AND ($2::numeric IS NULL OR ST_Intersects(
                  geom,
                  ST_SetSRID(ST_MakeEnvelope($2::numeric, $3::numeric, $4::numeric, $5::numeric), 4326)
              ))
            GROUP BY grid_level;
        `, [levels, west, south, east, north]);

        const occupiedResult = await pool.query(`
            WITH active AS (
                SELECT *
                FROM planned_route_occupancy
                WHERE status = ANY($1::text[])
                  AND entered_at < $4
                  AND exited_at > $3
                  AND ($5::numeric IS NULL OR ST_Intersects(
                      geom,
                      ST_SetSRID(ST_MakeEnvelope($5::numeric, $6::numeric, $7::numeric, $8::numeric), 4326)
                  ))
            )
            SELECT
                grid_cell.grid_level,
                COUNT(DISTINCT grid_cell.geosot_id)::int AS occupied_cells,
                COUNT(DISTINCT COALESCE(active.uav_id, active.route_id::text))::int AS occupied_uav_count,
                COUNT(DISTINCT active.route_id)::int AS route_count,
                MIN(active.entered_at) AS first_entered_at,
                MAX(active.exited_at) AS last_exited_at
            FROM active
            JOIN airspace_grid grid_cell
              ON grid_cell.grid_level = ANY($2::text[])
             AND grid_cell.geom && active.geom
             AND ST_Intersects(grid_cell.geom, active.geom)
             AND grid_cell.alt_top > active.alt_bottom
             AND grid_cell.alt_bottom < active.alt_top
            WHERE ($5::numeric IS NULL OR ST_Intersects(
                grid_cell.geom,
                ST_SetSRID(ST_MakeEnvelope($5::numeric, $6::numeric, $7::numeric, $8::numeric), 4326)
            ))
            GROUP BY grid_cell.grid_level;
        `, [OCCUPANCY_ACTIVE_STATUSES, levels, range.from, range.to, west, south, east, north]);

        const totals = new Map(totalResult.rows.map((row) => [row.grid_level, Number(row.total_cells || 0)]));
        const occupied = new Map(occupiedResult.rows.map((row) => [row.grid_level, row]));
        res.json({
            from: range.from.toISOString(),
            to: range.to.toISOString(),
            levels: levels.map((level) => {
                const row = occupied.get(level) || {};
                const totalCells = totals.get(level) || 0;
                const occupiedCells = Number(row.occupied_cells || 0);
                return {
                    level,
                    total_cells: totalCells,
                    occupied_cells: occupiedCells,
                    occupied_cell_pct: totalCells ? Number(((occupiedCells / totalCells) * 100).toFixed(2)) : 0,
                    occupied_uav_count: Number(row.occupied_uav_count || 0),
                    route_count: Number(row.route_count || 0),
                    first_entered_at: row.first_entered_at || null,
                    last_exited_at: row.last_exited_at || null,
                };
            }),
        });
    } catch (error) {
        console.error('空域占用统计失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '空域占用统计失败') });
    }
});

// 返回指定时间窗内被任务占用的网格几何，用于前端绘制占用图层。
app.get('/api/airspace-occupancy/grids', async (req, res) => {
    try {
        await ensureRouteArchiveSchema();
        const levelKey = normalizeLevelKey(req.query.level || 'L22');
        if (!DATABASE_DISPLAY_LEVELS.has(levelKey)) {
            return res.status(400).json({ message: '该层级暂未入库，不能生成占用图层' });
        }
        const range = occupancyQueryRange(req.query);
        const bounds = queryBounds(req.query);
        const [west, south, east, north] = occupancyBoundsParams(bounds);
        const displayLimit = parseDisplayLimit(req.query.limit || 12000);

        const result = await pool.query(`
            WITH active AS (
                SELECT *
                FROM planned_route_occupancy
                WHERE status = ANY($1::text[])
                  AND entered_at < $4
                  AND exited_at > $3
                  AND ($6::numeric IS NULL OR ST_Intersects(
                      geom,
                      ST_SetSRID(ST_MakeEnvelope($6::numeric, $7::numeric, $8::numeric, $9::numeric), 4326)
                  ))
            )
            SELECT
                grid_cell.id::text,
                grid_cell.geosot_id,
                grid_cell.geosot_code,
                grid_cell.geosot_level,
                grid_cell.grid_level,
                grid_cell.alt_bottom,
                grid_cell.alt_top,
                COUNT(DISTINCT COALESCE(active.uav_id, active.route_id::text))::int AS occupied_uav_count,
                COUNT(DISTINCT active.route_id)::int AS route_count,
                MIN(active.entered_at) AS first_entered_at,
                MAX(active.exited_at) AS last_exited_at,
                ST_AsGeoJSON(grid_cell.geom)::json AS geometry
            FROM active
            JOIN airspace_grid grid_cell
              ON grid_cell.grid_level = $2
             AND grid_cell.geom && active.geom
             AND ST_Intersects(grid_cell.geom, active.geom)
             AND grid_cell.alt_top > active.alt_bottom
             AND grid_cell.alt_bottom < active.alt_top
            WHERE ($6::numeric IS NULL OR ST_Intersects(
                grid_cell.geom,
                ST_SetSRID(ST_MakeEnvelope($6::numeric, $7::numeric, $8::numeric, $9::numeric), 4326)
            ))
            GROUP BY
                grid_cell.id, grid_cell.geosot_id, grid_cell.geosot_code,
                grid_cell.geosot_level, grid_cell.grid_level,
                grid_cell.alt_bottom, grid_cell.alt_top, grid_cell.geom
            ORDER BY occupied_uav_count DESC, first_entered_at ASC
            LIMIT $5;
        `, [OCCUPANCY_ACTIVE_STATUSES, levelKey, range.from, range.to, displayLimit, west, south, east, north]);

        res.json({
            type: 'FeatureCollection',
            features: result.rows.map((row) => ({
                type: 'Feature',
                geometry: row.geometry,
                properties: {
                    id: row.id,
                    geosot_id: row.geosot_id,
                    geosot_code: row.geosot_code,
                    geosot_level: row.geosot_level,
                    grid_level: row.grid_level,
                    bottom: Number(row.alt_bottom),
                    top: Number(row.alt_top),
                    status: 1,
                    effective_status: 1,
                    occupancy_status: 'occupied',
                    occupied_uav_count: Number(row.occupied_uav_count || 0),
                    route_count: Number(row.route_count || 0),
                    first_entered_at: row.first_entered_at,
                    last_exited_at: row.last_exited_at,
                },
            })),
            metadata: {
                level: levelKey,
                from: range.from.toISOString(),
                to: range.to.toISOString(),
                returned: result.rows.length,
                truncated: result.rows.length >= displayLimit,
                limit: displayLimit,
            },
        });
    } catch (error) {
        console.error('空域占用图层查询失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '空域占用图层查询失败') });
    }
});

// 人工修改单元状态、权重或气象限制，并同步写入状态历史表。
app.post('/api/grid-state', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        const geosotIds = Array.isArray(req.body.geosotIds)
            ? req.body.geosotIds
            : [req.body.geosotId].filter(Boolean);

        if (geosotIds.length === 0) {
            return res.status(400).json({ message: '缺少 geosotId 或 geosotIds' });
        }

        const status = Number.isInteger(Number(req.body.status)) ? Number(req.body.status) : 0;
        if (![0, 1].includes(status)) {
            return res.status(400).json({ message: '网格状态只能为 0 或 1' });
        }
        const flyWeight = req.body.flyWeight == null ? null : Number(req.body.flyWeight);
        const trafficDensity = req.body.trafficDensity == null ? null : Number(req.body.trafficDensity);
        if (flyWeight !== null && (!Number.isFinite(flyWeight) || flyWeight < 0.1 || flyWeight > 9.99)) {
            return res.status(400).json({ message: '飞行权重必须在 0.10-9.99 之间' });
        }
        if (trafficDensity !== null && (!Number.isFinite(trafficDensity) || trafficDensity < 0 || trafficDensity > 99.99)) {
            return res.status(400).json({ message: '交通密度必须在 0-99.99 之间' });
        }
        const weatherLimit = req.body.weatherLimit == null ? null : Boolean(req.body.weatherLimit);
        const controlStartAt = req.body.controlStartAt || null;
        const controlEndAt = req.body.controlEndAt || null;
        const reason = req.body.reason || '人工更新';

        await client.query('BEGIN');
        const update = await client.query(`
            WITH updated AS (
                UPDATE airspace_grid
                SET current_status = CASE WHEN surface_type = 'building' THEN 1 ELSE $2 END,
                    fly_weight = CASE
                        WHEN surface_type = 'building' THEN GREATEST(COALESCE($3, fly_weight), $9::numeric)
                        ELSE COALESCE($3, fly_weight)
                    END,
                    traffic_density = COALESCE($4, traffic_density),
                    weather_limit = COALESCE($5, weather_limit),
                    control_start_at = $6,
                    control_end_at = $7,
                    risk_level = CASE WHEN surface_type = 'building' THEN GREATEST(risk_level, 5) ELSE risk_level END,
                    updated_at = NOW()
                WHERE geosot_id = ANY($1)
                RETURNING
                    geosot_id, geosot_code, grid_level, geosot_z,
                    alt_bottom, alt_top, current_status, fly_weight,
                    traffic_density, weather_limit, control_start_at, control_end_at,
                    surface_type, surface_weight
            ), history AS (
                INSERT INTO airspace_grid_state_history (
                    geosot_id, status, fly_weight, traffic_density, weather_limit,
                    control_start_at, control_end_at, reason
                )
                SELECT
                    geosot_id, current_status, fly_weight, traffic_density, weather_limit,
                    control_start_at, control_end_at, $8
                FROM updated
            )
            SELECT * FROM updated;
        `, [geosotIds, status, flyWeight, trafficDensity, weatherLimit, controlStartAt, controlEndAt, reason, BUILDING_SURFACE_WEIGHT]);

        await client.query('COMMIT');
        res.json({
            updated: update.rowCount,
            grids: update.rows.map((row) => {
                const surfaceType = normalizeSurfaceType(row.surface_type);
                const buildingBlocked = isBuildingSurface(surfaceType);
                return {
                    geosotId: row.geosot_id,
                    geosotCode: row.geosot_code,
                    gridLevel: row.grid_level,
                    geosotZ: row.geosot_z,
                    altitudeRange: `${Number(row.alt_bottom).toFixed(0)}-${Number(row.alt_top).toFixed(0)}m`,
                    status: buildingBlocked ? 1 : Number(row.current_status || 0),
                    storedStatus: Number(row.current_status || 0),
                    surfaceType,
                    surfaceWeight: Number(row.surface_weight || 1),
                    flyWeight: Math.max(
                        Number(row.fly_weight || 1),
                        Number(row.surface_weight || 1),
                        buildingBlocked ? BUILDING_SURFACE_WEIGHT : 1,
                    ),
                    trafficDensity: Number(row.traffic_density || 0),
                    weatherLimit: Boolean(row.weather_limit),
                    controlStartAt: row.control_start_at,
                    controlEndAt: row.control_end_at,
                };
            }),
        });
    } catch (error) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('网格状态回滚失败:', rollbackError);
            }
        }
        console.error('网格状态更新失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '网格状态更新失败') });
    } finally {
        if (client) client.release();
    }
});

// 查询单个网格的状态历史，支撑前端点击网格后的状态追溯面板。
app.get('/api/grid-state/history', async (req, res) => {
    try {
        const { geosot_id: geosotId } = req.query;
        if (!geosotId) return res.status(400).json({ message: '缺少 geosot_id' });

        const result = await pool.query(`
            SELECT *
            FROM airspace_grid_state_history
            WHERE geosot_id = $1
            ORDER BY created_at DESC
            LIMIT 100;
        `, [geosotId]);

        res.json({ history: result.rows });
    } catch (error) {
        res.status(500).json({ message: clientErrorMessage(error, '网格历史查询失败') });
    }
});

// 保存规划完成的路径，并生成与飞行时间一致的网格占用时间戳。
app.post('/api/routes', async (req, res) => {
    let client;
    try {
        await ensureRouteArchiveSchema();

        const route = req.body.route;
        if (!route || route.type !== 'FeatureCollection') {
            return res.status(400).json({ message: '缺少有效的路径 FeatureCollection' });
        }

        const waypoints = Array.isArray(route.route?.waypoints)
            ? route.route.waypoints.map(normalizeArchivePoint).filter(Boolean)
            : [];
        if (waypoints.length < 2) {
            return res.status(400).json({ message: '路径至少需要包含两个有效航点' });
        }
        const start = normalizeArchivePoint(req.body.start) || waypoints[0];
        const end = normalizeArchivePoint(req.body.end) || waypoints[waypoints.length - 1];

        if (!start || !end) {
            return res.status(400).json({ message: '缺少路径起点或终点' });
        }

        const metadata = route.metadata || {};
        const risk = metadata.risk || {};
        const routeType = String(req.body.routeType || metadata.route_type || 'mission').slice(0, 40);
        const objective = String(metadata.objective || req.body.objective || 'balanced').slice(0, 40);
        const name = String(req.body.name || defaultRouteName(routeType)).slice(0, 120);
        const features = Array.isArray(route.features) ? route.features : [];
        const gridIds = features
            .map((feature) => feature?.properties?.geosot_id)
            .filter(Boolean);
        const lineWkt = routeLineWkt(waypoints);

        client = await pool.connect();
        await client.query('BEGIN');

        const result = await client.query(`
            INSERT INTO planned_routes (
                route_name, route_type, objective,
                start_lon, start_lat, start_alt,
                end_lon, end_lat, end_alt,
                distance_m, estimated_seconds, grid_count, waypoint_count,
                risk_level, risk_score, route_geojson, grid_ids, track_geom
            )
            VALUES (
                $1, $2, $3,
                $4, $5, $6,
                $7, $8, $9,
                $10, $11, $12, $13,
                $14, $15, $16::jsonb, $17::text[],
                CASE WHEN $18::text IS NULL THEN NULL ELSE ST_GeomFromText($18, 4326) END
            )
            RETURNING
                id, route_name, route_type, objective, created_at,
                start_lon, start_lat, start_alt, end_lon, end_lat, end_alt,
                distance_m, estimated_seconds, grid_count, waypoint_count,
                risk_level, risk_score;
        `, [
            name,
            routeType,
            objective,
            start.lon,
            start.lat,
            start.alt,
            end.lon,
            end.lat,
            end.alt,
            finiteOrNull(metadata.distance_m) ?? 0,
            finiteOrNull(metadata.estimated_seconds) ?? 0,
            Number(metadata.grid_corridor?.count || metadata.total_grids || features.length || 0),
            waypoints.length,
            String(risk.level || '低').slice(0, 12),
            finiteOrNull(risk.score) ?? 0,
            route,
            gridIds,
            lineWkt,
        ]);

        const occupancyCount = await insertRouteOccupancy(client, result.rows[0].id, route, {
            uavId: req.body.uavId || req.body.uav_id,
            missionId: req.body.missionId || req.body.mission_id,
        });

        await client.query('COMMIT');
        res.status(201).json({
            route: {
                ...archiveRouteSummary(result.rows[0]),
                occupancy_count: occupancyCount,
            },
        });
    } catch (error) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('路径归档回滚失败:', rollbackError);
            }
        }
        console.error('路径归档保存失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '路径归档保存失败') });
    } finally {
        if (client) client.release();
    }
});

// 读取已归档路径列表，供前端分页复现、方案对比和统计展示。
app.get('/api/routes', async (req, res) => {
    try {
        await ensureRouteArchiveSchema();
        const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
        const result = await pool.query(`
            SELECT
                id, route_name, route_type, objective, created_at,
                start_lon, start_lat, start_alt, end_lon, end_lat, end_alt,
                distance_m, estimated_seconds, grid_count, waypoint_count,
                risk_level, risk_score
            FROM planned_routes
            ORDER BY created_at DESC
            LIMIT $1;
        `, [limit]);

        res.json({ routes: result.rows.map(archiveRouteSummary) });
    } catch (error) {
        console.error('路径归档列表读取失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '路径归档列表读取失败') });
    }
});

// 汇总运行统计，包括飞行次数、里程、网格占用和管控区概况。
app.get('/api/dashboard-stats', async (req, res) => {
    try {
        await ensureRouteArchiveSchema();
        await ensureControlAreaSchema();
        await expireFinishedControlAreas();

        const dailyResult = await pool.query(`
            WITH days AS (
                SELECT generate_series(
                    date_trunc('day', NOW()) - INTERVAL '6 days',
                    date_trunc('day', NOW()),
                    INTERVAL '1 day'
                ) AS day
            )
            SELECT
                to_char(days.day, 'MM-DD') AS label,
                COALESCE(COUNT(routes.id), 0)::int AS flight_count,
                COALESCE(SUM(routes.distance_m), 0)::float AS distance_m,
                COALESCE(SUM(routes.grid_count), 0)::int AS grid_count
            FROM days
            LEFT JOIN planned_routes routes
                ON routes.created_at >= days.day
               AND routes.created_at < days.day + INTERVAL '1 day'
            GROUP BY days.day
            ORDER BY days.day;
        `);

        const controlResult = await pool.query(`
            SELECT
                COUNT(*) FILTER (
                    WHERE status <> 'deleted'
                      AND start_at <= NOW()
                      AND end_at >= NOW()
                )::int AS active_count,
                COUNT(*) FILTER (
                    WHERE status = 'expired'
                       OR (status <> 'deleted' AND end_at < NOW())
                )::int AS historical_count,
                COUNT(*) FILTER (
                    WHERE status <> 'deleted'
                      AND start_at > NOW()
                )::int AS scheduled_count,
                COALESCE(SUM(affected_grid_count) FILTER (
                    WHERE status <> 'deleted'
                      AND start_at <= NOW()
                      AND end_at >= NOW()
                ), 0)::int AS active_grid_count
            FROM control_areas;
        `);

        const totalsResult = await pool.query(`
            SELECT
                COUNT(*)::int AS total_flights,
                COALESCE(SUM(distance_m), 0)::float AS total_distance_m,
                COALESCE(SUM(grid_count), 0)::int AS total_grid_count
            FROM planned_routes;
        `);

        res.json({
            daily: dailyResult.rows.map((row) => ({
                label: row.label,
                flight_count: Number(row.flight_count || 0),
                distance_m: Number(row.distance_m || 0),
                grid_count: Number(row.grid_count || 0),
            })),
            control: {
                active_count: Number(controlResult.rows[0]?.active_count || 0),
                historical_count: Number(controlResult.rows[0]?.historical_count || 0),
                scheduled_count: Number(controlResult.rows[0]?.scheduled_count || 0),
                active_grid_count: Number(controlResult.rows[0]?.active_grid_count || 0),
            },
            totals: {
                total_flights: Number(totalsResult.rows[0]?.total_flights || 0),
                total_distance_m: Number(totalsResult.rows[0]?.total_distance_m || 0),
                total_grid_count: Number(totalsResult.rows[0]?.total_grid_count || 0),
            },
        });
    } catch (error) {
        console.error('仪表盘统计读取失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '仪表盘统计读取失败') });
    }
});

// 获取当前天气并转换为前端统一展示字段。
app.get('/api/weather', async (req, res) => {
    try {
        const weather = await fetchWeatherNow(req.query.location || QWEATHER_LOCATION);
        res.json({
            location: weather.location,
            weather: {
                text: weather.text,
                temp: weather.temp,
                feelsLike: weather.feelsLike,
                windDir: weather.windDir,
                windScale: weather.windScale,
                windSpeed: weather.windSpeed,
                humidity: weather.humidity,
                precip: weather.precip,
                vis: weather.vis,
                obsTime: weather.obsTime,
            },
            updateTime: weather.updateTime,
        });
    } catch (error) {
        console.error('天气数据读取失败:', error);
        res.status(502).json({ message: clientErrorMessage(error, '天气数据读取失败') });
    }
});

// 气象管控接口按同一套 scope 工作，前端传入任务范围时只更新任务相关网格。
// 查询气象管控影响范围、限制网格数量和最近一次自动管控记录。
app.get('/api/weather-control/status', async (req, res) => {
    try {
        const scope = normalizeWeatherScope(req.query || {});
        const counts = await weatherControlCounts(scope.levels, scope.bounds);
        const latest = await latestWeatherControlEvent(scope);
        res.json({
            levels: scope.levels,
            scope: scope.bounds ? 'bounds' : 'levels',
            restricted: counts.restricted > 0,
            affected_grid_count: counts.affected,
            restricted_grid_count: counts.restricted,
            total_grid_count: counts.total,
            last_event: latest ? {
                weather_limit: Boolean(latest.weather_limit),
                status: Number(latest.status || 0),
                reason: latest.reason,
                created_at: latest.created_at,
            } : null,
        });
    } catch (error) {
        console.error('气象管控状态读取失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '气象管控状态读取失败') });
    }
});

// 根据实时天气评估结果自动调整网格风险或禁飞状态。
app.post('/api/weather-control/sync', async (req, res) => {
    try {
        const weather = await fetchWeatherNow(req.body?.location || QWEATHER_LOCATION);
        const assessment = assessWeatherControl(weather);
        const scope = normalizeWeatherScope(req.body || {});
        const reason = assessment.action === 'restrict'
            ? `气象自动管控：${assessment.reason}`
            : assessment.action === 'risk'
            ? `气象自动风险：${assessment.reason}`
            : `气象自动解除：${assessment.reason}`;
        const policy = assessment.action === 'none' ? clearWeatherControlPolicy() : assessment;
        const updated = await applyWeatherControlPolicy(policy, reason, scope);
        const counts = await weatherControlCounts(scope.levels, scope.bounds);
        res.json({
            levels: scope.levels,
            scope: scope.bounds ? 'bounds' : 'levels',
            restricted: assessment.restricted,
            action: assessment.action,
            assessment,
            weather,
            updated,
            affected_grid_count: counts.affected,
            restricted_grid_count: counts.restricted,
            total_grid_count: counts.total,
            reason,
        });
    } catch (error) {
        console.error('气象管控同步失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '气象管控同步失败') });
    }
});

// 人工解除气象管控，将受影响网格恢复到基础状态。
app.post('/api/weather-control/clear', async (req, res) => {
    try {
        const reason = String(req.body?.reason || '气象自动解除：人工解除').slice(0, 240);
        const scope = normalizeWeatherScope(req.body || {});
        const updated = await applyWeatherControlPolicy(clearWeatherControlPolicy(), reason, scope);
        const counts = await weatherControlCounts(scope.levels, scope.bounds);
        res.json({
            levels: scope.levels,
            scope: scope.bounds ? 'bounds' : 'levels',
            restricted: counts.restricted > 0,
            updated,
            affected_grid_count: counts.affected,
            restricted_grid_count: counts.restricted,
            total_grid_count: counts.total,
            reason,
        });
    } catch (error) {
        console.error('气象管控解除失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '气象管控解除失败') });
    }
});

// 读取单条归档路径的完整 GeoJSON，供前端复现历史航线。
app.get('/api/routes/:id', async (req, res) => {
    try {
        await ensureRouteArchiveSchema();
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ message: '缺少有效的路径编号' });
        }

        const result = await pool.query(`
            SELECT
                id, route_name, route_type, objective, created_at,
                start_lon, start_lat, start_alt, end_lon, end_lat, end_alt,
                distance_m, estimated_seconds, grid_count, waypoint_count,
                risk_level, risk_score, route_geojson
            FROM planned_routes
            WHERE id = $1
            LIMIT 1;
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: '未找到该历史路径' });
        }

        const row = result.rows[0];
        res.json({
            route_info: archiveRouteSummary(row),
            route: row.route_geojson,
        });
    } catch (error) {
        console.error('路径归档详情读取失败:', error);
        res.status(500).json({ message: clientErrorMessage(error, '路径归档详情读取失败') });
    }
});

// 兼容早期调试入口：通过查询参数直接触发一次路径规划。
app.get('/plan', async (req, res) => {
    try {
        await expireFinishedControlAreas();
        const start = {
            lon: Number(req.query.startLon),
            lat: Number(req.query.startLat),
            alt: toFiniteNumber(req.query.startAlt, 0),
        };
        const end = {
            lon: Number(req.query.endLon),
            lat: Number(req.query.endLat),
            alt: toFiniteNumber(req.query.endAlt, 0),
        };
        const result = await planSegment(start, end, req.query.level || DEFAULT_LEVEL);
        res.json(result);
    } catch (error) {
        res.status(error.statusCode || 500).json({ message: clientErrorMessage(error, '路径规划失败') });
    }
});

/**
 * 封装start server相关逻辑，保持调用处简洁并便于后续维护。
 */
async function startServer() {
    await ensureBaseGridSchemaReady();
    await ensureSpatiotemporalIndexSchema();
    await ensureRouteArchiveSchema();
    await ensureHelipadSchema();
    await ensureControlAreaSchema();

    const port = Number(process.env.PORT || 3000);
    const server = app.listen(port, () => console.log(`Backend server started: http://localhost:${port}`));

    server.on('error', (error) => {
        console.error('Backend server failed to start:', error);
        process.exitCode = 1;
    });

}

startServer().catch((error) => {
    console.error('Backend initialization failed:', error);
    process.exitCode = 1;
});

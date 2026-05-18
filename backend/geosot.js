/*
 * @file geosot.js
 * @author changbai
 * @project 基于GeoSOT空域剖分单元状态管控的低空无人机飞行线路规划系统
 * @date 2026-05-08
 * @description GeoSOT网格剖分、编码、分辨率估算与高度层计算工具。
 */

const EARTH_RADIUS_M = 6378137;
const DEG_TO_RAD = Math.PI / 180;
const MIN_GEOSOT_DOMAIN = -256;
const MAX_GEOSOT_DOMAIN = 256;
const AXIS_BITS = 32;
const SUBSECOND_BITS = 11;
const SUBSECOND_UNIT_DEG = 1 / (3600 * (2 ** SUBSECOND_BITS));
const VERTICAL_REFERENCE_LATITUDE = 32;

const NANJING_BOUNDS = {
    minLon: 118.35,
    minLat: 31.25,
    maxLon: 119.25,
    maxLat: 32.45,
};
const JIANGNING_BOUNDS = {
    minLon: 118.480158,
    minLat: 31.616368,
    maxLon: 119.123664,
    maxLat: 32.111727,
};
const FINE_BOUNDS = {
    minLon: 118.776062,
    minLat: 31.913200,
    maxLon: 118.786048,
    maxLat: 31.919645,
};
const MAX_GENERATED_LEVEL = 22;

/**
 * 根据GeoSOT层级选择默认显示范围，粗层级覆盖更大区域，细层级聚焦示例研究区。
 */
function boundsForLevel(level) {
    if (level >= MAX_GENERATED_LEVEL) return FINE_BOUNDS;
    if (level >= 14) return JIANGNING_BOUNDS;
    return NANJING_BOUNDS;
}

/**
 * 给不同网格层级配置基础空域高度上限，用于控制理论三维剖分展示规模。
 */
function baseMaxAltitudeForLevel(level) {
    if (level >= 22) return 120;
    if (level >= 17) return 300;
    return 1000;
}

/**
 * 封装round meters相关逻辑，保持调用处简洁并便于后续维护。
 */
function roundMeters(value) {
    return Number(Number(value).toFixed(3));
}

/**
 * 按照水平理论分辨率推导垂向层高，使三维网格在显示上保持近似等尺度。
 */
function verticalSpecForLevel(level) {
    const resolution = estimateResolutionMeters(level, VERTICAL_REFERENCE_LATITUDE);
    const verticalStep = Math.max(0.001, roundMeters(resolution.nominalMeters));
    const baseMaxAltitude = baseMaxAltitudeForLevel(level);
    const layerCount = Math.max(1, Math.ceil(baseMaxAltitude / verticalStep));
    return {
        verticalStep,
        maxAltitude: roundMeters(layerCount * verticalStep),
    };
}

const GRID_LEVEL_SPECS = Object.fromEntries(
    Array.from({ length: MAX_GENERATED_LEVEL }, (_, index) => {
        const geosotLevel = index + 1;
        const key = `L${geosotLevel}`;
        return [key, {
            key,
            displayName: `GeoSOT-L${geosotLevel}`,
            geosotLevel,
            ...verticalSpecForLevel(geosotLevel),
            bounds: boundsForLevel(geosotLevel),
        }];
    }),
);

const LEVEL_ALIASES = new Map(
    Object.values(GRID_LEVEL_SPECS).flatMap((spec) => [
        [spec.key.toLowerCase(), spec.key],
        [`geosot-${spec.key.toLowerCase()}`, spec.key],
        [String(spec.geosotLevel), spec.key],
    ]),
);
LEVEL_ALIASES.set('fine', 'L22');
LEVEL_ALIASES.set('medium', 'L19');
LEVEL_ALIASES.set('coarse', 'L16');

/**
 * 规范化前端或接口传入的层级写法，统一转换为内部使用的L级别键。
 */
function normalizeLevelKey(level) {
    const value = String(level || 'L22').trim();
    if (GRID_LEVEL_SPECS[value]) return value;
    const raw = value.toLowerCase();
    return LEVEL_ALIASES.get(raw) || 'L22';
}

/**
 * 获取get level spec对应对象或配置，集中处理选择规则。
 */
function getLevelSpec(level) {
    return GRID_LEVEL_SPECS[normalizeLevelKey(level)];
}

/**
 * 封装assert coordinate in domain相关逻辑，保持调用处简洁并便于后续维护。
 */
function assertCoordinateInDomain(value, axisName) {
    if (!Number.isFinite(value) || value < MIN_GEOSOT_DOMAIN || value >= MAX_GEOSOT_DOMAIN) {
        throw new RangeError(`${axisName}必须在 [${MIN_GEOSOT_DOMAIN}, ${MAX_GEOSOT_DOMAIN}) 范围内`);
    }
}

/**
 * 封装to padded binary相关逻辑，保持调用处简洁并便于后续维护。
 */
function toPaddedBinary(value, length) {
    return Math.max(0, value).toString(2).padStart(length, '0').slice(-length);
}

/**
 * 将经纬度坐标转换为GeoSOT轴向二进制编码，是平面编码的基础步骤。
 */
function axisBitsFromCoordinate(value) {
    assertCoordinateInDomain(value, 'coordinate');

    const shifted = value - MIN_GEOSOT_DOMAIN;
    const degree = Math.floor(shifted);
    const minuteFloat = (shifted - degree) * 60;
    const minute = Math.floor(minuteFloat);
    const secondFloat = (minuteFloat - minute) * 60;
    const second = Math.floor(secondFloat);
    const subSecond = Math.floor((secondFloat - second) * (2 ** SUBSECOND_BITS));

    return [
        toPaddedBinary(degree, 9),
        toPaddedBinary(minute, 6),
        toPaddedBinary(second, 6),
        toPaddedBinary(subSecond, SUBSECOND_BITS),
    ].join('');
}

/**
 * 封装coordinate from axis bits相关逻辑，保持调用处简洁并便于后续维护。
 */
function coordinateFromAxisBits(bits) {
    const normalized = bits.padEnd(AXIS_BITS, '0').slice(0, AXIS_BITS);
    const degree = parseInt(normalized.slice(0, 9), 2);
    const minute = parseInt(normalized.slice(9, 15), 2);
    const second = parseInt(normalized.slice(15, 21), 2);
    const subSecond = parseInt(normalized.slice(21, 32), 2);

    return MIN_GEOSOT_DOMAIN
        + degree
        + (minute / 60)
        + (second / 3600)
        + (subSecond / ((2 ** SUBSECOND_BITS) * 3600));
}

/**
 * 封装coordinate upper from prefix相关逻辑，保持调用处简洁并便于后续维护。
 */
function coordinateUpperFromPrefix(prefixBits) {
    return coordinateFromAxisBits(prefixBits.padEnd(AXIS_BITS, '1')) + SUBSECOND_UNIT_DEG;
}

/**
 * 按经纬度轴向前缀交叉生成GeoSOT平面网格编码。
 */
function encodeSurface(lon, lat, geosotLevel) {
    if (geosotLevel < 1 || geosotLevel > 32) {
        throw new RangeError('GeoSOT 层级必须在 1 到 32 之间');
    }

    const lonBits = axisBitsFromCoordinate(lon).slice(0, geosotLevel);
    const latBits = axisBitsFromCoordinate(lat).slice(0, geosotLevel);
    let code = 'G';

    for (let i = 0; i < geosotLevel; i += 1) {
        const digit = (Number(latBits[i]) << 1) + Number(lonBits[i]);
        code += digit.toString(4);
    }

    return code;
}

/**
 * 封装axis cell from coordinate相关逻辑，保持调用处简洁并便于后续维护。
 */
function axisCellFromCoordinate(value, geosotLevel) {
    const prefix = axisBitsFromCoordinate(value).slice(0, geosotLevel);
    const lower = coordinateFromAxisBits(prefix);
    const upper = coordinateUpperFromPrefix(prefix);
    return {
        prefix,
        index: parseInt(prefix || '0', 2),
        lower,
        upper,
        center: (lower + upper) / 2,
    };
}

/**
 * 根据经纬度和层级反算网格边界、中心点与行列索引。
 */
function cellFromLonLat(lon, lat, geosotLevel) {
    const lonCell = axisCellFromCoordinate(lon, geosotLevel);
    const latCell = axisCellFromCoordinate(lat, geosotLevel);

    return {
        geosotCode: encodeSurface(lon, lat, geosotLevel),
        geosotLevel,
        x: lonCell.index,
        y: latCell.index,
        west: lonCell.lower,
        east: lonCell.upper,
        south: latCell.lower,
        north: latCell.upper,
        centerLon: lonCell.center,
        centerLat: latCell.center,
    };
}

/**
 * 封装cell size degrees for level相关逻辑，保持调用处简洁并便于后续维护。
 */
function cellSizeDegreesForLevel(geosotLevel) {
    if (geosotLevel <= 9) return 2 ** (9 - geosotLevel);
    if (geosotLevel <= 15) return (2 ** (15 - geosotLevel)) / 60;
    if (geosotLevel <= 21) return (2 ** (21 - geosotLevel)) / 3600;
    return 1 / ((2 ** (geosotLevel - 21)) * 3600);
}

/**
 * 把角度分辨率近似换算成米制边长，供界面显示和垂向层高估算使用。
 */
function estimateResolutionMeters(geosotLevel, latitude = 32) {
    const stepDeg = cellSizeDegreesForLevel(geosotLevel);
    const latMeters = stepDeg * (Math.PI * EARTH_RADIUS_M / 180);
    const lonMeters = latMeters * Math.cos(latitude * DEG_TO_RAD);
    return {
        latMeters,
        lonMeters,
        nominalMeters: Math.sqrt(Math.abs(latMeters * lonMeters)),
    };
}

/**
 * 将飞行高度映射到三维空域的垂直层号。
 */
function altitudeToLayer(altitude, spec) {
    const safeAlt = Math.max(0, Math.min(Number(altitude) || 0, spec.maxAltitude - 0.000001));
    return Math.floor(safeAlt / spec.verticalStep);
}

/**
 * 封装altitude layer range相关逻辑，保持调用处简洁并便于后续维护。
 */
function altitudeLayerRange(layer, spec) {
    return {
        bottom: layer * spec.verticalStep,
        top: Math.min((layer + 1) * spec.verticalStep, spec.maxAltitude),
    };
}

/**
 * 将平面GeoSOT编码与高度层号组合为三维体元编码。
 */
function make3DCode(surfaceCode, layer) {
    return `${surfaceCode}-Z${String(layer).padStart(3, '0')}`;
}

/**
 * 生成与度分秒剖分对齐的轴向单元，避免显示网格偏离标准边界。
 */
function dmsAlignedAxisCells(minValue, maxValue, geosotLevel) {
    const step = cellSizeDegreesForLevel(geosotLevel);
    const seen = new Map();
    const start = minValue - step * 2;
    const end = maxValue + step * 2;
    const sampleStep = step / 2;

    for (let value = start; value <= end; value += sampleStep) {
        const clamped = Math.min(Math.max(value, MIN_GEOSOT_DOMAIN + 1e-12), MAX_GEOSOT_DOMAIN - 1e-12);
        const cell = axisCellFromCoordinate(clamped, geosotLevel);
        if (cell.upper < minValue || cell.lower > maxValue) continue;
        seen.set(cell.prefix, cell);
    }

    return Array.from(seen.values()).sort((a, b) => a.lower - b.lower);
}

/**
 * 汇总各层级的边长、高度层和默认范围，供前端下拉框和图层渲染使用。
 */
function buildLevelMetadata() {
    return Object.values(GRID_LEVEL_SPECS).map((spec) => ({
        key: spec.key,
        displayName: spec.displayName,
        geosotLevel: spec.geosotLevel,
        verticalStep: spec.verticalStep,
        maxAltitude: spec.maxAltitude,
        bounds: spec.bounds,
        resolution: estimateResolutionMeters(spec.geosotLevel, 32),
    }));
}

module.exports = {
    GRID_LEVEL_SPECS,
    normalizeLevelKey,
    getLevelSpec,
    encodeSurface,
    cellFromLonLat,
    cellSizeDegreesForLevel,
    estimateResolutionMeters,
    altitudeToLayer,
    altitudeLayerRange,
    make3DCode,
    dmsAlignedAxisCells,
    buildLevelMetadata,
};

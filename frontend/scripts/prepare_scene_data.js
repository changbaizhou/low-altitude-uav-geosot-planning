/*
 * @file prepare_scene_data.js
 * @author changbai
 * @project 基于GeoSOT空域剖分单元状态管控的低空无人机飞行线路规划系统
 * @date 2026-05-08
 * @description 前端场景数据准备脚本，用于从原始OSM数据生成道路和水系GeoJSON。
 */

const fs = require('fs');
const path = require('path');

const sceneDir = path.join(__dirname, '..', 'public', 'scene');

const DATASETS = [
    {
        key: 'university',
        input: 'university_osm_overpass.json',
        roads: 'university_roads.geojson',
        water: 'university_water.geojson',
        bbox: [118.760, 31.895, 118.815, 31.930],
        label: 'university area',
    },
    {
        key: 'jiangning',
        input: 'jiangning_osm_overpass.json',
        roads: 'jiangning_roads.geojson',
        water: 'jiangning_water.geojson',
        waterways: 'jiangning_waterways.geojson',
        lakes: 'jiangning_lakes.geojson',
        relationId: 2147642,
        divisionCode: '320115',
        label: '南京市江宁区',
    },
];

/**
 * 封装feature collection相关逻辑，保持调用处简洁并便于后续维护。
 */
function featureCollection(features, dataset, layer) {
    return {
        type: 'FeatureCollection',
        metadata: {
            source: 'OpenStreetMap via Overpass API',
            license: 'Open Database License (ODbL)',
            dataset: dataset.key,
            label: dataset.label,
            layer,
            bbox: dataset.bbox,
            relationId: dataset.relationId,
            divisionCode: dataset.divisionCode,
            generatedAt: new Date().toISOString(),
        },
        features,
    };
}

/**
 * 封装road width相关逻辑，保持调用处简洁并便于后续维护。
 */
function roadWidth(highway) {
    const widths = {
        motorway: 24,
        trunk: 22,
        primary: 18,
        secondary: 14,
        tertiary: 12,
        residential: 7,
        service: 5,
        unclassified: 6,
        living_street: 5,
        track: 4,
        pedestrian: 4,
        footway: 2,
        path: 2,
        cycleway: 2,
        steps: 2,
    };
    return widths[highway] || 6;
}

/**
 * 封装waterway width相关逻辑，保持调用处简洁并便于后续维护。
 */
function waterwayWidth(waterway) {
    const widths = {
        river: 18,
        canal: 12,
        stream: 6,
        drain: 4,
        ditch: 3,
    };
    return widths[waterway] || 5;
}

/**
 * 判断is water area条件是否成立，供上层流程决定是否继续执行。
 */
function isWaterArea(tags = {}) {
    return tags.natural === 'water' || tags.landuse === 'reservoir' || Boolean(tags.water);
}

/**
 * 封装way coordinates相关逻辑，保持调用处简洁并便于后续维护。
 */
function wayCoordinates(way, nodes) {
    return (way.nodes || [])
        .map((nodeId) => nodes.get(nodeId))
        .filter(Boolean)
        .map((node) => [node.lon, node.lat]);
}

/**
 * 判断is closed ring条件是否成立，供上层流程决定是否继续执行。
 */
function isClosedRing(coordinates) {
    if (coordinates.length < 4) return false;
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    return first[0] === last[0] && first[1] === last[1];
}

/**
 * 封装close ring相关逻辑，保持调用处简洁并便于后续维护。
 */
function closeRing(coordinates) {
    if (coordinates.length === 0) return coordinates;
    if (!isClosedRing(coordinates)) coordinates.push([...coordinates[0]]);
    return coordinates;
}

/**
 * 封装coord key相关逻辑，保持调用处简洁并便于后续维护。
 */
function coordKey(coord) {
    return `${coord[0].toFixed(7)},${coord[1].toFixed(7)}`;
}

/**
 * 封装merge line fragments相关逻辑，保持调用处简洁并便于后续维护。
 */
function mergeLineFragments(fragments) {
    const rings = [];
    const open = fragments
        .filter((coords) => coords.length >= 2)
        .map((coords) => [...coords]);

    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 0; i < open.length; i += 1) {
            const a = open[i];
            if (isClosedRing(a)) {
                rings.push(a);
                open.splice(i, 1);
                changed = true;
                break;
            }

            const aStart = coordKey(a[0]);
            const aEnd = coordKey(a[a.length - 1]);

            for (let j = i + 1; j < open.length; j += 1) {
                const b = open[j];
                const bStart = coordKey(b[0]);
                const bEnd = coordKey(b[b.length - 1]);

                if (aEnd === bStart) {
                    a.push(...b.slice(1));
                } else if (aEnd === bEnd) {
                    a.push(...b.slice(0, -1).reverse());
                } else if (aStart === bEnd) {
                    a.unshift(...b.slice(0, -1));
                } else if (aStart === bStart) {
                    a.unshift(...b.slice(1).reverse());
                } else {
                    continue;
                }

                open.splice(j, 1);
                changed = true;
                break;
            }

            if (changed) break;
        }
    }

    for (const coords of open) {
        if (coords.length >= 4) rings.push(closeRing(coords));
    }

    return rings.filter((ring) => ring.length >= 4);
}

/**
 * 封装line feature相关逻辑，保持调用处简洁并便于后续维护。
 */
function lineFeature(way, nodes, kind, dataset) {
    const coordinates = wayCoordinates(way, nodes);
    if (coordinates.length < 2) return null;

    const highway = way.tags?.highway || '';
    const waterway = way.tags?.waterway || '';

    return {
        type: 'Feature',
        properties: {
            osm_id: way.id,
            dataset: dataset.key,
            kind,
            name: way.tags?.name || way.tags?.name_zh || '',
            highway,
            waterway,
            bridge: way.tags?.bridge || '',
            tunnel: way.tags?.tunnel || '',
            layer: Number(way.tags?.layer || 0),
            width_m: highway ? roadWidth(highway) : waterwayWidth(waterway),
            z_offset_m: way.tags?.bridge ? 8 : 0,
        },
        geometry: {
            type: 'LineString',
            coordinates,
        },
    };
}

/**
 * 封装water area feature相关逻辑，保持调用处简洁并便于后续维护。
 */
function waterAreaFeature(source, coordinates, dataset, relation = false) {
    if (coordinates.length < 4) return null;
    const tags = source.tags || {};
    const ring = closeRing([...coordinates]);

    return {
        type: 'Feature',
        properties: {
            osm_id: source.id,
            dataset: dataset.key,
            kind: relation ? 'water_relation' : 'water_area',
            name: tags.name || tags.name_zh || '',
            natural: tags.natural || '',
            landuse: tags.landuse || '',
            water: tags.water || '',
            area_type: tags.water || tags.landuse || tags.natural || 'water',
        },
        geometry: {
            type: 'Polygon',
            coordinates: [ring],
        },
    };
}

/**
 * 封装relation water feature相关逻辑，保持调用处简洁并便于后续维护。
 */
function relationWaterFeature(relation, ways, nodes, dataset) {
    const outerFragments = [];
    const innerFragments = [];

    for (const member of relation.members || []) {
        if (member.type !== 'way') continue;
        const way = ways.get(member.ref);
        if (!way) continue;
        const coords = wayCoordinates(way, nodes);
        if (coords.length < 2) continue;
        if (member.role === 'inner') innerFragments.push(coords);
        else outerFragments.push(coords);
    }

    const outers = mergeLineFragments(outerFragments);
    const inners = mergeLineFragments(innerFragments);
    if (outers.length === 0) return null;

    const polygons = outers.map((outer, index) => {
        const rings = [closeRing([...outer])];
        if (index === 0) {
            rings.push(...inners.map((inner) => closeRing([...inner])));
        }
        return rings;
    });

    return {
        type: 'Feature',
        properties: {
            osm_id: relation.id,
            dataset: dataset.key,
            kind: 'water_relation',
            name: relation.tags?.name || relation.tags?.name_zh || '',
            natural: relation.tags?.natural || '',
            landuse: relation.tags?.landuse || '',
            water: relation.tags?.water || '',
            area_type: relation.tags?.water || relation.tags?.landuse || relation.tags?.natural || 'water',
        },
        geometry: {
            type: polygons.length === 1 ? 'Polygon' : 'MultiPolygon',
            coordinates: polygons.length === 1 ? polygons[0] : polygons,
        },
    };
}

/**
 * 构建build dataset所需的数据结构，供后续查询、渲染或路径计算复用。
 */
function buildDataset(dataset) {
    const inputPath = path.join(sceneDir, dataset.input);
    if (!fs.existsSync(inputPath)) {
        console.warn(`skip ${dataset.key}: missing ${inputPath}`);
        return;
    }

    const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const nodes = new Map();
    const ways = new Map();
    const roads = [];
    const waterways = [];
    const waterAreas = [];
    const relationWaterWayRefs = new Set();

    for (const element of data.elements || []) {
        if (element.type === 'node') {
            nodes.set(element.id, { lon: element.lon, lat: element.lat });
        } else if (element.type === 'way') {
            ways.set(element.id, element);
        }
    }

    for (const element of data.elements || []) {
        if (element.type !== 'relation' || !isWaterArea(element.tags)) continue;
        for (const member of element.members || []) {
            if (member.type === 'way') relationWaterWayRefs.add(member.ref);
        }
        const feature = relationWaterFeature(element, ways, nodes, dataset);
        if (feature) waterAreas.push(feature);
    }

    for (const way of ways.values()) {
        if (!way.tags) continue;

        if (way.tags.highway) {
            const feature = lineFeature(way, nodes, 'road', dataset);
            if (feature) roads.push(feature);
        }

        if (way.tags.waterway) {
            const feature = lineFeature(way, nodes, 'waterway', dataset);
            if (feature) waterways.push(feature);
        }

        if (isWaterArea(way.tags) && !relationWaterWayRefs.has(way.id)) {
            const coordinates = wayCoordinates(way, nodes);
            const feature = waterAreaFeature(way, coordinates, dataset);
            if (feature) waterAreas.push(feature);
        }
    }

    const combinedWater = [...waterways, ...waterAreas];
    writeGeoJson(path.join(sceneDir, dataset.roads), featureCollection(roads, dataset, 'roads'));
    writeGeoJson(path.join(sceneDir, dataset.water), featureCollection(combinedWater, dataset, 'water'));

    if (dataset.waterways) {
        writeGeoJson(path.join(sceneDir, dataset.waterways), featureCollection(waterways, dataset, 'waterways'));
    }
    if (dataset.lakes) {
        writeGeoJson(path.join(sceneDir, dataset.lakes), featureCollection(waterAreas, dataset, 'lakes_and_water_areas'));
    }

    console.log(`${dataset.key} roads: ${roads.length}`);
    console.log(`${dataset.key} waterways: ${waterways.length}`);
    console.log(`${dataset.key} lakes/water areas: ${waterAreas.length}`);
}

/**
 * 写出write geo json结果，供前端场景或后续处理流程使用。
 */
function writeGeoJson(filePath, geojson) {
    fs.writeFileSync(filePath, `${JSON.stringify(geojson, null, 2)}\n`);
    console.log(`  -> ${filePath}`);
}

/**
 * 封装main相关逻辑，保持调用处简洁并便于后续维护。
 */
function main() {
    for (const dataset of DATASETS) {
        buildDataset(dataset);
    }
}

main();

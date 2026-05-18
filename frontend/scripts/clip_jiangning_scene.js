/*
 * @file clip_jiangning_scene.js
 * @author changbai
 * @project 基于GeoSOT空域剖分单元状态管控的低空无人机飞行线路规划系统
 * @date 2026-05-08
 * @description 江宁区域场景数据裁剪脚本，用于按边界裁剪道路、水系等前端展示数据。
 */

const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");

const sceneDir = path.join(__dirname, "..", "public", "scene");
const boundaryFile = path.join(sceneDir, "jiangning_boundary.geojson");
const datasets = [
  "jiangning_roads.geojson",
  "jiangning_water.geojson",
  "jiangning_waterways.geojson",
  "jiangning_lakes.geojson",
];

/**
 * 读取read json输入数据，并做必要的容错处理。
 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * 写出write json结果，供前端场景或后续处理流程使用。
 */
function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data)}\n`);
}

/**
 * 封装feature center point相关逻辑，保持调用处简洁并便于后续维护。
 */
function featureCenterPoint(feature) {
  try {
    return turf.centerOfMass(feature);
  } catch {
    return turf.centroid(feature);
  }
}

/**
 * 封装keep inside polygon相关逻辑，保持调用处简洁并便于后续维护。
 */
function keepInsidePolygon(feature, polygon) {
  const center = featureCenterPoint(feature);
  return turf.booleanPointInPolygon(center, polygon);
}

/**
 * 封装feature coords inside polygon相关逻辑，保持调用处简洁并便于后续维护。
 */
function featureCoordsInsidePolygon(feature, polygon) {
  if (!feature?.geometry?.coordinates) return false;
  let inside = true;
  const visit = (coords) => {
    if (!inside || !Array.isArray(coords)) return;
    if (typeof coords[0] === "number") {
      if (!turf.booleanPointInPolygon(turf.point(coords), polygon, { ignoreBoundary: false })) {
        inside = false;
      }
      return;
    }
    coords.forEach(visit);
  };
  visit(feature.geometry.coordinates);
  return inside;
}

/**
 * 封装clip line feature相关逻辑，保持调用处简洁并便于后续维护。
 */
function clipLineFeature(feature, districtPolygon, districtLine) {
  const coordinateGroups = feature.geometry.type === "MultiLineString"
    ? feature.geometry.coordinates || []
    : [feature.geometry.coordinates || []];
  const kept = [];

  for (const coordinates of coordinateGroups) {
    let current = [];
    for (const coord of coordinates) {
      const inside = turf.booleanPointInPolygon(turf.point(coord), districtPolygon, { ignoreBoundary: false });
      if (inside) {
        current.push(coord);
        continue;
      }
      if (current.length >= 2) kept.push(current);
      current = [];
    }
    if (current.length >= 2) kept.push(current);
  }

  if (kept.length === 0) {
    return featureCoordsInsidePolygon(feature, districtPolygon) ? [feature] : [];
  }

  return kept.map((coordinates) => ({
    type: "Feature",
    properties: { ...(feature.properties || {}) },
    geometry: {
      type: "LineString",
      coordinates,
    },
  }));
}

/**
 * 封装clip polygon feature相关逻辑，保持调用处简洁并便于后续维护。
 */
function clipPolygonFeature(feature, districtPolygon) {
  try {
    const clipped = turf.intersect(turf.featureCollection([districtPolygon, feature]));
    if (!clipped || !clipped.geometry) return [];
    return turf.flatten(clipped).features
      .filter((part) => featureCoordsInsidePolygon(part, districtPolygon))
      .map((part) => ({
        ...part,
        properties: { ...(feature.properties || {}) },
      }));
  } catch {
    return featureCoordsInsidePolygon(feature, districtPolygon) ? [feature] : [];
  }
}

/**
 * 封装clip feature相关逻辑，保持调用处简洁并便于后续维护。
 */
function clipFeature(feature, districtPolygon, districtLine) {
  if (!feature?.geometry) return [];
  const type = feature.geometry.type;
  if (type === "LineString" || type === "MultiLineString") {
    return clipLineFeature(feature, districtPolygon, districtLine);
  }
  if (type === "Polygon" || type === "MultiPolygon") {
    return clipPolygonFeature(feature, districtPolygon);
  }
  return featureCoordsInsidePolygon(feature, districtPolygon) ? [feature] : [];
}

/**
 * 封装clip dataset相关逻辑，保持调用处简洁并便于后续维护。
 */
function clipDataset(filename, districtPolygon, districtLine) {
  const file = path.join(sceneDir, filename);
  const source = readJson(file);
  const features = (source.features || []).flatMap((feature) => clipFeature(feature, districtPolygon, districtLine));
  const next = {
    ...source,
    metadata: {
      ...(source.metadata || {}),
      clippedToBoundary: "320115",
      clippedAt: new Date().toISOString(),
    },
    features,
  };
  writeJson(file, next);
  return {
    file: filename,
    count: features.length,
  };
}

/**
 * 封装main相关逻辑，保持调用处简洁并便于后续维护。
 */
function main() {
  const boundary = readJson(boundaryFile);
  const districtPolygon = boundary.features?.[0];
  if (!districtPolygon) {
    throw new Error("未找到江宁区边界要素");
  }
  const districtLine = turf.polygonToLine(districtPolygon);
  const summary = datasets.map((filename) => clipDataset(filename, districtPolygon, districtLine));
  console.log(JSON.stringify(summary, null, 2));
}

main();

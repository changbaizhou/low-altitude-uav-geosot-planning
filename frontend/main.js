/*
 * @file main.js
 * @author changbai
 * @project 基于GeoSOT空域剖分单元状态管控的低空无人机飞行线路规划系统
 * @date 2026-05-08
 * @description Cesium基础演示入口文件，用于初始化三维地球视图。
 */

import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

const viewer = new Cesium.Viewer('cesiumContainer', {
  animation: false,
  timeline: false
})

viewer.camera.flyTo({
  destination: Cesium.Cartesian3.fromDegrees(
    116.39, // 经度
    39.9,   // 纬度
    10000   // 高度
  )
})

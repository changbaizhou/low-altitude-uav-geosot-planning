<!--
  @file App.vue
  @author changbai
  @project 基于GeoSOT空域剖分单元状态管控的低空无人机飞行线路规划系统
  @date 2026-05-08
  @description 前端主界面组件，负责Cesium三维场景、航线规划、网格状态与管控信息展示。
-->

<template>
  <div class="map-wrapper" @contextmenu.prevent>
    <div ref="cesiumContainer" class="cesium-container"></div>

    <header class="dashboard-header">
      <div class="header-meta">
        <div class="meta-clock">
          <strong>{{ systemTimeText }}</strong>
          <span>{{ systemDateText }}</span>
        </div>
        <div class="meta-weather">
          <strong>{{ weatherInfo.locationName }}</strong>
          <span>{{ weatherInfo.text }} · {{ weatherInfo.temp }}℃ · {{ weatherInfo.wind }}</span>
        </div>
      </div>
      <div class="system-title">
        <h1>无人机低空航线规划系统</h1>
        <span class="system-kicker">GeoSOT UAV AIRSPACE</span>
      </div>
      <div class="header-status">
        <span>网格 {{ gridLevelStr }}</span>
        <span>DEM {{ terrainStatus }}</span>
        <span>{{ altitudeLabel }}</span>
      </div>
    </header>

    <nav class="top-command-bar" aria-label="任务控制">
      <div class="command-group">
        <button type="button" class="plan-btn" @click="setAction('start')" :class="{ active: currentAction === 'start' }">选择起点</button>
        <button type="button" class="plan-btn" @click="setAction('end')" :class="{ active: currentAction === 'end' }">选择终点</button>
        <button type="button" class="plan-btn" @click="triggerPlan" :disabled="planningBusy">
          {{ planningBusy ? '规划中' : '规划路径' }}
        </button>
        <button type="button" class="plan-btn" @click="comparePlans" :disabled="planningBusy">方案对比</button>
        <button type="button" class="clear-btn" @click="clearAll">清除全部</button>
      </div>
    </nav>

    <aside class="dashboard-panel left-panel" :class="{ 'panel-collapsed': leftPanelCollapsed }">
      <section class="panel-section">
        <div class="section-title">图层显示</div>
        <div class="toggle-grid">
          <button type="button" @click="returnInitialView()">初始视野</button>
          <button type="button" @click="toggleTerrain" :class="{ active: showTerrain }">{{ showTerrain ? 'DEM开' : 'DEM关' }}</button>
          <button type="button" @click="toggleRoads" :class="{ active: showRoads }">{{ showRoads ? '道路开' : '道路关' }}</button>
          <button type="button" @click="toggleWater" :class="{ active: showWater }">{{ showWater ? '水系开' : '水系关' }}</button>
          <button type="button" @click="toggleAirspaceGrids" :class="{ active: showAirspaceGrids }">{{ showAirspaceGrids ? '空域开' : '空域关' }}</button>
          <button type="button" @click="toggleL22WeightGrid" :class="{ active: showL22WeightGrid }">{{ showL22WeightGrid ? '权重开' : '权重关' }}</button>
          <button type="button" @click="toggleAirspaceOccupancy" :class="{ active: showAirspaceOccupancy }">{{ showAirspaceOccupancy ? '占用开' : '占用关' }}</button>
          <button type="button" @click="toggleBuildings" :class="{ active: showBuildings }">{{ showBuildings ? '模型开' : '模型关' }}</button>
          <button type="button" @click="togglePath" :class="{ active: showPath }">{{ showPath ? '路径开' : '路径关' }}</button>
        </div>
        <label class="field-label" id="grid-level-label">网格层级</label>
        <div class="level-picker">
          <button
            type="button"
            class="level-toggle"
            :class="{ active: levelMenuOpen }"
            aria-haspopup="listbox"
            :aria-expanded="levelMenuOpen ? 'true' : 'false'"
            aria-labelledby="grid-level-label"
            @click="toggleLevelMenu"
            @keydown.escape="levelMenuOpen = false"
          >
            <span>{{ GRID_CONFIG[currentGridLevel]?.label || currentGridLevel }}</span>
            <small>{{ gridLevelMetricText(GRID_CONFIG[currentGridLevel]) }}</small>
            <i aria-hidden="true"></i>
          </button>
          <div class="level-menu" v-if="levelMenuOpen" role="listbox" aria-labelledby="grid-level-label">
            <button
              type="button"
              class="level-option"
              v-for="level in availableGridLevels"
              :key="level.key"
              :class="{ active: currentGridLevel === level.key }"
              role="option"
              :aria-selected="currentGridLevel === level.key ? 'true' : 'false'"
              @click="chooseLevelOption(level.key)"
            >
              <span>{{ level.label }}</span>
              <small>{{ gridLevelMetricText(level) }}</small>
            </button>
          </div>
        </div>
      </section>

      <section class="panel-section">
        <div class="section-title">高度参数</div>
        <div class="range-control">
          <label>飞行/网格高度</label>
          <input
            type="range"
            min="0"
            :max="altitudeSliderMax"
            :step="altitudeSliderStep"
            v-model.number="targetAltitude"
            @change="refreshCurrentGrid"
          />
          <span>{{ altitudeLabel }}</span>
        </div>
        <div class="range-control terrain-row">
          <label>地形跟随</label>
          <input type="checkbox" v-model="terrainFollowEnabled" />
          <input type="range" min="30" max="120" step="10" v-model.number="minAgl" />
          <span>{{ minAgl }} m</span>
        </div>
      </section>

      <section class="panel-section weather-control-section" v-if="activeControlPanel === 'weather' && !selectedGridHistory">
        <div class="section-title">
          <span>气象管控</span>
          <div class="section-actions">
            <button type="button" class="section-refresh" @click="activeControlPanel = 'control'">临时管控</button>
            <button type="button" class="section-refresh" @click="loadWeatherControlStatus" :disabled="weatherControl.loading">刷新</button>
          </div>
        </div>
        <div class="weather-control-card" :class="{ active: weatherControl.action !== 'none' }">
          <div>
            <span>{{ weatherControl.modeLabel }}</span>
            <strong>{{ weatherControl.affectedGridCount }} / {{ weatherControl.totalGridCount }} 格</strong>
          </div>
          <small>{{ weatherControl.reason }}</small>
        </div>
        <div class="action-grid three-columns weather-control-actions">
          <button type="button" class="plan-btn" @click="syncWeatherControl" :disabled="weatherControl.loading">同步</button>
          <button type="button" @click="clearWeatherControl" :disabled="weatherControl.loading">解除</button>
          <button type="button" @click="toggleWeatherControlAuto" :class="{ active: weatherControlAutoEnabled }">
            {{ weatherControlAutoEnabled ? '自动开' : '自动关' }}
          </button>
        </div>
      </section>

      <section class="panel-section control-area-section" v-if="activeControlPanel === 'control' || selectedGridHistory">
        <div class="section-title">
          <span>{{ selectedGridHistory ? '网格状态历史' : '管控区域' }}</span>
          <button v-if="selectedGridHistory" type="button" class="section-refresh" @click="clearGridHistory">返回管控区</button>
          <div class="section-actions" v-else>
            <button type="button" class="section-refresh" @click="activeControlPanel = 'weather'">气象管控</button>
            <div class="section-pager" v-if="controlAreas.length > CONTROL_AREA_PAGE_SIZE">
              <button type="button" @click="changeControlAreaPage(-1)" :disabled="controlAreaPage <= 0">‹</button>
              <em>{{ controlAreaPage + 1 }}/{{ controlAreaPageCount }}</em>
              <button type="button" @click="changeControlAreaPage(1)" :disabled="controlAreaPage >= controlAreaPageCount - 1">›</button>
            </div>
          </div>
        </div>
        <div class="grid-state-detail" v-if="selectedGridHistory">
          <div class="grid-history-summary">
            <strong>{{ selectedGridHistory.geosotId }}</strong>
            <small>{{ selectedGridHistory.level }} · {{ selectedGridHistory.altitudeRange }} · {{ selectedGridHistory.statusText }}</small>
          </div>
          <div class="grid-history-meta">
            <span>{{ selectedGridHistory.surfaceTypeText }}</span>
            <span>权重 {{ selectedGridHistory.flyWeight }}</span>
            <span>地物 {{ selectedGridHistory.surfaceWeight }}</span>
            <span>流量 {{ selectedGridHistory.trafficDensity }}</span>
            <span>{{ selectedGridHistory.weatherLimit ? '气象限制' : '气象正常' }}</span>
          </div>
          <div class="grid-state-editor">
            <div class="grid-state-title">
              <span>状态调整</span>
              <small>{{ gridStateMessage || '保存后写入状态历史' }}</small>
            </div>
            <div class="grid-state-toggle">
              <button type="button" :class="{ active: gridStateForm.status === 0 }" @click="setGridStateStatus(0)">可飞</button>
              <button type="button" :class="{ active: gridStateForm.status === 1 }" @click="setGridStateStatus(1)">受限</button>
            </div>
            <div class="grid-state-inputs">
              <label>
                <span>权重</span>
                <input type="number" min="0.1" max="9.99" step="0.1" v-model.number="gridStateForm.flyWeight" />
              </label>
              <label>
                <span>流量</span>
                <input type="number" min="0" max="99.99" step="1" v-model.number="gridStateForm.trafficDensity" />
              </label>
            </div>
            <label class="grid-state-check">
              <input type="checkbox" v-model="gridStateForm.weatherLimit" />
              <span>气象限制</span>
            </label>
            <input class="grid-state-reason" type="text" v-model="gridStateForm.reason" placeholder="更新原因" />
            <button type="button" class="grid-state-save" @click="submitGridStateUpdate" :disabled="gridStateSaving">
              {{ gridStateSaving ? '保存中' : '保存状态' }}
            </button>
          </div>
          <div class="spatiotemporal-index-card">
            <div>
              <span>空间索引</span>
              <strong>{{ selectedGridHistory.surfaceCode }}</strong>
            </div>
            <div>
              <span>高程索引</span>
              <strong>{{ selectedGridHistory.altitudeLayer }}</strong>
            </div>
            <div>
              <span>时间索引</span>
              <strong>{{ selectedGridHistory.timeIndexText }}</strong>
            </div>
            <small>GeoSOT以平面编码定位网格，以Z层表达高度，以状态历史和管控时间窗表达时间维变化。</small>
          </div>
        </div>
        <template v-else>
          <input
            class="control-input"
            type="text"
            v-model="controlAreaName"
            placeholder="管控区名称"
            :disabled="controlAreaLoading"
          />
          <div class="time-grid">
            <label>
              <span>开始</span>
              <input type="datetime-local" v-model="controlAreaStartAt" :disabled="controlAreaLoading" />
            </label>
            <label>
              <span>结束</span>
              <input type="datetime-local" v-model="controlAreaEndAt" :disabled="controlAreaLoading" />
            </label>
          </div>
          <div class="action-grid two-columns">
            <button type="button" @click="toggleControlAreaDrawing" :class="{ active: controlAreaDrawing }" :disabled="controlAreaLoading">
              {{ controlAreaDrawing ? '绘制中' : '绘制矩形' }}
            </button>
            <button type="button" class="plan-btn" @click="saveControlArea" :disabled="controlAreaLoading || !controlAreaDraftBounds">
              保存管控
            </button>
            <button type="button" @click="clearControlAreaDraft" :disabled="controlAreaLoading">清除草图</button>
            <button type="button" @click="loadControlAreas" :disabled="controlAreaLoading">刷新列表</button>
          </div>
          <div class="control-hint">{{ controlAreaHint }}</div>
          <div class="control-area-list" v-if="controlAreas.length">
            <div
              class="control-area-row"
              v-for="area in visibleControlAreas"
              :key="area.id"
              :class="{ active: activeControlAreaReplayId === area.id, live: area.active_now }"
            >
              <button type="button" class="control-area-main" @click="toggleControlAreaReplay(area)">
                <span>{{ area.name }}</span>
                <small>{{ activeControlAreaReplayId === area.id ? '点击隐藏' : '点击复现' }} · {{ controlAreaTimeLabel(area) }} · {{ area.affected_grid_count }}格</small>
              </button>
              <button type="button" class="control-area-delete" @click.stop="deleteControlArea(area)" :disabled="controlAreaLoading">×</button>
            </div>
          </div>
          <div class="control-empty" v-else>暂无管控区</div>
        </template>
      </section>

    </aside>

    <div class="floating-status-bar" v-if="currentAction">
      {{ currentAction === 'start' ? '请在地图上点击位置作为起点' : '请在地图上点击位置作为终点' }}
    </div>

    <aside class="dashboard-panel right-panel" :class="{ 'panel-collapsed': rightPanelCollapsed }">
      <div class="right-panel-main">
        <section class="panel-section">
          <div class="section-title">实时监控</div>
          <div class="metric-grid">
            <div class="metric-tile accent-cyan">
              <span>视角高度</span>
              <strong>{{ cameraAlt }}</strong>
              <em>m</em>
            </div>
            <div class="metric-tile accent-green">
              <span>路径长度</span>
              <strong>{{ pathLen }}</strong>
              <em>m</em>
            </div>
            <div class="metric-tile accent-yellow">
              <span>经过网格</span>
              <strong>{{ routeGridCount }}</strong>
              <em>格</em>
            </div>
            <div class="metric-tile accent-orange">
              <span>风险等级</span>
              <strong>{{ routeRisk }}</strong>
              <em>{{ routeRiskScore }}</em>
            </div>
          </div>
          <ul class="status-list">
            <li><span>最大垂直速度</span><b>{{ maxVerticalRate }} m/s</b></li>
            <li><span>预计飞行时长</span><b>{{ flightTime }} s</b></li>
            <li><span>算法寻路耗时</span><b>{{ pathTime }} ms</b></li>
            <li><span>地形数据</span><b>{{ terrainStatus }}</b></li>
            <li><span>空域占用</span><b>{{ occupancyStatsText }}</b></li>
          </ul>
        </section>

        <section class="panel-section helipad-section">
          <div class="section-title">
            <span>停机坪管理</span>
            <div class="section-pager" v-if="helipads.length > HELIPAD_PAGE_SIZE">
              <button type="button" @click="changeHelipadPage(-1)" :disabled="helipadPage <= 0">‹</button>
              <em>{{ helipadPage + 1 }}/{{ helipadPageCount }}</em>
              <button type="button" @click="changeHelipadPage(1)" :disabled="helipadPage >= helipadPageCount - 1">›</button>
            </div>
          </div>
        <div class="helipad-overview">
          <span>停机坪数量</span>
          <strong>{{ helipads.length }}</strong>
          <em>{{ helipadModeText }}</em>
        </div>
        <div class="helipad-toggle-row">
          <button
            type="button"
            class="helipad-visibility-btn"
            :class="{ active: showHelipads }"
            @click="toggleHelipads"
          >
            {{ showHelipads ? "停机坪显示开" : "停机坪显示关" }}
          </button>
        </div>
        <div class="action-grid two-columns helipad-actions">
          <button type="button" @click="setHelipadMode('add')" :class="{ active: helipadEditMode === 'add' }" :disabled="helipadLoading">添加停机坪</button>
          <button type="button" @click="setHelipadMode('delete')" :class="{ active: helipadEditMode === 'delete' }" :disabled="helipadLoading">删除停机坪</button>
        </div>
          <div class="helipad-hint">{{ helipadHint }}</div>
          <div class="helipad-detail" v-if="showHelipads && selectedHelipad">
            <div>
              <span>当前停机坪</span>
              <strong>{{ selectedHelipad.code }} · {{ selectedHelipad.name }}</strong>
            </div>
            <small>经度 {{ selectedHelipad.lon.toFixed(6) }}</small>
            <small>纬度 {{ selectedHelipad.lat.toFixed(6) }}</small>
            <small>高度 {{ selectedHelipad.alt.toFixed(0) }}m · {{ selectedHelipad.status }}</small>
          </div>
          <div class="helipad-list" v-if="showHelipads && helipads.length">
            <button
              type="button"
              class="helipad-row"
              v-for="pad in visibleHelipads"
              :key="pad.id"
              :class="{ active: selectedHelipadIds.includes(pad.id) }"
              @click="focusHelipad(pad)"
            >
              <span>{{ pad.code }} · {{ pad.name }}</span>
              <small>{{ pad.lon.toFixed(6) }}, {{ pad.lat.toFixed(6) }} · {{ pad.alt.toFixed(0) }}m</small>
            </button>
          </div>
          <div class="helipad-empty" v-else-if="showHelipads">暂无停机坪</div>
        </section>

      </div>

      <section class="panel-section route-archive" :class="{ 'comparison-mode': planComparisons.length }">
        <div class="archive-header">
          <span>
            {{ planComparisons.length ? '方案对比结果' : '已保存路径' }}
            <small v-if="planComparisons.length">改进A*三目标 / Dijkstra基线</small>
          </span>
          <div class="archive-tools" v-if="planComparisons.length">
            <button type="button" class="archive-close-btn" @click="closePlanComparison">关闭</button>
          </div>
          <div class="archive-tools" v-else>
            <button type="button" @click="changeRouteArchivePage(-1)" :disabled="routeArchivePage <= 0">‹</button>
            <em>{{ routeArchivePage + 1 }}/{{ routeArchivePageCount }}</em>
            <button type="button" @click="changeRouteArchivePage(1)" :disabled="routeArchivePage >= routeArchivePageCount - 1">›</button>
            <button type="button" @click="loadSavedRoutes" :disabled="routeArchiveLoading">刷新</button>
          </div>
        </div>
        <template v-if="planComparisons.length">
          <div class="comparison-results">
            <div class="comparison-row" v-for="item in planComparisons" :key="item.objective" :class="{ failed: item.status === 'failed' }">
              <span>
                {{ item.name }}
                <b v-if="item.rendered">当前显示</b>
              </span>
              <strong>{{ item.status === 'failed' ? '--' : `${item.distance}m / ${item.seconds}s` }}</strong>
              <em>{{ item.status === 'failed' ? item.message : `${comparisonAlgorithmText(item.algorithm)} · 搜索${item.searchedGrids}格 · 原始${item.rawGrids}格` }}</em>
              <small v-if="item.status !== 'failed'">风险{{ item.riskScore }} · 耗时{{ item.elapsedMs }}ms · 走廊{{ item.grids }}格 · {{ item.waypoints }}点</small>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="archive-message" v-if="routeArchiveLoading">读取中...</div>
          <div class="archive-message" v-else-if="!savedRoutes.length">暂无保存路径</div>
          <button
            v-else
            type="button"
            class="archive-row"
            v-for="route in visibleSavedRoutes"
            :key="route.id"
            :class="{ active: activeSavedRouteId === route.id }"
            @click="toggleSavedRouteReplay(route.id)"
          >
            <span>{{ archiveRouteDisplayName(route) }}</span>
            <small>{{ activeSavedRouteId === route.id ? '点击隐藏' : '点击复现' }} · {{ formatRouteTime(route.created_at) }} · {{ Number(route.distance_m || 0).toFixed(0) }}m · {{ route.grid_count }}格</small>
          </button>
        </template>
      </section>
    </aside>

    <div class="center-bottom-stack" :class="{ 'panel-collapsed': statsPanelCollapsed }">
      <div class="coordinate-panel">
        <span>经度 {{ mouseLon }}</span>
        <span>纬度 {{ mouseLat }}</span>
        <span>海拔 {{ mouseAlt }} m</span>
        <span>比例尺 {{ scaleText }}</span>
      </div>

      <section class="panel-section stats-section center-stats-section">
        <div class="section-title">
          <span>运行统计</span>
          <button type="button" class="section-refresh" @click="loadDashboardStats" :disabled="statsLoading">刷新</button>
        </div>
        <div class="stats-summary">
          <div>
            <span>累计飞行</span>
            <strong>{{ dashboardTotals.total_flights }}</strong>
            <em>次</em>
          </div>
          <div>
            <span>累计里程</span>
            <strong>{{ totalDistanceKm }}</strong>
            <em>km</em>
          </div>
        </div>
        <div class="mini-chart flight-chart">
          <div class="chart-head">
            <span>飞行次数</span>
            <b>柱状图</b>
          </div>
          <div class="bar-chart" aria-label="最近七天每天飞行次数柱状图">
            <span
              v-for="item in flightCountBars"
              :key="`flight-${item.label}`"
              class="bar-column cyan"
              :class="{ active: isChartHover(`flight-${item.label}`) }"
              tabindex="0"
              :aria-label="`${item.label} 飞行 ${item.value} 次`"
              @pointerenter="showChartTooltip($event, makeDailyChartPayload('flight', item))"
              @pointermove="moveChartTooltip($event)"
              @pointerleave="hideChartTooltip"
              @focus="showChartTooltip($event, makeDailyChartPayload('flight', item))"
              @blur="hideChartTooltip"
            >
              <i :style="{ height: `${item.height}%` }"></i>
              <em>{{ item.label.slice(3) }}</em>
            </span>
          </div>
        </div>
        <div class="mini-chart distance-chart">
          <div class="chart-head">
            <span>飞行里程</span>
            <b>面积折线图</b>
          </div>
          <svg class="line-chart" viewBox="0 0 240 70" preserveAspectRatio="none" aria-label="最近七天飞行里程面积折线图">
            <polygon :points="distanceAreaPoints" class="line-area"></polygon>
            <polyline :points="distanceLinePoints" class="line-path"></polyline>
            <circle
              v-for="point in distancePlotPoints"
              :key="`distance-${point.label}`"
              class="line-hit"
              :class="{ active: isChartHover(`distance-${point.label}`) }"
              :cx="point.x"
              :cy="point.y"
              r="9"
              tabindex="0"
              :aria-label="`${point.label} 飞行里程 ${formatDistanceValue(point.value)}`"
              @pointerenter="showChartTooltip($event, makeDistanceChartPayload(point))"
              @pointermove="moveChartTooltip($event)"
              @pointerleave="hideChartTooltip"
              @focus="showChartTooltip($event, makeDistanceChartPayload(point))"
              @blur="hideChartTooltip"
            />
            <circle
              v-for="point in distancePlotPoints"
              :key="`distance-dot-${point.label}`"
              :cx="point.x"
              :cy="point.y"
              :r="isChartHover(`distance-${point.label}`) ? 4.6 : 2.8"
              class="line-dot"
              :class="{ active: isChartHover(`distance-${point.label}`) }"
            />
          </svg>
        </div>
        <div class="mini-chart grid-chart">
          <div class="chart-head">
            <span>占用网格数</span>
            <b>柱状图</b>
          </div>
          <div class="bar-chart compact" aria-label="最近七天占用网格数柱状图">
            <span
              v-for="item in gridCountBars"
              :key="`grid-${item.label}`"
              class="bar-column green"
              :class="{ active: isChartHover(`grid-${item.label}`) }"
              tabindex="0"
              :aria-label="`${item.label} 占用网格 ${item.value} 格`"
              @pointerenter="showChartTooltip($event, makeDailyChartPayload('grid', item))"
              @pointermove="moveChartTooltip($event)"
              @pointerleave="hideChartTooltip"
              @focus="showChartTooltip($event, makeDailyChartPayload('grid', item))"
              @blur="hideChartTooltip"
            >
              <i :style="{ height: `${item.height}%` }"></i>
              <em>{{ item.label.slice(3) }}</em>
            </span>
          </div>
        </div>
        <div class="control-stat-card">
          <div
            class="donut-chart"
            :class="{ active: isChartHover('control-total') }"
            :style="controlDonutStyle"
            tabindex="0"
            aria-label="临时管控区统计"
            @pointerenter="showChartTooltip($event, makeControlTotalPayload())"
            @pointermove="moveChartTooltip($event)"
            @pointerleave="hideChartTooltip"
            @focus="showChartTooltip($event, makeControlTotalPayload())"
            @blur="hideChartTooltip"
          >
            <span>{{ dashboardControl.active_count }}</span>
            <em>管控中</em>
          </div>
          <div class="control-stat-list">
            <span
              v-for="item in controlStatItems"
              :key="item.key"
              class="control-stat-item"
              :class="{ active: isChartHover(item.key) }"
              tabindex="0"
              :aria-label="`${item.label} ${item.value} 个`"
              @pointerenter="showChartTooltip($event, makeControlItemPayload(item))"
              @pointermove="moveChartTooltip($event)"
              @pointerleave="hideChartTooltip"
              @focus="showChartTooltip($event, makeControlItemPayload(item))"
              @blur="hideChartTooltip"
            >
              <i :class="item.dotClass"></i>{{ item.label }} <b>{{ item.value }}</b>
            </span>
            <small>环形占比图 · 当前禁飞 {{ dashboardControl.active_grid_count }} 格</small>
          </div>
        </div>
        <div v-if="chartHover" class="chart-tooltip" :style="chartTooltipStyle" role="tooltip">
          <strong>{{ chartHover.title }}</strong>
          <span>{{ chartHover.value }}</span>
          <em>{{ chartHover.note }}</em>
        </div>
      </section>
    </div>

    <button
      type="button"
      class="panel-edge-toggle left-edge-toggle"
      :class="{ collapsed: leftPanelCollapsed }"
      :aria-label="leftPanelCollapsed ? '显示左侧面板' : '隐藏左侧面板'"
      :title="leftPanelCollapsed ? '显示左侧面板' : '隐藏左侧面板'"
      @click="leftPanelCollapsed = !leftPanelCollapsed"
    >
      {{ leftPanelCollapsed ? '›' : '‹' }}
    </button>
    <button
      type="button"
      class="panel-edge-toggle right-edge-toggle"
      :class="{ collapsed: rightPanelCollapsed }"
      :aria-label="rightPanelCollapsed ? '显示右侧面板' : '隐藏右侧面板'"
      :title="rightPanelCollapsed ? '显示右侧面板' : '隐藏右侧面板'"
      @click="rightPanelCollapsed = !rightPanelCollapsed"
    >
      {{ rightPanelCollapsed ? '‹' : '›' }}
    </button>
    <button
      type="button"
      class="panel-edge-toggle bottom-edge-toggle"
      :class="{ collapsed: statsPanelCollapsed }"
      :aria-label="statsPanelCollapsed ? '显示运行统计' : '隐藏运行统计'"
      :title="statsPanelCollapsed ? '显示运行统计' : '隐藏运行统计'"
      @click="statsPanelCollapsed = !statsPanelCollapsed"
    >
      {{ statsPanelCollapsed ? '⌃' : '⌄' }}
    </button>

    <div
      v-if="missionPointInfoPopup.visible"
      class="helipad-info-popup mission-point-info-popup"
      :style="{ left: `${missionPointInfoPopup.x}px`, top: `${missionPointInfoPopup.y}px` }"
    >
      <button type="button" class="popup-close" @click="hideMissionPointInfoPopup">×</button>
      <div class="popup-title">
        <span>{{ missionPointInfoPopup.type === 'start' ? '起点属性' : '终点属性' }}</span>
        <strong>{{ missionPointInfoPopup.type === 'start' ? '规划起点' : '规划终点' }}</strong>
      </div>
      <dl>
        <div>
          <dt>经度</dt>
          <dd>{{ missionPointInfoPopup.point?.lon.toFixed(6) }}</dd>
        </div>
        <div>
          <dt>纬度</dt>
          <dd>{{ missionPointInfoPopup.point?.lat.toFixed(6) }}</dd>
        </div>
        <div>
          <dt>高度</dt>
          <dd>{{ Number(missionPointInfoPopup.point?.alt || 0).toFixed(0) }} m</dd>
        </div>
        <div>
          <dt>网格层级</dt>
          <dd>{{ missionPointInfoPopup.gridLevel }}</dd>
        </div>
      </dl>
    </div>

    <div
      v-if="helipadContextMenu.visible"
      class="helipad-context-menu"
      :style="{ left: `${helipadContextMenu.x}px`, top: `${helipadContextMenu.y}px` }"
    >
      <div class="context-title">
        <span>{{ helipadContextMenu.pad?.code }}</span>
        <strong>{{ helipadContextMenu.pad?.name }}</strong>
      </div>
      <button type="button" @click="setHelipadAsMissionPoint('start')">设为起点</button>
      <button type="button" @click="setHelipadAsMissionPoint('end')">设为终点</button>
      <button
        type="button"
        v-if="canReturnFromHelipad(helipadContextMenu.pad)"
        @click="returnFromHelipad"
      >
        一键返航
      </button>
      <button
        type="button"
        class="danger"
        v-if="helipadEditMode === 'delete'"
        @click="deleteContextHelipad"
      >
        删除停机坪
      </button>
    </div>

    <div
      v-if="helipadInfoPopup.visible"
      class="helipad-info-popup"
      :style="{ left: `${helipadInfoPopup.x}px`, top: `${helipadInfoPopup.y}px` }"
    >
      <button type="button" class="popup-close" @click="hideHelipadInfoPopup">×</button>
      <div class="popup-title">
        <span>{{ helipadInfoPopup.pad?.code }}</span>
        <strong>{{ helipadInfoPopup.pad?.name }}</strong>
      </div>
      <dl>
        <div>
          <dt>经度</dt>
          <dd>{{ helipadInfoPopup.pad?.lon.toFixed(6) }}</dd>
        </div>
        <div>
          <dt>纬度</dt>
          <dd>{{ helipadInfoPopup.pad?.lat.toFixed(6) }}</dd>
        </div>
        <div>
          <dt>高度</dt>
          <dd>{{ helipadInfoPopup.pad?.alt.toFixed(0) }} m</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{{ helipadInfoPopup.pad?.status }}</dd>
        </div>
      </dl>
      <p v-if="helipadInfoPopup.pad?.notes">{{ helipadInfoPopup.pad.notes }}</p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

const cesiumContainer = ref(null);
let viewer = null;
// 默认按当前前端主机推导后端地址，Windows 本机和局域网演示都可以少改一处配置。
const API_BASE = import.meta.env.VITE_API_BASE
  || (typeof window !== "undefined" && window.location.hostname
    ? `${window.location.protocol}//${window.location.hostname}:3000`
    : "http://localhost:3000");
const SCENE_DATA = {
  label: "南京市江宁区",
  boundary: "/scene/jiangning_boundary.geojson",
  roads: "/scene/jiangning_roads.geojson",
  water: "/scene/jiangning_water.geojson",
  waterways: "/scene/jiangning_waterways.geojson",
  lakes: "/scene/jiangning_lakes.geojson",
};

const NANJING_BOUNDS = { minLon: 118.35, minLat: 31.25, maxLon: 119.25, maxLat: 32.45 };
const JIANGNING_BOUNDS = { minLon: 118.480158, minLat: 31.616368, maxLon: 119.123664, maxLat: 32.111727 };
const FINE_BOUNDS = { minLon: 118.776062, minLat: 31.913200, maxLon: 118.786048, maxLat: 31.919645 };
const L19_PLANNING_BOUNDS = JIANGNING_BOUNDS;
const GRID_RENDER_LIMIT = 8000;
const L22_ALL_LAYER_GRID_LIMIT = 40000;
const EARTH_RADIUS_M = 6378137;
const DEG_TO_RAD = Math.PI / 180;
const VERTICAL_REFERENCE_LATITUDE = 32;
const MIN_OPERATIONAL_GEOSOT_LEVEL = 15;
const MIN_GEOSOT_DOMAIN = -256;
const MAX_GEOSOT_DOMAIN = 256;
const GRID_LOD_RULES = [
  { minCameraHeight: 60000, level: "L15" },
  { minCameraHeight: 30000, level: "L16" },
  { minCameraHeight: 12000, level: "L17" },
  { minCameraHeight: 6000, level: "L18" },
  { minCameraHeight: 2500, level: "L19" },
  { minCameraHeight: 1200, level: "L20" },
  { minCameraHeight: 500, level: "L21" },
  { minCameraHeight: 0, level: "L22" },
];

// 视野和网格范围分为三级：市域用于概览，江宁区用于巡检，示例大学区域用于精细航线规划。
const INITIAL_VIEW = {
  lon: 118.801911,
  lat: 31.864047,
  height: 90000,
  pitchDeg: -90,
  duration: 1.6,
};

/**
 * 封装make level config相关逻辑，保持调用处简洁并便于后续维护。
 */
function makeLevelConfig(level) {
  const key = `L${level}`;
  const bounds = level >= 22 ? FINE_BOUNDS : (level >= 14 ? JIANGNING_BOUNDS : NANJING_BOUNDS);
  const verticalStep = levelNominalMeters(level, VERTICAL_REFERENCE_LATITUDE);
  const baseMaxAltitude = level >= 22 ? 120 : (level >= 17 ? 300 : 1000);
  const maxAltitude = roundMeters(Math.max(1, Math.ceil(baseMaxAltitude / verticalStep)) * verticalStep);
  return { key, label: `GeoSOT-L${level}`, maxAltitude, verticalStep, bounds };
}

/**
 * 封装round meters相关逻辑，保持调用处简洁并便于后续维护。
 */
function roundMeters(value) {
  return Number(Number(value).toFixed(3));
}

/**
 * 封装cell size degrees for level相关逻辑，保持调用处简洁并便于后续维护。
 */
function cellSizeDegreesForLevel(level) {
  if (level <= 9) return 2 ** (9 - level);
  if (level <= 15) return (2 ** (15 - level)) / 60;
  if (level <= 21) return (2 ** (21 - level)) / 3600;
  return 1 / ((2 ** (level - 21)) * 3600);
}

/**
 * 封装level nominal meters相关逻辑，保持调用处简洁并便于后续维护。
 */
function levelNominalMeters(level, latitude = VERTICAL_REFERENCE_LATITUDE) {
  const stepDeg = cellSizeDegreesForLevel(level);
  const latMeters = stepDeg * (Math.PI * EARTH_RADIUS_M / 180);
  const lonMeters = latMeters * Math.cos(latitude * DEG_TO_RAD);
  return roundMeters(Math.sqrt(Math.abs(latMeters * lonMeters)));
}

const GRID_CONFIG = Object.fromEntries(
  Array.from({ length: 22 }, (_, index) => {
    const config = makeLevelConfig(index + 1);
    return [config.key, config];
  }),
);

/**
 * 封装geosot level number相关逻辑，保持调用处简洁并便于后续维护。
 */
function geosotLevelNumber(levelKey) {
  const match = String(levelKey || "").match(/\d+/);
  return match ? Number(match[0]) : 0;
}

/**
 * 判断is operational grid level条件是否成立，供上层流程决定是否继续执行。
 */
function isOperationalGridLevel(level) {
  return geosotLevelNumber(level?.key || level) >= MIN_OPERATIONAL_GEOSOT_LEVEL;
}

/**
 * 封装grid level for camera height相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridLevelForCameraHeight(height) {
  const cameraHeight = Number(height || 0);
  const rule = GRID_LOD_RULES.find((item) => cameraHeight >= item.minCameraHeight);
  return rule?.level || "L22";
}

/**
 * 封装sync grid level to camera height相关逻辑，保持调用处简洁并便于后续维护。
 */
function syncGridLevelToCameraHeight(height) {
  if (manualGridLevelLocked.value && GRID_CONFIG[currentGridLevel.value]) {
    gridLevelStr.value = GRID_CONFIG[currentGridLevel.value]?.label || currentGridLevel.value;
    return currentGridLevel.value;
  }
  const level = gridLevelForCameraHeight(height);
  if (!GRID_CONFIG[level] || !isOperationalGridLevel(level)) return currentGridLevel.value;
  if (currentGridLevel.value !== level) {
    currentGridLevel.value = level;
    clampTargetAltitudeToCurrentLevel();
  }
  gridLevelStr.value = GRID_CONFIG[level]?.label || level;
  return level;
}

const UAV_PROFILE = {
  cruiseAltitude: 80,
  cruiseSpeed: 18,
  climbRate: 3,
  descendRate: 2.5,
  turnRadius: 45,
};

const OBJECTIVE_LABELS = {
  balanced: "综合最优",
  shortest: "最短距离",
  safest: "最低风险",
  baseline: "基线Dijkstra",
};
const COMPARISON_OBJECTIVES = ["balanced", "shortest", "safest", "baseline"];
const L22_DIRECT_DISTANCE_M = 2500;
const L22_TERMINAL_DISTANCE_M = 160;
const DEFAULT_TERMINAL_DISTANCE_M = 450;

/**
 * 封装comparison algorithm text相关逻辑，保持调用处简洁并便于后续维护。
 */
function comparisonAlgorithmText(value) {
  return value === "baseline-dijkstra" ? "Dijkstra基线" : "改进A*";
}

const CONTROL_AREA_PAGE_SIZE = 2;
const HELIPAD_PAGE_SIZE = 4;
const ROUTE_ARCHIVE_PAGE_SIZE = 4;

// 当前任务状态。Cesium 标注和航线由多个 entity 组成，需要保存引用以便统一清理和重绘。
const currentAction = ref(null); 
const planningBusy = ref(false);
const leftPanelCollapsed = ref(false);
const rightPanelCollapsed = ref(false);
const statsPanelCollapsed = ref(false);
let startCoords = null;          
let endCoords = null;            
let startEntity = null;          
let endEntity = null;            
let currentPathEntities = [];    
let activeRouteRender = null;
const currentGridLevel = ref(gridLevelForCameraHeight(INITIAL_VIEW.height));
// 手动选择层级只覆盖当前视野；用户再次缩放或拖动地图后恢复按相机高度自动切换。
const manualGridLevelLocked = ref(false);
const levelMenuOpen = ref(false);
const targetAltitude = ref(30);//目标设定高度，默认30m
const terrainFollowEnabled = ref(true);
const minAgl = ref(60);

// 图层开关只控制显示，不改变数据库中的网格状态。
const showAirspaceGrids = ref(false);
const showObstacleGrids = ref(false);
const showL22WeightGrid = ref(false);
const showAirspaceOccupancy = ref(false);
const showBuildings = ref(true);
const showPath = ref(true);
const showTerrain = ref(true);
const showRoads = ref(true);
const showWater = ref(true);

// Cesium 数据源统一保存在这里，避免重复加载后无法释放旧图层。
let gridDataSource = null; 
let gridLineDataSource = null;
let l22WeightGridDataSource = null;
let airspaceOccupancyDataSource = null;
let airspaceOccupancyLoading = false;
let occupancyClockSyncLastMs = 0;
let gridRenderRequestId = 0;
let obstacleDataSource = null;
let buildingTileset = null;
let jiangningBoundaryDataSource = null;
let roadDataSource = null;
let waterDataSource = null;
let highlightedGridEntity = null;
let demTerrainProvider = null;
let ellipsoidTerrainProvider = null;
let currentViewBounds = null;
const terrainHeightCache = new Map();

// 停机坪、临时管控、右键菜单和弹窗状态共用 Cesium 拾取结果，因此放在同一组维护。
const helipads = ref([]);
const helipadPage = ref(0);
const helipadLoading = ref(false);
const helipadEditMode = ref(null);
const helipadStatus = ref("");
const showHelipads = ref(true);
const selectedHelipadIds = ref([]);
const selectedHelipad = ref(null);
const helipadContextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  pad: null,
});
const helipadInfoPopup = ref({
  visible: false,
  x: 0,
  y: 0,
  pad: null,
});
const missionPointInfoPopup = ref({
  visible: false,
  x: 0,
  y: 0,
  type: null,
  point: null,
  gridLevel: "",
});
const lastCompletedHelipadRoute = ref(null);
const missionStartHelipad = ref(null);
const missionEndHelipad = ref(null);
let helipadDataSource = null;
let helipadSelection = [];
let helipadPopupRenderListener = null;

const controlAreas = ref([]);
const controlAreaPage = ref(0);
const controlAreaLoading = ref(false);
const controlAreaDrawing = ref(false);
const controlAreaName = ref("临时管控区");
const controlAreaStartAt = ref(formatDatetimeLocal(new Date()));
const controlAreaEndAt = ref(formatDatetimeLocal(new Date(Date.now() + 2 * 60 * 60 * 1000)));
const controlAreaDraftBounds = ref(null);
const controlAreaStatus = ref("");
const activeControlAreaReplayId = ref(null);
const activeControlPanel = ref("weather");
let controlAreaDataSource = null;
let controlAreaReplayDataSource = null;
let controlAreaDraftEntity = null;
let controlAreaDragStart = null;

const helipadModeText = computed(() => {
  if (helipadLoading.value) return "同步中";
  if (helipadEditMode.value === "add") return "添加模式";
  if (helipadEditMode.value === "delete") return "删除模式";
  if (startCoords && endCoords) return "待规划";
  if (selectedHelipadIds.value.length === 1) return "已选端点";
  if (selectedHelipadIds.value.length === 2) return "航线端点";
  return "右键设点";
});

const helipadHint = computed(() => {
  if (helipadEditMode.value === "add") return "在地图空白位置点击，即可新增停机坪";
  if (helipadEditMode.value === "delete") return "右键点击地图上的停机坪，可从菜单中删除";
  if (startCoords && endCoords) return "起点和终点已设置，点击左侧“规划路径”开始规划";
  return "左键查看属性，右键选择“设为起点”或“设为终点”";
});

const controlAreaHint = computed(() => {
  if (controlAreaDrawing.value && !controlAreaDragStart) return "在地图上按住左键拖出矩形管控区";
  if (controlAreaDrawing.value) return "松开左键完成矩形范围";
  if (controlAreaDraftBounds.value) return "草图已生成，设置时间后点击“保存管控”";
  return controlAreaStatus.value || "保存后，管控时间内无人机将自动绕开覆盖网格";
});

/**
 * 封装list page count相关逻辑，保持调用处简洁并便于后续维护。
 */
function listPageCount(items, pageSize) {
  return Math.max(1, Math.ceil((items?.length || 0) / pageSize));
}

/**
 * 封装visible page items相关逻辑，保持调用处简洁并便于后续维护。
 */
function visiblePageItems(items, page, pageSize) {
  const pageCount = listPageCount(items, pageSize);
  const safePage = Math.min(Math.max(Number(page || 0), 0), pageCount - 1);
  return (items || []).slice(safePage * pageSize, safePage * pageSize + pageSize);
}

const controlAreaPageCount = computed(() => listPageCount(controlAreas.value, CONTROL_AREA_PAGE_SIZE));
const visibleControlAreas = computed(() => visiblePageItems(controlAreas.value, controlAreaPage.value, CONTROL_AREA_PAGE_SIZE));
const helipadPageCount = computed(() => listPageCount(helipads.value, HELIPAD_PAGE_SIZE));
const visibleHelipads = computed(() => visiblePageItems(helipads.value, helipadPage.value, HELIPAD_PAGE_SIZE));
const routeArchivePageCount = computed(() => listPageCount(savedRoutes.value, ROUTE_ARCHIVE_PAGE_SIZE));
const visibleSavedRoutes = computed(() => visiblePageItems(savedRoutes.value, routeArchivePage.value, ROUTE_ARCHIVE_PAGE_SIZE));

/**
 * 封装change control area page相关逻辑，保持调用处简洁并便于后续维护。
 */
function changeControlAreaPage(delta) {
  controlAreaPage.value = Math.min(Math.max(controlAreaPage.value + delta, 0), controlAreaPageCount.value - 1);
}

/**
 * 封装change helipad page相关逻辑，保持调用处简洁并便于后续维护。
 */
function changeHelipadPage(delta) {
  helipadPage.value = Math.min(Math.max(helipadPage.value + delta, 0), helipadPageCount.value - 1);
}

/**
 * 封装change route archive page相关逻辑，保持调用处简洁并便于后续维护。
 */
function changeRouteArchivePage(delta) {
  routeArchivePage.value = Math.min(Math.max(routeArchivePage.value + delta, 0), routeArchivePageCount.value - 1);
}

// String-pulling 后处理：在不离开安全网格走廊的前提下，尽量跳过多余的网格中心点。
function pullString(waypoints) {
  if (waypoints.length <= 2) return waypoints;
  const pulled = [waypoints[0]];
  let curr = 0;

  while (curr < waypoints.length - 1) {
    let furthestSafe = curr + 1;
    for (let j = waypoints.length - 1; j > curr + 1; j--) {
      const startP = waypoints[curr];
      const endP = waypoints[j];
      const dist = Cesium.Cartesian3.distance(startP, endP);

      // 相邻航点来自同一网格走廊，用它们的距离估算当前局部网格宽度。
      const localGridSize = Cesium.Cartesian3.distance(waypoints[curr], waypoints[curr + 1]);
      
      // 半径略小于半个网格，避免捷径贴到网格边界外。
      const safeRadius = localGridSize * 0.45;

      const steps = Math.ceil(dist / (safeRadius / 2));
      let isSafe = true;

      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const sample = Cesium.Cartesian3.lerp(startP, endP, t, new Cesium.Cartesian3());
        let pointInside = false;

        // 检查这个采样点是否严格包裹在沿途网格的球体范围内
        for (let k = curr; k <= j; k++) {
          if (Cesium.Cartesian3.distance(sample, waypoints[k]) <= safeRadius) {
            pointInside = true;
            break;
          }
        }
        if (!pointInside) {
          isSafe = false;
          break;
        }
      }
      if (isSafe) {
        furthestSafe = j;
        break;
      }
    }
    pulled.push(waypoints[furthestSafe]);
    curr = furthestSafe;
  }
  return pulled;
}

// Chaikin corner-cutting：只在折线内部切角，避免 Catmull-Rom 这类曲线向外越过网格走廊。
function chaikinSmooth(waypoints, iterations = 3) {
  if (waypoints.length <= 2) return waypoints;
  let currentPts = [...waypoints];

  for (let i = 0; i < iterations; i++) {
    const smoothed = [];
    smoothed.push(currentPts[0]);
    
    for (let j = 0; j < currentPts.length - 1; j++) {
      const p0 = currentPts[j];
      const p1 = currentPts[j + 1];
      // 20% 和 80% 切分可以保留走廊约束，同时让拐角更自然。
      const pA = Cesium.Cartesian3.lerp(p0, p1, 0.2, new Cesium.Cartesian3());
      const pB = Cesium.Cartesian3.lerp(p0, p1, 0.8, new Cesium.Cartesian3());
      smoothed.push(pA);
      smoothed.push(pB);
    }
    smoothed.push(currentPts[currentPts.length - 1]);
    currentPts = smoothed;
  }
  return currentPts;
}

// 图层显隐入口。网格、禁飞区和路径分开控制，避免一个开关误改其他业务图层。
function toggleAirspaceGrids() {
  showAirspaceGrids.value = !showAirspaceGrids.value;
  if (showAirspaceGrids.value) {
    refreshCurrentGrid();
    return;
  }
  updateGridVisibility();
}

/**
 * 切换toggle obstacle grids开关状态，并同步界面显示与数据加载。
 */
async function toggleObstacleGrids() {
  showObstacleGrids.value = !showObstacleGrids.value;
  if (obstacleDataSource) {
    viewer.dataSources.remove(obstacleDataSource, true);
    obstacleDataSource = null;
  }
  if (showObstacleGrids.value) {
    await refreshCurrentGrid();
    return;
  }
  updateGridVisibility();
}

/**
 * 切换toggle l22 weight grid开关状态，并同步界面显示与数据加载。
 */
async function toggleL22WeightGrid() {
  showL22WeightGrid.value = !showL22WeightGrid.value;
  if (!showL22WeightGrid.value) {
    clearL22WeightGridLayer();
    return;
  }
  await loadL22WeightGridLayer();
}

/**
 * 切换toggle airspace occupancy开关状态，并同步界面显示与数据加载。
 */
async function toggleAirspaceOccupancy() {
  showAirspaceOccupancy.value = !showAirspaceOccupancy.value;
  if (!showAirspaceOccupancy.value) {
    clearAirspaceOccupancyLayer();
    return;
  }
  await loadAirspaceOccupancyLayer();
  await loadAirspaceOccupancyStats();
}

/**
 * 切换toggle terrain开关状态，并同步界面显示与数据加载。
 */
async function toggleTerrain() {
  showTerrain.value = !showTerrain.value;
  if (!viewer) return;

  if (showTerrain.value) {
    await loadJiangningDemTerrain();
  } else {
    viewer.terrainProvider = ellipsoidTerrainProvider || new Cesium.EllipsoidTerrainProvider();
    terrainStatus.value = "关闭";
  }
  await refreshCurrentGrid();
  if (showL22WeightGrid.value) await loadL22WeightGridLayer();
  if (showAirspaceOccupancy.value) await loadAirspaceOccupancyLayer();
  await rerenderActiveRoute();
  await Promise.all([
    startCoords ? setMissionPoint("start", startCoords) : Promise.resolve(),
    endCoords ? setMissionPoint("end", endCoords) : Promise.resolve(),
  ]);
}

/**
 * 切换toggle roads开关状态，并同步界面显示与数据加载。
 */
function toggleRoads() {
  showRoads.value = !showRoads.value;
  if (roadDataSource) roadDataSource.show = showRoads.value;
}

/**
 * 切换toggle water开关状态，并同步界面显示与数据加载。
 */
function toggleWater() {
  showWater.value = !showWater.value;
  if (waterDataSource) waterDataSource.show = showWater.value;
}

// 根据实时状态拆分普通空域网格和受限网格，保留被点击网格的高亮状态。
function updateGridVisibility() {
  if (gridLineDataSource) {
    gridLineDataSource.show = showAirspaceGrids.value;
  }
  if (!gridDataSource) return;
  const entities = gridDataSource.entities.values;
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    const status = gridNumberProperty(entity, "effective_status", gridNumberProperty(entity, "status", 0));
    
    if (status !== 0) { 
      entity.show = showObstacleGrids.value;
    } else { 
      entity.show = showAirspaceGrids.value;
    }
  }
  if (highlightedGridEntity) applyGridHighlight(highlightedGridEntity);
}
/**
 * 切换toggle buildings开关状态，并同步界面显示与数据加载。
 */
function toggleBuildings() {
  showBuildings.value = !showBuildings.value;
  if (buildingTileset) {
    buildingTileset.show = showBuildings.value;
  }
}

/**
 * 从后端读取GeoSOT层级元数据，并同步前端下拉框、边长和层数显示。
 */
async function loadGridLevelMetadata() {
  try {
    const response = await fetch(`${API_BASE}/api/levels`);
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.levels)) return;
    const visibleLevels = data.levels.filter((level) => Number(level.geosotLevel || geosotLevelNumber(level.key)) >= MIN_OPERATIONAL_GEOSOT_LEVEL);
    for (const level of visibleLevels) {
      GRID_CONFIG[level.key] = {
        key: level.key,
        label: level.displayName || level.key,
        geosotLevel: Number(level.geosotLevel || geosotLevelNumber(level.key)),
        maxAltitude: Number(level.maxAltitude || GRID_CONFIG[level.key]?.maxAltitude || 120),
        verticalStep: Number(level.verticalStep || GRID_CONFIG[level.key]?.verticalStep || 10),
        bounds: level.bounds || GRID_CONFIG[level.key]?.bounds || FINE_BOUNDS,
        resolution: level.resolution,
        databaseBacked: Boolean(level.databaseBacked),
        planningAvailable: Boolean(level.planningAvailable),
      };
    }
    availableGridLevels.value = visibleLevels
      .map((level) => GRID_CONFIG[level.key])
      .filter(Boolean)
      .sort((a, b) => Number(b.key.slice(1)) - Number(a.key.slice(1)));
    if (!isOperationalGridLevel(currentGridLevel.value) || !GRID_CONFIG[currentGridLevel.value]) {
      currentGridLevel.value = availableGridLevels.value[0]?.key || "L22";
    }
    gridLevelStr.value = GRID_CONFIG[currentGridLevel.value]?.label || currentGridLevel.value;
    clampTargetAltitudeToCurrentLevel();
  } catch (error) {
    console.warn("网格层级读取失败，使用本地配置:", error);
    clampTargetAltitudeToCurrentLevel();
  }
}

/**
 * 切换toggle level menu开关状态，并同步界面显示与数据加载。
 */
function toggleLevelMenu() {
  levelMenuOpen.value = !levelMenuOpen.value;
}

/**
 * 获取choose level option对应对象或配置，集中处理选择规则。
 */
async function chooseLevelOption(level) {
  levelMenuOpen.value = false;
  await selectGridLevel(level);
}

/**
 * 获取select grid level对应对象或配置，集中处理选择规则。
 */
async function selectGridLevel(level) {
  levelMenuOpen.value = false;
  if (!GRID_CONFIG[level]) return;
  manualGridLevelLocked.value = true;
  currentGridLevel.value = level;
  gridLevelStr.value = GRID_CONFIG[level].label;
  clampTargetAltitudeToCurrentLevel();
  await refreshCurrentGrid({ syncLevel: false });
}

/**
 * 格式化format altitude value显示内容，避免界面和日志直接暴露原始数据结构。
 */
function formatAltitudeValue(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return Math.abs(number - Math.round(number)) < 0.05 ? String(Math.round(number)) : number.toFixed(1);
}

/**
 * 格式化format grid edge length显示内容，避免界面和日志直接暴露原始数据结构。
 */
function formatGridEdgeLength(value) {
  const meters = Number(value || 0);
  if (!Number.isFinite(meters) || meters <= 0) return "0m";
  if (meters >= 1000) return `${(meters / 1000).toFixed(3)}km`;
  return `${meters.toFixed(3)}m`;
}

/**
 * 封装grid level layer count相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridLevelLayerCount(level) {
  const levelNumber = Number(level?.geosotLevel || geosotLevelNumber(level?.key || level));
  if (!Number.isFinite(levelNumber) || levelNumber <= MIN_OPERATIONAL_GEOSOT_LEVEL) return 1;
  return 2 ** Math.max(0, levelNumber - MIN_OPERATIONAL_GEOSOT_LEVEL);
}

/**
 * 封装theoretical grid total height相关逻辑，保持调用处简洁并便于后续维护。
 */
function theoreticalGridTotalHeight() {
  return Number(GRID_CONFIG.L15?.verticalStep || levelNominalMeters(MIN_OPERATIONAL_GEOSOT_LEVEL, VERTICAL_REFERENCE_LATITUDE));
}

/**
 * 封装theoretical grid edge length相关逻辑，保持调用处简洁并便于后续维护。
 */
function theoreticalGridEdgeLength(level) {
  return roundMeters(theoreticalGridTotalHeight() / gridLevelLayerCount(level));
}

/**
 * 封装grid level metric text相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridLevelMetricText(level) {
  if (!level) return "";
  const theoreticalEdge = theoreticalGridEdgeLength(level);
  return `边长 ${formatGridEdgeLength(theoreticalEdge)} · ${gridLevelLayerCount(level)}层`;
}

/**
 * 封装clamp target altitude to current level相关逻辑，保持调用处简洁并便于后续维护。
 */
function clampTargetAltitudeToCurrentLevel() {
  const config = GRID_CONFIG[currentGridLevel.value] || GRID_CONFIG.L22;
  const maxAltitude = Math.max(0, Number(config.maxAltitude || 120) - 0.001);
  targetAltitude.value = Math.max(0, Math.min(Number(targetAltitude.value || 0), maxAltitude));
}

/**
 * 计算compute current view bounds指标，用于路径评价、界面显示或约束判断。
 */
function computeCurrentViewBounds() {
  if (!viewer) return null;
  const height = viewer.camera.positionCartographic.height;
  const rect = viewer.camera.computeViewRectangle();
  if (rect) {
    return {
      west: Cesium.Math.toDegrees(rect.west),
      south: Cesium.Math.toDegrees(rect.south),
      east: Cesium.Math.toDegrees(rect.east),
      north: Cesium.Math.toDegrees(rect.north),
    };
  }
  const centerLon = Cesium.Math.toDegrees(viewer.camera.positionCartographic.longitude);
  const centerLat = Cesium.Math.toDegrees(viewer.camera.positionCartographic.latitude);
  const offset = height > 4000 ? 0.1 : (height > 1500 ? 0.02 : 0.003);
  return {
    west: centerLon - offset,
    east: centerLon + offset,
    south: centerLat - offset,
    north: centerLat + offset,
  };
}

/**
 * 根据当前视野刷新网格显示，是细节层级自适应显示的入口。
 */
async function refreshCurrentGrid(options = {}) {
  if (!viewer) return;
  currentViewBounds = currentViewBounds || computeCurrentViewBounds();
  if (!currentViewBounds) return;
  const syncLevel = options.syncLevel !== false;
  const level = syncLevel
    ? syncGridLevelToCameraHeight(viewer.camera.positionCartographic.height)
    : currentGridLevel.value;
  await loadGridsInView(
    currentViewBounds.west,
    currentViewBounds.south,
    currentViewBounds.east,
    currentViewBounds.north,
    level,
  );
}

/**
 * 切换toggle path开关状态，并同步界面显示与数据加载。
 */
function togglePath() {
  showPath.value = !showPath.value;
  // 路径是由多个 entity 组成的数组，需要遍历控制
  currentPathEntities.forEach(entity => {
    entity.show = showPath.value;
  });
  if (droneEntity) droneEntity.show = showPath.value;
}

// HUD 和统计面板数据：这些值只服务前端展示，真实历史记录仍以后端为准。
const cameraAlt = ref(0);
const gridLevelStr = ref(GRID_CONFIG[currentGridLevel.value]?.label || GRID_CONFIG.L15.label);
const availableGridLevels = ref(Object.values(GRID_CONFIG).filter(isOperationalGridLevel).sort((a, b) => b.key.slice(1) - a.key.slice(1)));
const currentLevelConfig = computed(() => GRID_CONFIG[currentGridLevel.value] || GRID_CONFIG.L22);
const altitudeSliderStep = computed(() => Math.max(0.001, Number(currentLevelConfig.value.verticalStep || 10)));
const altitudeSliderMax = computed(() => Math.max(0, Number((Number(currentLevelConfig.value.maxAltitude || 120) - 0.001).toFixed(3))));
const altitudeLabel = computed(() => `${formatAltitudeValue(targetAltitude.value)} m`);
const pathLen = ref(0);
const pathTime = ref(0);
const flightTime = ref(0);
const routeRisk = ref("低");
const routeRiskScore = ref(0);
const maxVerticalRate = ref(0);
const routeGridCount = ref(0);
const terrainStatus = ref("加载中");
const planComparisons = ref([]);
const routeArchiveOpen = ref(false);
const routeArchiveLoading = ref(false);
const savedRoutes = ref([]);
const activeSavedRouteId = ref(null);
const routeArchivePage = ref(0);
const selectedGridHistory = ref(null);
const gridHistoryRows = ref([]);
const gridHistoryLoading = ref(false);
const gridHistoryError = ref("");
const gridStateSaving = ref(false);
const gridStateMessage = ref("");
const gridStateForm = ref({
  status: 0,
  flyWeight: 1,
  trafficDensity: 0,
  weatherLimit: false,
  reason: "人工更新",
});
const statsLoading = ref(false);
const dashboardStats = ref({
  daily: [],
  control: {
    active_count: 0,
    historical_count: 0,
    scheduled_count: 0,
    active_grid_count: 0,
  },
  totals: {
    total_flights: 0,
    total_distance_m: 0,
    total_grid_count: 0,
  },
});

const dashboardDaily = computed(() => normalizeDailyStats(dashboardStats.value.daily));
const dashboardControl = computed(() => dashboardStats.value.control || {});
const dashboardTotals = computed(() => dashboardStats.value.totals || {});
const airspaceOccupancyStats = ref([]);
const occupancyStatsText = computed(() => {
  if (!airspaceOccupancyStats.value.length) return "L16 0 · L19 0 · L22 0";
  return ["L16", "L19", "L22"]
    .map((level) => {
      const item = airspaceOccupancyStats.value.find((row) => row.level === level);
      return `${level} ${Number(item?.occupied_uav_count || 0)}`;
    })
    .join(" · ");
});
const chartHover = ref(null);
const flightCountBars = computed(() => makeBarSeries(dashboardDaily.value, "flight_count"));
const gridCountBars = computed(() => makeBarSeries(dashboardDaily.value, "grid_count"));
const distancePlotPoints = computed(() => makeLinePoints(dashboardDaily.value, "distance_m"));
const distanceLinePoints = computed(() => distancePlotPoints.value.map((point) => `${point.x},${point.y}`).join(" "));
const distanceAreaPoints = computed(() => {
  const points = distancePlotPoints.value;
  if (!points.length) return "";
  return `0,70 ${points.map((point) => `${point.x},${point.y}`).join(" ")} 240,70`;
});
const totalDistanceKm = computed(() => (Number(dashboardTotals.value.total_distance_m || 0) / 1000).toFixed(1));
const controlTotalCount = computed(() => (
  Number(dashboardControl.value.active_count || 0)
  + Number(dashboardControl.value.historical_count || 0)
  + Number(dashboardControl.value.scheduled_count || 0)
));
const controlActiveAngle = computed(() => {
  const active = Number(dashboardControl.value.active_count || 0);
  const total = controlTotalCount.value;
  return total > 0 ? (active / total) * 360 : 0;
});
const controlHistoryAngle = computed(() => {
  const active = Number(dashboardControl.value.active_count || 0);
  const history = Number(dashboardControl.value.historical_count || 0);
  const total = controlTotalCount.value;
  return total > 0 ? ((active + history) / total) * 360 : 0;
});
const controlDonutStyle = computed(() => ({
  "--active-angle": `${controlActiveAngle.value}deg`,
  "--history-angle": `${controlHistoryAngle.value}deg`,
  "--future-color": controlTotalCount.value > 0 ? "#facc15" : "rgba(148, 163, 184, 0.22)",
}));
const controlStatItems = computed(() => [
  {
    key: "control-active",
    label: "管控中",
    value: Number(dashboardControl.value.active_count || 0),
    dotClass: "live-dot",
    note: `当前禁飞 ${Number(dashboardControl.value.active_grid_count || 0)} 格`,
  },
  {
    key: "control-history",
    label: "历史管控",
    value: Number(dashboardControl.value.historical_count || 0),
    dotClass: "history-dot",
    note: "仅用于复现查看",
  },
  {
    key: "control-scheduled",
    label: "待生效",
    value: Number(dashboardControl.value.scheduled_count || 0),
    dotClass: "future-dot",
    note: "到达开始时间后生效",
  },
]);
const chartTooltipStyle = computed(() => {
  if (!chartHover.value) return {};
  return {
    left: `${chartHover.value.x}px`,
    top: `${chartHover.value.y}px`,
  };
});

const systemTimeText = ref("--:--:--");
const systemDateText = ref("----/--/--");
const weatherInfo = ref({
  locationName: "江宁区",
  text: "天气加载中",
  temp: "--",
  wind: "--",
});
const weatherControl = ref({
  loading: false,
  restricted: false,
  action: "none",
  modeLabel: "未同步",
  affectedGridCount: 0,
  restrictedGridCount: 0,
  totalGridCount: 0,
  reason: "未同步气象管控",
  levels: [],
  lastEvent: null,
});
const weatherControlAutoEnabled = ref(
  typeof window !== "undefined" && window.localStorage?.getItem("weather-control-auto") === "1",
);
let systemClockTimer = null;
let weatherRefreshTimer = null;

// 右下角坐标与比例尺数据，由鼠标移动和相机状态实时更新。
const mouseLon = ref('0.000000');
const mouseLat = ref('0.000000');
const mouseAlt = ref('0.0');
const scaleText = ref('0 m');

const ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN || "";

/**
 * 更新update system clock状态，使界面、缓存和计算结果保持一致。
 */
function updateSystemClock() {
  const now = new Date();
  systemTimeText.value = now.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  systemDateText.value = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
}

/**
 * 加载load weather info相关数据，并把结果同步到当前模块状态。
 */
async function loadWeatherInfo() {
  try {
    const response = await fetch(`${API_BASE}/api/weather`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "天气读取失败");
    const weather = data.weather || {};
    weatherInfo.value = {
      locationName: "江宁区",
      text: weather.text || "未知",
      temp: weather.temp || "--",
      wind: `${weather.windDir || "--"} ${weather.windScale || "--"}级`,
    };
  } catch (error) {
    console.warn("天气读取失败:", error);
    weatherInfo.value = {
      locationName: "江宁区",
      text: "天气暂不可用",
      temp: "--",
      wind: "--",
    };
  }

  if (weatherControlAutoEnabled.value) {
    await syncWeatherControl({ silent: true });
  }
}

/**
 * 应用apply weather control payload结果到数据库、实体样式或业务状态中。
 */
function applyWeatherControlPayload(data) {
  const lastEvent = data.last_event || null;
  const reason = data.reason || data.assessment?.reason || lastEvent?.reason || "气象状态正常";
  const action = data.action || data.assessment?.action || (data.restricted ? "restrict" : Number(data.affected_grid_count || 0) > 0 ? "risk" : "none");
  const modeLabel = action === "restrict" ? "自动禁飞" : (action === "risk" ? "风险提高" : "气象正常");
  weatherControl.value = {
    ...weatherControl.value,
    restricted: action === "restrict",
    action,
    modeLabel,
    affectedGridCount: Number(data.affected_grid_count || 0),
    restrictedGridCount: Number(data.restricted_grid_count || 0),
    totalGridCount: Number(data.total_grid_count || 0),
    reason,
    levels: data.levels || weatherControl.value.levels || [],
    lastEvent,
  };
}

// 气象管控默认作用于当前任务走廊附近；没有起终点时退回到当前视野范围。
function weatherControlScopePayload() {
  const sourceBounds = startCoords && endCoords
    ? {
        west: Math.min(startCoords.lon, endCoords.lon) - 0.01,
        south: Math.min(startCoords.lat, endCoords.lat) - 0.01,
        east: Math.max(startCoords.lon, endCoords.lon) + 0.01,
        north: Math.max(startCoords.lat, endCoords.lat) + 0.01,
      }
    : currentViewBounds;
  if (!sourceBounds) return {};
  return {
    west: sourceBounds.west,
    south: sourceBounds.south,
    east: sourceBounds.east,
    north: sourceBounds.north,
  };
}

/**
 * 加载load weather control status相关数据，并把结果同步到当前模块状态。
 */
async function loadWeatherControlStatus() {
  weatherControl.value.loading = true;
  try {
    const params = new URLSearchParams(weatherControlScopePayload());
    const response = await fetch(`${API_BASE}/api/weather-control/status${params.toString() ? `?${params.toString()}` : ""}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "气象管控状态读取失败");
    applyWeatherControlPayload(data);
  } catch (error) {
    console.warn("气象管控状态读取失败:", error);
    weatherControl.value.reason = error.message || "气象管控状态读取失败";
  } finally {
    weatherControl.value.loading = false;
  }
}

/**
 * 封装sync weather control相关逻辑，保持调用处简洁并便于后续维护。
 */
async function syncWeatherControl(options = {}) {
  weatherControl.value.loading = true;
  try {
    const response = await fetch(`${API_BASE}/api/weather-control/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(weatherControlScopePayload()),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "气象管控同步失败");
    applyWeatherControlPayload(data);
    if (data.weather) {
      weatherInfo.value = {
        locationName: "江宁区",
        text: data.weather.text || "未知",
        temp: data.weather.temp || "--",
        wind: `${data.weather.windDir || "--"} ${data.weather.windScale || "--"}级`,
      };
    }
    await refreshCurrentGrid();
    if (!options.silent) {
      controlAreaStatus.value = `${data.reason || "气象管控已同步"}，影响 ${data.affected_grid_count || 0} 个网格`;
    }
  } catch (error) {
    console.error("气象管控同步失败:", error);
    weatherControl.value.reason = error.message || "气象管控同步失败";
    if (!options.silent) controlAreaStatus.value = weatherControl.value.reason;
  } finally {
    weatherControl.value.loading = false;
  }
}

/**
 * 清理clear weather control相关状态，避免旧图层、旧结果或临时数据影响下一次操作。
 */
async function clearWeatherControl() {
  weatherControl.value.loading = true;
  try {
    const response = await fetch(`${API_BASE}/api/weather-control/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...weatherControlScopePayload(), reason: "气象自动解除：前端手动解除" }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "气象管控解除失败");
    applyWeatherControlPayload(data);
    await refreshCurrentGrid();
    controlAreaStatus.value = `气象管控已解除，更新 ${data.updated || 0} 个网格`;
  } catch (error) {
    console.error("气象管控解除失败:", error);
    weatherControl.value.reason = error.message || "气象管控解除失败";
    controlAreaStatus.value = weatherControl.value.reason;
  } finally {
    weatherControl.value.loading = false;
  }
}

/**
 * 切换toggle weather control auto开关状态，并同步界面显示与数据加载。
 */
async function toggleWeatherControlAuto() {
  weatherControlAutoEnabled.value = !weatherControlAutoEnabled.value;
  window.localStorage?.setItem("weather-control-auto", weatherControlAutoEnabled.value ? "1" : "0");
  if (weatherControlAutoEnabled.value) {
    await syncWeatherControl();
  }
}

onMounted(async () => {
  updateSystemClock();
  loadWeatherInfo();
  loadWeatherControlStatus();
  systemClockTimer = window.setInterval(updateSystemClock, 1000);
  weatherRefreshTimer = window.setInterval(loadWeatherInfo, 10 * 60 * 1000);

  try {
    if (ION_TOKEN) {
      Cesium.Ion.defaultAccessToken = ION_TOKEN;
    }

    ellipsoidTerrainProvider = new Cesium.EllipsoidTerrainProvider();

    // Cesium Viewer 是全局唯一实例。所有数据源和事件监听都挂在这个实例上，销毁时统一释放。
    viewer = new Cesium.Viewer(cesiumContainer.value, {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      // imageryProvider: new Cesium.TileMapServiceImageryProvider({
      //   url: Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
      // }),
      terrainProvider: ellipsoidTerrainProvider
    });
    viewer.cesiumWidget.creditContainer.style.display = "none";
    viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);

    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.scene.globe.enableLighting = true;
    viewer.scene.verticalExaggeration = 1.25;
    await loadGridLevelMetadata();

// 2. 添加 ArcGIS WGS84 纯净卫星底图 (完美对齐 OSM 与标准模型)
// 2. 添加 ArcGIS WGS84 纯净卫星底图 (兼容最新版 Cesium API)
// 2. 添加 ArcGIS WGS84 纯净卫星底图 (绕过 CORS，直接请求切片)
    // const arcgisImagery = new Cesium.UrlTemplateImageryProvider({
    //   url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    //   maximumLevel: 19 // ArcGIS 卫星图最高支持到 19 级
    // });
    // viewer.imageryLayers.addImageryProvider(arcgisImagery);

    // 3. 加载江宁 DEM 与案例场景要素
    await loadJiangningDemTerrain();
    await loadCaseSceneLayers();

    // 4. 加载白模型
    await loadBuildings();
    await loadHelipads();

    // 5. 初始化所有交互监听器
    initCameraListener(); // 相机移动监听 (LOD加载 + 更新高度/比例尺)
    initMouseTracker();   // 鼠标移动监听 (更新经纬度)
    initClickHandler();   // 鼠标点击交互 (选点规划)
    initHelipadPopupTracker();
    initControlAreaDrawingHandler();
    initOccupancyClockSync();
    loadSavedRoutes();
    loadControlAreas();
    loadDashboardStats();
    loadAirspaceOccupancyStats();

    // 6. 定位到项目初始视野
    returnInitialView(2);

  } catch (error) {
    console.error("初始化崩溃:", error);
  }
});

onBeforeUnmount(() => {
  if (systemClockTimer) {
    window.clearInterval(systemClockTimer);
    systemClockTimer = null;
  }
  if (weatherRefreshTimer) {
    window.clearInterval(weatherRefreshTimer);
    weatherRefreshTimer = null;
  }
  if (viewer && helipadPopupRenderListener) {
    viewer.scene.postRender.removeEventListener(helipadPopupRenderListener);
    helipadPopupRenderListener = null;
  }
});

// ==========================================
// --- 交互与事件监听逻辑 ---
// ==========================================

function returnInitialView(duration = INITIAL_VIEW.duration) {
  if (!viewer) return;
  const flyDuration = Number.isFinite(Number(duration)) ? Number(duration) : INITIAL_VIEW.duration;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      INITIAL_VIEW.lon,
      INITIAL_VIEW.lat,
      INITIAL_VIEW.height,
    ),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(INITIAL_VIEW.pitchDeg),
      roll: 0,
    },
    duration: flyDuration,
  });
}

/**
 * 封装init camera listener相关逻辑，保持调用处简洁并便于后续维护。
 */
function initCameraListener() {
  viewer.camera.moveEnd.addEventListener(async () => {
      const height = viewer.camera.positionCartographic.height;
      
      // 更新 HUD 中的高度
      cameraAlt.value = height.toFixed(0);
      
      // 更新底部比例尺
      updateScale();

      if (manualGridLevelLocked.value) {
        manualGridLevelLocked.value = false;
      }
      const requestLevel = syncGridLevelToCameraHeight(height);
      gridLevelStr.value = GRID_CONFIG[requestLevel]?.label || requestLevel;

      currentViewBounds = computeCurrentViewBounds();
      await refreshCurrentGrid();
      if (showAirspaceOccupancy.value) await loadAirspaceOccupancyLayer();
  });
}

/**
 * 封装init occupancy clock sync相关逻辑，保持调用处简洁并便于后续维护。
 */
function initOccupancyClockSync() {
  viewer.clock.onTick.addEventListener(() => {
    if (!showAirspaceOccupancy.value || !droneEntity) return;
    const now = Date.now();
    if (now - occupancyClockSyncLastMs < 1000) return;
    occupancyClockSyncLastMs = now;
    void loadAirspaceOccupancyLayer().catch((error) => console.warn("空域占用图层同步失败:", error));
    void loadAirspaceOccupancyStats();
  });
}

// 鼠标跟踪：用于底部经纬度读数，优先使用 pickPosition，失败时退回椭球拾取。
function initMouseTracker() {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    let cartesian = viewer.scene.pickPosition(movement.endPosition);
    if (!Cesium.defined(cartesian)) {
       cartesian = viewer.camera.pickEllipsoid(movement.endPosition, viewer.scene.globe.ellipsoid);
    }
    
    if (cartesian) {
      const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
      mouseLon.value = Cesium.Math.toDegrees(cartographic.longitude).toFixed(6);
      mouseLat.value = Cesium.Math.toDegrees(cartographic.latitude).toFixed(6);
      mouseAlt.value = cartographic.height > 0 ? cartographic.height.toFixed(1) : "0.0";
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

// 比例尺用屏幕底部 100 像素的两端点估算，适合当前倾斜视角下的快速读数。
function updateScale() {
  if (!viewer) return;
  const width = viewer.canvas.clientWidth;
  const height = viewer.canvas.clientHeight;
  
  // 取屏幕底部中间左右各 50 像素的点
  const left = viewer.camera.pickEllipsoid(new Cesium.Cartesian2((width / 2) - 50, height - 20), viewer.scene.globe.ellipsoid);
  const right = viewer.camera.pickEllipsoid(new Cesium.Cartesian2((width / 2) + 50, height - 20), viewer.scene.globe.ellipsoid);

  if (left && right) {
    const geodesic = new Cesium.EllipsoidGeodesic(
      Cesium.Cartographic.fromCartesian(left),
      Cesium.Cartographic.fromCartesian(right)
    );
    const distance = geodesic.surfaceDistance;
    scaleText.value = distance > 1000 ? (distance / 1000).toFixed(2) + ' km' : distance.toFixed(0) + ' m';
  } else {
    scaleText.value = "无法计算";
  }
}

/**
 * 封装init click handler相关逻辑，保持调用处简洁并便于后续维护。
 */
function initClickHandler() {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction(async (movement) => {
    if (controlAreaDrawing.value) return;
    hideHelipadContextMenu();
    hideMissionPointInfoPopup();
    const picked = viewer.scene.pick(movement.position);
    const pickedHelipadId = getPickedHelipadId(picked);
    if (pickedHelipadId) {
      handleHelipadLeftClick(pickedHelipadId);
      return;
    }
    hideHelipadInfoPopup();

    let cartesian = viewer.scene.pickPosition(movement.position);
    if (!Cesium.defined(cartesian)) {
       cartesian = viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
    }
    
    if (cartesian) {
      const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
      const lon = Cesium.Math.toDegrees(cartographic.longitude);
      const lat = Cesium.Math.toDegrees(cartographic.latitude);
      
      // 点击只能可靠得到经纬度；高度使用面板设定值，避免模型/地形拾取高度影响任务高度。
      const alt = targetAltitude.value; 

      if (helipadEditMode.value === "add") {
        await createHelipadAt({ lon, lat, alt });
        return;
      }

      if (helipadEditMode.value === "delete") {
        helipadStatus.value = "请点击地图上的停机坪进行删除";
        return;
      }

      if (!currentAction.value) {
        const handledGrid = await loadGridHistoryForEntity(picked?.id);
        if (!handledGrid) clearGridHistory();
        return;
      }

      await setMissionPoint(currentAction.value, { lon, lat, alt });
      currentAction.value = null;
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  handler.setInputAction((movement) => {
    if (controlAreaDrawing.value) return;
    hideHelipadInfoPopup();
    hideMissionPointInfoPopup();
    const picked = viewer.scene.pick(movement.position);
    const pickedMissionType = getPickedMissionPointType(picked);
    if (pickedMissionType) {
      hideHelipadContextMenu();
      showMissionPointInfoPopup(pickedMissionType, movement.position);
      return;
    }

    const pickedHelipadId = getPickedHelipadId(picked);
    if (pickedHelipadId) {
      showHelipadContextMenu(pickedHelipadId, movement.position);
      return;
    }

    hideHelipadContextMenu();
  }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
}

/**
 * 封装init control area drawing handler相关逻辑，保持调用处简洁并便于后续维护。
 */
function initControlAreaDrawingHandler() {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    if (!controlAreaDrawing.value) return;
    const point = pickMapPoint(movement.position);
    if (!point) return;
    controlAreaDragStart = point;
    setCameraInputEnabled(false);
    updateControlAreaDraft(point, point);
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

  handler.setInputAction((movement) => {
    if (!controlAreaDrawing.value || !controlAreaDragStart) return;
    const point = pickMapPoint(movement.endPosition);
    if (!point) return;
    updateControlAreaDraft(controlAreaDragStart, point);
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction((movement) => {
    if (!controlAreaDrawing.value || !controlAreaDragStart) return;
    const point = pickMapPoint(movement.position);
    if (point) updateControlAreaDraft(controlAreaDragStart, point);
    controlAreaDragStart = null;
    controlAreaDrawing.value = false;
    setCameraInputEnabled(true);
    controlAreaStatus.value = controlAreaDraftBounds.value
      ? "矩形草图已完成"
      : "未获取到有效范围，请重新绘制";
  }, Cesium.ScreenSpaceEventType.LEFT_UP);
}

/**
 * 封装mission point display altitude相关逻辑，保持调用处简洁并便于后续维护。
 */
function missionPointDisplayAltitude(point) {
  return Number(point?.agl ?? point?.alt ?? 0);
}

/**
 * 封装mission point cartesian相关逻辑，保持调用处简洁并便于后续维护。
 */
async function missionPointCartesian(point, lift = routeGridVisualLift()) {
  const [terrainPoint] = await sampleGridTerrain([point]);
  const terrainHeight = Number(terrainPoint?.height || 0);
  return Cesium.Cartesian3.fromDegrees(point.lon, point.lat, terrainHeight + missionPointDisplayAltitude(point) + lift);
}

/**
 * 维护remove mission marker集合，保证场景实体和业务状态同步。
 */
function removeMissionMarker(marker) {
  if (!marker) return;
  const entities = Array.isArray(marker.entities) ? marker.entities : [marker];
  entities.forEach((entity) => {
    if (entity) viewer.entities.remove(entity);
  });
}

/**
 * 设置set mission point状态，并触发必要的后续联动。
 */
async function setMissionPoint(type, point) {
  const isStart = type === "start";
  const color = isStart
    ? Cesium.Color.fromCssColorString("#f97316")
    : Cesium.Color.fromCssColorString("#38bdf8");
  const label = isStart ? "起点" : "终点";
  const missionProperties = {
    entityType: "missionPoint",
    missionType: type,
    lon: Number(point.lon),
    lat: Number(point.lat),
    alt: missionPointDisplayAltitude(point),
    gridLevel: currentGridLevel.value,
  };
  const floatingCartesian = await missionPointCartesian(point);
  const groundCartesian = await missionPointCartesian({ ...point, alt: 0 }, 0);
  const groundPosition = Cesium.Cartesian3.fromDegrees(point.lon, point.lat, 0);
  const pulseOffset = isStart ? 0 : 900;

  if (isStart) {
    startCoords = point;
    removeMissionMarker(startEntity);
  } else {
    endCoords = point;
    removeMissionMarker(endEntity);
  }

  const baseRing = viewer.entities.add({
    position: groundPosition,
    properties: missionProperties,
    ellipse: {
      semiMajorAxis: isStart ? 24 : 22,
      semiMinorAxis: isStart ? 24 : 22,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => {
        const pulse = (Math.sin((Date.now() + pulseOffset) / 420) + 1) / 2;
        return color.withAlpha(0.14 + pulse * 0.2);
      }, false)),
      outline: true,
      outlineColor: color.withAlpha(0.92),
    },
  });

  const beacon = viewer.entities.add({
    position: floatingCartesian,
    properties: missionProperties,
    cylinder: {
      length: Math.max(16, missionPointDisplayAltitude(point)),
      topRadius: 0,
      bottomRadius: isStart ? 7 : 6,
      material: color.withAlpha(0.34),
      outline: false,
    },
  });

  const entity = viewer.entities.add({
    position: floatingCartesian,
    properties: missionProperties,
    point: {
      pixelSize: new Cesium.CallbackProperty(() => {
        const pulse = (Math.sin((Date.now() + pulseOffset) / 320) + 1) / 2;
        return (isStart ? 14 : 13) + pulse * 4;
      }, false),
      color: new Cesium.CallbackProperty(() => {
        const pulse = (Math.sin((Date.now() + pulseOffset) / 320) + 1) / 2;
        return color.withAlpha(0.76 + pulse * 0.24);
      }, false),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    polyline: {
      positions: [floatingCartesian, groundCartesian],
      width: 5,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.4,
        taperPower: 0.7,
        color: color.withAlpha(0.96),
      }),
    },
    label: {
      text: `${label} ${point.alt || 0}m`,
      font: "bold 13px sans-serif",
      fillColor: Cesium.Color.WHITE,
      outlineColor: color.withAlpha(0.95),
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString("#06131a").withAlpha(0.55),
      pixelOffset: new Cesium.Cartesian2(0, -28),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  const marker = { entities: [baseRing, beacon, entity] };
  if (isStart) startEntity = marker;
  else endEntity = marker;
}

/**
 * 规范化normalize helipad输入，减少接口参数和内部数据格式差异带来的判断分支。
 */
function normalizeHelipad(raw) {
  const code = raw.helipad_code || raw.code || `H-${raw.id}`;
  return {
    id: Number(raw.id),
    code,
    name: raw.name || `停机坪 ${code}`,
    lon: Number(raw.lon),
    lat: Number(raw.lat),
    alt: Number(raw.alt ?? targetAltitude.value ?? 30),
    status: raw.status || "active",
    notes: raw.notes || "",
  };
}

/**
 * 封装helipad mission point相关逻辑，保持调用处简洁并便于后续维护。
 */
function helipadMissionPoint(pad) {
  return {
    lon: pad.lon,
    lat: pad.lat,
    alt: Number(pad.alt || targetAltitude.value || 30),
  };
}

/**
 * 封装entity property value相关逻辑，保持调用处简洁并便于后续维护。
 */
function entityPropertyValue(entity, key) {
  const time = Cesium.JulianDate.now();
  const property = entity?.properties?.[key];
  if (property?.getValue) return property.getValue(time);
  if (property !== undefined) return property;
  const values = entity?.properties?.getValue?.(time);
  return values?.[key];
}

/**
 * 封装grid entity summary相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridEntitySummary(entity) {
  const geosotId = entityPropertyValue(entity, "geosot_id");
  if (!geosotId) return null;
  const geosotCode = entityPropertyValue(entity, "geosot_code");
  const level = entityPropertyValue(entity, "grid_level") || "--";
  const bottom = Number(entityPropertyValue(entity, "bottom") ?? 0);
  const top = Number(entityPropertyValue(entity, "top") ?? 0);
  const status = Number(entityPropertyValue(entity, "effective_status") ?? entityPropertyValue(entity, "status") ?? 0);
  const storedStatus = Number(entityPropertyValue(entity, "stored_status") ?? entityPropertyValue(entity, "status") ?? status);
  const surfaceType = String(entityPropertyValue(entity, "surface_type") || "normal");
  const surfaceWeight = Number(entityPropertyValue(entity, "surface_weight") ?? 1);
  const flyWeight = Number(entityPropertyValue(entity, "fly_weight") ?? 1);
  const trafficDensity = Number(entityPropertyValue(entity, "traffic_density") ?? 0);
  const weatherLimit = Boolean(entityPropertyValue(entity, "weather_limit"));
  const controlStartAt = entityPropertyValue(entity, "control_start_at");
  const controlEndAt = entityPropertyValue(entity, "control_end_at");
  const zMatch = String(geosotId).match(/-Z(\d+)$/);
  return {
    geosotId: String(geosotId),
    surfaceCode: String(geosotCode || geosotId).replace(/-Z\d+$/, ''),
    level: String(level),
    altitudeRange: `${Number.isFinite(bottom) ? bottom.toFixed(0) : 0}-${Number.isFinite(top) ? top.toFixed(0) : 0}m`,
    altitudeLayer: zMatch ? `Z${zMatch[1]} · ${Number.isFinite(bottom) ? bottom.toFixed(0) : 0}-${Number.isFinite(top) ? top.toFixed(0) : 0}m` : `${Number.isFinite(bottom) ? bottom.toFixed(0) : 0}-${Number.isFinite(top) ? top.toFixed(0) : 0}m`,
    status,
    storedStatus,
    statusText: weatherLimit ? "气象限制" : (status === 0 ? "当前可飞" : "当前受限"),
    surfaceType,
    surfaceTypeText: surfaceTypeLabel(surfaceType, status),
    surfaceWeightValue: Number.isFinite(surfaceWeight) ? surfaceWeight : 1,
    surfaceWeight: Number.isFinite(surfaceWeight) ? surfaceWeight.toFixed(2) : "--",
    flyWeightValue: Number.isFinite(flyWeight) ? flyWeight : 1,
    flyWeight: Number.isFinite(flyWeight) ? flyWeight.toFixed(2) : "--",
    trafficDensityValue: Number.isFinite(trafficDensity) ? trafficDensity : 0,
    trafficDensity: Number.isFinite(trafficDensity) ? trafficDensity.toFixed(2) : "--",
    weatherLimit,
    timeIndexText: controlStartAt && controlEndAt ? `${formatGridHistoryTime(controlStartAt)}-${formatGridHistoryTime(controlEndAt)}` : "实时状态/历史序列",
  };
}

/**
 * 清理clear grid history相关状态，避免旧图层、旧结果或临时数据影响下一次操作。
 */
function clearGridHistory() {
  selectedGridHistory.value = null;
  gridHistoryRows.value = [];
  gridHistoryError.value = "";
  gridHistoryLoading.value = false;
  gridStateMessage.value = "";
  clearGridHighlight();
  updateGridVisibility();
}

/**
 * 封装reset grid state editor相关逻辑，保持调用处简洁并便于后续维护。
 */
function resetGridStateEditor(summary) {
  gridStateForm.value = {
    status: Number(summary?.storedStatus ?? summary?.status ?? 0),
    flyWeight: Number(summary?.flyWeightValue ?? 1),
    trafficDensity: Number(summary?.trafficDensityValue ?? 0),
    weatherLimit: Boolean(summary?.weatherLimit),
    reason: "人工更新",
  };
  gridStateMessage.value = "";
}

/**
 * 设置set grid state status状态，并触发必要的后续联动。
 */
function setGridStateStatus(status) {
  gridStateForm.value.status = status;
  gridStateForm.value.reason = status === 0 ? "人工解除限制" : "人工设为受限";
}

/**
 * 规范化normalize updated grid summary输入，减少接口参数和内部数据格式差异带来的判断分支。
 */
function normalizeUpdatedGridSummary(current, grid) {
  if (!grid) return current;
  const status = Number(grid.status ?? grid.effective_status ?? 0);
  const storedStatus = Number(grid.storedStatus ?? grid.stored_status ?? status);
  const flyWeight = Number(grid.flyWeight ?? grid.fly_weight ?? 1);
  const surfaceWeight = Number(grid.surfaceWeight ?? grid.surface_weight ?? current.surfaceWeightValue ?? 1);
  const trafficDensity = Number(grid.trafficDensity ?? grid.traffic_density ?? 0);
  const weatherLimit = Boolean(grid.weatherLimit ?? grid.weather_limit);
  const surfaceType = String(grid.surfaceType ?? grid.surface_type ?? current.surfaceType ?? "normal");
  return {
    ...current,
    geosotId: grid.geosotId || current.geosotId,
    surfaceCode: String(grid.geosotCode || current.surfaceCode || "").replace(/-Z\d+$/, ""),
    level: grid.gridLevel || current.level,
    altitudeRange: grid.altitudeRange || current.altitudeRange,
    altitudeLayer: grid.geosotZ != null ? `Z${grid.geosotZ} · ${grid.altitudeRange || current.altitudeRange}` : current.altitudeLayer,
    status: weatherLimit ? 1 : status,
    storedStatus,
    statusText: weatherLimit ? "气象限制" : (status === 0 ? "当前可飞" : "当前受限"),
    surfaceType,
    surfaceTypeText: surfaceTypeLabel(surfaceType, status),
    surfaceWeightValue: surfaceWeight,
    surfaceWeight: Number.isFinite(surfaceWeight) ? surfaceWeight.toFixed(2) : "--",
    flyWeightValue: flyWeight,
    flyWeight: flyWeight.toFixed(2),
    trafficDensityValue: trafficDensity,
    trafficDensity: trafficDensity.toFixed(2),
    weatherLimit,
    timeIndexText: grid.controlStartAt && grid.controlEndAt
      ? `${formatGridHistoryTime(grid.controlStartAt)}-${formatGridHistoryTime(grid.controlEndAt)}`
      : "实时状态/历史序列",
  };
}

/**
 * 按网格状态设置Cesium实体样式，使管控结果在地图上可辨识。
 */
function styleGridEntity(entity) {
  if (!entity?.polygon) return;
  const status = gridNumberProperty(entity, "effective_status", gridNumberProperty(entity, "status", 0));
  const heights = groundAttachedGridHeights(entity);
  const style = gridWeightStyle(entity, status);
  entity.polygon.fill = false;
  entity.polygon.outline = true;
  entity.polygon.outlineColor = style.color.withAlpha(style.outlineAlpha);
  entity.polygon.heightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
  entity.polygon.extrudedHeightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
  entity.polygon.height = heights.height;
  entity.polygon.extrudedHeight = heights.extrudedHeight;
}

/**
 * 按地物权重设置L22网格颜色，直观表达不同地表要素的通行代价。
 */
function styleL22WeightGridEntity(entity) {
  if (!entity?.polygon) return;
  const status = gridNumberProperty(entity, "effective_status", gridNumberProperty(entity, "status", 0));
  const style = gridWeightStyle(entity, status);
  const bottom = Number(entity.properties?.bottom?.getValue?.() || 0);
  const lift = showTerrain.value ? 1.2 : 0.25;
  entity.polygon.fill = true;
  entity.polygon.material = style.color.withAlpha(Math.min(0.62, style.fillAlpha + 0.22));
  entity.polygon.outline = true;
  entity.polygon.outlineColor = style.color.withAlpha(0.96);
  entity.polygon.heightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
  entity.polygon.extrudedHeightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
  entity.polygon.height = bottom + lift;
  entity.polygon.extrudedHeight = bottom + lift + 1.8;
}

/**
 * 按占用数量和状态设置网格样式，用于展示时间戳占用结果。
 */
function styleAirspaceOccupancyEntity(entity) {
  if (!entity?.polygon) return;
  const uavCount = gridNumberProperty(entity, "occupied_uav_count", 1);
  const heights = groundAttachedGridHeights(entity, 2);
  const color = uavCount > 1
    ? Cesium.Color.fromCssColorString("#ef4444")
    : Cesium.Color.fromCssColorString("#f97316");
  entity.name = "时段占用空域";
  entity.polygon.fill = true;
  entity.polygon.material = color.withAlpha(0.34);
  entity.polygon.outline = true;
  entity.polygon.outlineColor = Cesium.Color.WHITE.withAlpha(0.88);
  entity.polygon.heightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
  entity.polygon.extrudedHeightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
  entity.polygon.height = heights.height;
  entity.polygon.extrudedHeight = heights.extrudedHeight;
}

/**
 * 清理clear grid highlight相关状态，避免旧图层、旧结果或临时数据影响下一次操作。
 */
function clearGridHighlight() {
  if (highlightedGridEntity) {
    styleGridEntity(highlightedGridEntity);
  }
  highlightedGridEntity = null;
}

/**
 * 应用apply grid highlight结果到数据库、实体样式或业务状态中。
 */
function applyGridHighlight(entity) {
  const gridEntities = gridDataSource?.entities?.values || [];
  if (!gridEntities.includes(entity)) return;
  if (highlightedGridEntity && highlightedGridEntity !== entity) {
    styleGridEntity(highlightedGridEntity);
  }
  highlightedGridEntity = entity;
  const heights = groundAttachedGridHeights(entity, 2);
  entity.show = true;
  entity.polygon.fill = false;
  entity.polygon.outline = true;
  entity.polygon.outlineColor = Cesium.Color.WHITE.withAlpha(1);
  entity.polygon.heightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
  entity.polygon.extrudedHeightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
  entity.polygon.height = heights.height;
  entity.polygon.extrudedHeight = heights.extrudedHeight;
}

/**
 * 加载load grid history for entity相关数据，并把结果同步到当前模块状态。
 */
async function loadGridHistoryForEntity(entity) {
  const gridEntities = gridDataSource?.entities?.values || [];
  if (!gridEntities.includes(entity)) {
    clearGridHistory();
    return false;
  }
  const summary = gridEntitySummary(entity);
  if (!summary) {
    clearGridHistory();
    return false;
  }
  selectedGridHistory.value = summary;
  resetGridStateEditor(summary);
  activeControlPanel.value = "control";
  applyGridHighlight(entity);
  gridHistoryRows.value = [];
  gridHistoryError.value = "";
  gridHistoryLoading.value = true;
  try {
    const params = new URLSearchParams({ geosot_id: summary.geosotId });
    const response = await fetch(`${API_BASE}/api/grid-state/history?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "网格历史读取失败");
    gridHistoryRows.value = data.history || [];
  } catch (error) {
    console.warn("网格历史读取失败:", error);
    gridHistoryError.value = error.message || "网格历史读取失败";
  } finally {
    gridHistoryLoading.value = false;
  }
  return true;
}

/**
 * 封装reload selected grid history相关逻辑，保持调用处简洁并便于后续维护。
 */
async function reloadSelectedGridHistory() {
  if (!selectedGridHistory.value?.geosotId) return;
  gridHistoryLoading.value = true;
  gridHistoryError.value = "";
  try {
    const params = new URLSearchParams({ geosot_id: selectedGridHistory.value.geosotId });
    const response = await fetch(`${API_BASE}/api/grid-state/history?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "网格历史读取失败");
    gridHistoryRows.value = data.history || [];
  } catch (error) {
    console.warn("网格历史读取失败:", error);
    gridHistoryError.value = error.message || "网格历史读取失败";
  } finally {
    gridHistoryLoading.value = false;
  }
}

/**
 * 封装submit grid state update相关逻辑，保持调用处简洁并便于后续维护。
 */
async function submitGridStateUpdate() {
  if (!selectedGridHistory.value?.geosotId || gridStateSaving.value) return;
  const flyWeight = Number(gridStateForm.value.flyWeight);
  const trafficDensity = Number(gridStateForm.value.trafficDensity);
  if (!Number.isFinite(flyWeight) || flyWeight < 0.1 || flyWeight > 9.99) {
    gridStateMessage.value = "权重需在0.10-9.99之间";
    return;
  }
  if (!Number.isFinite(trafficDensity) || trafficDensity < 0 || trafficDensity > 99.99) {
    gridStateMessage.value = "流量需在0-99.99之间";
    return;
  }

  gridStateSaving.value = true;
  gridStateMessage.value = "正在保存...";
  try {
    const response = await fetch(`${API_BASE}/api/grid-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        geosotId: selectedGridHistory.value.geosotId,
        status: Number(gridStateForm.value.status),
        flyWeight,
        trafficDensity,
        weatherLimit: Boolean(gridStateForm.value.weatherLimit),
        reason: gridStateForm.value.reason || "人工更新",
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "网格状态更新失败");
    selectedGridHistory.value = normalizeUpdatedGridSummary(selectedGridHistory.value, data.grids?.[0]);
    resetGridStateEditor(selectedGridHistory.value);
    gridStateMessage.value = `已更新 ${data.updated || 0} 个网格`;
    await reloadSelectedGridHistory();
    await refreshCurrentGrid();
    await loadDashboardStats();
  } catch (error) {
    console.warn("网格状态更新失败:", error);
    gridStateMessage.value = error.message || "网格状态更新失败";
  } finally {
    gridStateSaving.value = false;
  }
}

/**
 * 格式化format grid history time显示内容，避免界面和日志直接暴露原始数据结构。
 */
function formatGridHistoryTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

/**
 * 封装grid history status text相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridHistoryStatusText(item) {
  if (item.weather_limit) return "气象限制";
  const status = Number(item.status);
  if (status === 1) return "受限";
  if (status === 0) return "可飞";
  return "更新";
}

/**
 * 获取get picked helipad id对应对象或配置，集中处理选择规则。
 */
function getPickedHelipadId(picked) {
  const entity = picked?.id;
  if (!entity) return null;
  if (entityPropertyValue(entity, "entityType") !== "helipad") return null;
  const id = Number(entityPropertyValue(entity, "helipadId"));
  return Number.isFinite(id) ? id : null;
}

// Cesium 的 picked.id 可能来自点、圆柱或标签，这里只认业务属性，避免误触普通网格。
function getPickedMissionPointType(picked) {
  const entity = picked?.id;
  if (!entity) return null;
  if (entityPropertyValue(entity, "entityType") !== "missionPoint") return null;
  const type = entityPropertyValue(entity, "missionType");
  return type === "start" || type === "end" ? type : null;
}

/**
 * 获取find helipad对应对象或配置，集中处理选择规则。
 */
function findHelipad(padId) {
  return helipads.value.find((item) => item.id === Number(padId)) || null;
}

/**
 * 控制hide helipad context menu的界面展示或相机定位。
 */
function hideHelipadContextMenu() {
  helipadContextMenu.value = {
    visible: false,
    x: 0,
    y: 0,
    pad: null,
  };
}

/**
 * 控制hide helipad info popup的界面展示或相机定位。
 */
function hideHelipadInfoPopup() {
  helipadInfoPopup.value = {
    visible: false,
    x: 0,
    y: 0,
    pad: null,
  };
}

/**
 * 控制hide mission point info popup的界面展示或相机定位。
 */
function hideMissionPointInfoPopup() {
  missionPointInfoPopup.value = {
    visible: false,
    x: 0,
    y: 0,
    type: null,
    point: null,
    gridLevel: "",
  };
}

// 菜单位置基于 Cesium canvas 坐标计算，并限制在可视区域内。
function menuPositionFromCanvas(position, width = 180, height = 130) {
  const canvasRect = viewer.canvas.getBoundingClientRect();
  const x = Math.min(position.x + 10, canvasRect.width - width - 12);
  const y = Math.min(position.y + 10, canvasRect.height - height - 12);
  return {
    x: Math.max(12, x),
    y: Math.max(78, y),
  };
}

/**
 * 控制show mission point info popup的界面展示或相机定位。
 */
function showMissionPointInfoPopup(type, position) {
  const point = type === "start" ? startCoords : endCoords;
  if (!point) return;
  const popupPosition = menuPositionFromCanvas(position, 220, 174);
  missionPointInfoPopup.value = {
    visible: true,
    ...popupPosition,
    type,
    point: { ...point, alt: missionPointDisplayAltitude(point) },
    gridLevel: GRID_CONFIG[currentGridLevel.value]?.label || currentGridLevel.value,
  };
  updateMissionPointInfoPopupPosition();
}

// 起终点标注由多个 Cesium entity 组成，弹窗跟随时优先使用可见的点位实体。
function getMissionPointAnchorCartesian(type) {
  if (!viewer) return null;
  const marker = type === "start" ? startEntity : endEntity;
  const time = viewer.clock.currentTime || Cesium.JulianDate.now();
  const entities = Array.isArray(marker?.entities) ? marker.entities : [];
  const anchorEntity = entities.find((entity) => entity?.point && entity?.position)
    || entities.find((entity) => entity?.cylinder && entity?.position)
    || entities.find((entity) => entity?.position);
  const entityPosition = anchorEntity?.position?.getValue?.(time);
  if (entityPosition) return entityPosition;

  const point = type === "start" ? startCoords : endCoords;
  if (!point) return null;
  return Cesium.Cartesian3.fromDegrees(
    Number(point.lon),
    Number(point.lat),
    missionPointDisplayAltitude(point) + routeGridVisualLift(),
  );
}

// 地图移动、旋转或缩放后，HTML 弹窗需要重新投影到屏幕坐标。
function updateMissionPointInfoPopupPosition() {
  if (!viewer || !missionPointInfoPopup.value.visible || !missionPointInfoPopup.value.type) return;
  const anchor = getMissionPointAnchorCartesian(missionPointInfoPopup.value.type);
  if (!anchor) return;
  const toWindowCoordinates = Cesium.SceneTransforms.worldToWindowCoordinates
    || Cesium.SceneTransforms.wgs84ToWindowCoordinates;
  if (!toWindowCoordinates) return;
  const windowPosition = toWindowCoordinates(viewer.scene, anchor);
  if (!Cesium.defined(windowPosition)) {
    missionPointInfoPopup.value = { ...missionPointInfoPopup.value, visible: false };
    return;
  }
  const canvasRect = viewer.canvas.getBoundingClientRect();
  const wrapperRect = cesiumContainer.value?.parentElement?.getBoundingClientRect?.() || canvasRect;
  const popupWidth = 220;
  const popupHeight = 174;
  const canvasX = windowPosition.x + canvasRect.left - wrapperRect.left;
  const canvasY = windowPosition.y + canvasRect.top - wrapperRect.top;
  const maxX = wrapperRect.width - popupWidth - 12;
  const maxY = wrapperRect.height - popupHeight - 46;
  const x = Math.min(canvasX + 18, maxX);
  const y = Math.min(canvasY - popupHeight - 18, maxY);
  missionPointInfoPopup.value = {
    ...missionPointInfoPopup.value,
    visible: true,
    x: Math.max(12, x),
    y: Math.max(78, y),
  };
}

/**
 * 获取get helipad anchor cartesian对应对象或配置，集中处理选择规则。
 */
function getHelipadAnchorCartesian(pad) {
  if (!pad || !viewer) return null;
  const time = viewer.clock.currentTime || Cesium.JulianDate.now();
  const entity = helipadDataSource?.entities.getById(`helipad-${pad.id}`)
    || helipadDataSource?.entities.getById(`helipad-core-${pad.id}`)
    || helipadDataSource?.entities.getById(`helipad-ring-${pad.id}`);
  const entityPosition = entity?.position?.getValue?.(time);
  if (entityPosition) return entityPosition;
  return Cesium.Cartesian3.fromDegrees(pad.lon, pad.lat, Number(pad.alt || targetAltitude.value || 30) + 12);
}

/**
 * 更新update helipad info popup position状态，使界面、缓存和计算结果保持一致。
 */
function updateHelipadInfoPopupPosition() {
  if (!viewer || !helipadInfoPopup.value.visible || !helipadInfoPopup.value.pad) return;
  const anchor = getHelipadAnchorCartesian(helipadInfoPopup.value.pad);
  if (!anchor) return;
  const toWindowCoordinates = Cesium.SceneTransforms.worldToWindowCoordinates
    || Cesium.SceneTransforms.wgs84ToWindowCoordinates;
  if (!toWindowCoordinates) return;
  const windowPosition = toWindowCoordinates(viewer.scene, anchor);
  if (!Cesium.defined(windowPosition)) {
    helipadInfoPopup.value = { ...helipadInfoPopup.value, visible: false };
    return;
  }
  const canvasRect = viewer.canvas.getBoundingClientRect();
  const wrapperRect = cesiumContainer.value?.parentElement?.getBoundingClientRect?.() || canvasRect;
  const popupWidth = 210;
  const popupHeight = 178;
  const canvasX = windowPosition.x + canvasRect.left - wrapperRect.left;
  const canvasY = windowPosition.y + canvasRect.top - wrapperRect.top;
  const maxX = wrapperRect.width - popupWidth - 12;
  const maxY = wrapperRect.height - popupHeight - 46;
  const x = Math.min(canvasX + 18, maxX);
  const y = Math.min(canvasY - popupHeight - 18, maxY);
  helipadInfoPopup.value = {
    ...helipadInfoPopup.value,
    visible: true,
    x: Math.max(12, x),
    y: Math.max(78, y),
  };
}

/**
 * 控制show helipad info popup的界面展示或相机定位。
 */
function showHelipadInfoPopup(pad) {
  if (!pad || !viewer) return;
  helipadInfoPopup.value = {
    visible: true,
    x: helipadInfoPopup.value.x || 12,
    y: helipadInfoPopup.value.y || 78,
    pad,
  };
  updateHelipadInfoPopupPosition();
}

// postRender 中只做轻量位置同步，避免拖动地图时属性框停留在旧位置。
function initHelipadPopupTracker() {
  if (!viewer || helipadPopupRenderListener) return;
  helipadPopupRenderListener = () => {
    updateHelipadInfoPopupPosition();
    updateMissionPointInfoPopupPosition();
  };
  viewer.scene.postRender.addEventListener(helipadPopupRenderListener);
}

/**
 * 控制show helipad context menu的界面展示或相机定位。
 */
function showHelipadContextMenu(padId, position) {
  const pad = findHelipad(padId);
  if (!pad) return;
  selectedHelipad.value = pad;
  helipadStatus.value = `${pad.code} ${pad.name}：右键菜单已打开`;
  const canvasRect = viewer.canvas.getBoundingClientRect();
  const menuWidth = 148;
  const menuHeight = helipadEditMode.value === "delete" || canReturnFromHelipad(pad) ? 170 : 126;
  const x = Math.min(position.x + 10, canvasRect.width - menuWidth - 12);
  const y = Math.min(position.y + 10, canvasRect.height - menuHeight - 12);
  helipadContextMenu.value = {
    visible: true,
    x: Math.max(12, x),
    y: Math.max(78, y),
    pad,
  };
}

/**
 * 加载load helipads相关数据，并把结果同步到当前模块状态。
 */
async function loadHelipads() {
  if (!viewer) return;
  helipadLoading.value = true;
  try {
    const response = await fetch(`${API_BASE}/api/helipads`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "停机坪读取失败");
    helipads.value = (data.helipads || [])
      .map(normalizeHelipad)
      .filter((pad) => Number.isFinite(pad.id) && Number.isFinite(pad.lon) && Number.isFinite(pad.lat));
    helipadPage.value = Math.min(helipadPage.value, helipadPageCount.value - 1);
    await renderHelipads();
  } catch (error) {
    console.error("停机坪读取失败:", error);
    helipadStatus.value = error.message;
  } finally {
    helipadLoading.value = false;
  }
}

/**
 * 封装pick map point相关逻辑，保持调用处简洁并便于后续维护。
 */
function pickMapPoint(position) {
  if (!viewer || !position) return null;
  let cartesian = viewer.scene.pickPosition(position);
  if (!Cesium.defined(cartesian)) {
    cartesian = viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid);
  }
  if (!cartesian) return null;
  const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
  return {
    lon: Cesium.Math.toDegrees(cartographic.longitude),
    lat: Cesium.Math.toDegrees(cartographic.latitude),
  };
}

/**
 * 设置set camera input enabled状态，并触发必要的后续联动。
 */
function setCameraInputEnabled(enabled) {
  if (!viewer) return;
  const controller = viewer.scene.screenSpaceCameraController;
  controller.enableRotate = enabled;
  controller.enableTranslate = enabled;
  controller.enableZoom = enabled;
  controller.enableTilt = enabled;
  controller.enableLook = enabled;
}

/**
 * 渲染render helipads相关图层或实体，并统一维护Cesium场景状态。
 */
async function renderHelipads() {
  if (!viewer) return;
  if (helipadDataSource) {
    viewer.dataSources.remove(helipadDataSource, true);
    helipadDataSource = null;
  }

  const dataSource = new Cesium.CustomDataSource("helipads");
  const selected = new Set(selectedHelipadIds.value);
  for (const pad of helipads.value) {
    const selectedPad = selected.has(pad.id);
    const floating = await missionPointCartesian(helipadMissionPoint(pad), 12);
    const ground = await missionPointCartesian({ ...helipadMissionPoint(pad), alt: 0 }, 0);
    const groundPosition = Cesium.Cartesian3.fromDegrees(pad.lon, pad.lat, 0);
    const color = selectedPad
      ? Cesium.Color.fromCssColorString("#facc15")
      : Cesium.Color.fromCssColorString("#5eead4");
    const pulseOffset = (pad.id % 7) * 240;

    dataSource.entities.add({
      id: `helipad-ring-${pad.id}`,
      name: `${pad.code} ${pad.name} 动态停机坪`,
      position: groundPosition,
      properties: {
        entityType: "helipad",
        helipadId: pad.id,
      },
      ellipse: {
        semiMajorAxis: selectedPad ? 60 : 46,
        semiMinorAxis: new Cesium.CallbackProperty(() => {
          const pulse = (Math.sin((Date.now() + pulseOffset) / 420) + 1) / 2;
          return selectedPad ? 38 + pulse * 18 : 28 + pulse * 14;
        }, false),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => {
          const pulse = (Math.sin((Date.now() + pulseOffset) / 420) + 1) / 2;
          return color.withAlpha(selectedPad ? 0.22 + pulse * 0.22 : 0.12 + pulse * 0.16);
        }, false)),
        outline: true,
        outlineColor: color.withAlpha(selectedPad ? 0.95 : 0.72),
      },
    });

    dataSource.entities.add({
      id: `helipad-core-${pad.id}`,
      name: `${pad.code} ${pad.name} 停机坪核心`,
      position: groundPosition,
      properties: {
        entityType: "helipad",
        helipadId: pad.id,
      },
      ellipse: {
        semiMajorAxis: selectedPad ? 18 : 14,
        semiMinorAxis: selectedPad ? 18 : 14,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        material: color.withAlpha(selectedPad ? 0.42 : 0.28),
        outline: true,
        outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
      },
    });

    dataSource.entities.add({
      id: `helipad-${pad.id}`,
      name: `${pad.code} ${pad.name}`,
      position: floating,
      properties: {
        entityType: "helipad",
        helipadId: pad.id,
      },
      point: {
        pixelSize: new Cesium.CallbackProperty(() => {
          const pulse = (Math.sin((Date.now() + pulseOffset) / 360) + 1) / 2;
          return (selectedPad ? 17 : 14) + pulse * 4;
        }, false),
        color: new Cesium.CallbackProperty(() => {
          const pulse = (Math.sin((Date.now() + pulseOffset) / 360) + 1) / 2;
          return color.withAlpha(0.78 + pulse * 0.22);
        }, false),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: selectedPad ? 4 : 2,
        heightReference: Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      polyline: {
        positions: [ground, floating],
        width: selectedPad ? 7 : 5,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: selectedPad ? 0.42 : 0.32,
          taperPower: 0.65,
          color: color.withAlpha(selectedPad ? 0.98 : 0.78),
        }),
      },
      label: {
        text: `${pad.code}`,
        font: "bold 13px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: color.withAlpha(0.95),
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -31),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  viewer.dataSources.add(dataSource);
  dataSource.show = showHelipads.value;
  helipadDataSource = dataSource;
}

/**
 * 切换toggle helipads开关状态，并同步界面显示与数据加载。
 */
function toggleHelipads() {
  showHelipads.value = !showHelipads.value;
  if (helipadDataSource) {
    helipadDataSource.show = showHelipads.value;
  }
  helipadStatus.value = showHelipads.value ? "停机坪已显示" : "停机坪已隐藏";
}

/**
 * 设置set helipad mode状态，并触发必要的后续联动。
 */
function setHelipadMode(mode) {
  hideHelipadContextMenu();
  hideHelipadInfoPopup();
  hideMissionPointInfoPopup();
  helipadEditMode.value = helipadEditMode.value === mode ? null : mode;
  currentAction.value = null;
  helipadSelection = [];
  missionStartHelipad.value = null;
  missionEndHelipad.value = null;
  selectedHelipadIds.value = [];
  renderHelipads();
  if (helipadEditMode.value === "add") {
    helipadStatus.value = "添加模式：请在地图上点击新停机坪位置";
  } else if (helipadEditMode.value === "delete") {
    helipadStatus.value = "删除模式：请点击地图上的停机坪";
  } else {
    helipadStatus.value = "点击两个停机坪即可规划航线";
  }
}

/**
 * 控制focus helipad的界面展示或相机定位。
 */
function focusHelipad(pad) {
  if (!viewer || !pad) return;
  selectedHelipad.value = pad;
  helipadStatus.value = `${pad.code} ${pad.name}`;
  const anchor = getHelipadAnchorCartesian(pad);
  if (!anchor) return;
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(anchor, 70), {
    offset: new Cesium.HeadingPitchRange(
      0,
      Cesium.Math.toRadians(-45),
      620,
    ),
    duration: 0.8,
    complete: updateHelipadInfoPopupPosition,
  });
}

/**
 * 创建create helipad at所需的临时表、实体或交互对象。
 */
async function createHelipadAt(point) {
  helipadLoading.value = true;
  try {
    const response = await fetch(`${API_BASE}/api/helipads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `自定义停机坪 ${helipads.value.length + 1}`,
        lon: point.lon,
        lat: point.lat,
        alt: point.alt,
        notes: "前端地图交互新增",
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "停机坪新增失败");
    await loadHelipads();
    const created = normalizeHelipad(data.helipad || {});
    helipadStatus.value = `已添加 ${created.code} ${created.name}`;
  } catch (error) {
    console.error("停机坪新增失败:", error);
    helipadStatus.value = error.message;
  } finally {
    helipadLoading.value = false;
  }
}

/**
 * 封装delete helipad相关逻辑，保持调用处简洁并便于后续维护。
 */
async function deleteHelipad(pad) {
  if (!pad) return;
  hideHelipadContextMenu();
  const confirmed = window.confirm(`确认删除 ${pad.code} ${pad.name}？`);
  if (!confirmed) return;

  helipadLoading.value = true;
  try {
    const response = await fetch(`${API_BASE}/api/helipads/${pad.id}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "停机坪删除失败");
    helipadSelection = helipadSelection.filter((item) => item.id !== pad.id);
    if (missionStartHelipad.value?.id === pad.id) missionStartHelipad.value = null;
    if (missionEndHelipad.value?.id === pad.id) missionEndHelipad.value = null;
    selectedHelipadIds.value = selectedHelipadIds.value.filter((id) => id !== pad.id);
    if (selectedHelipad.value?.id === pad.id) selectedHelipad.value = null;
    if (
      lastCompletedHelipadRoute.value?.startPadId === pad.id
      || lastCompletedHelipadRoute.value?.endPadId === pad.id
    ) {
      lastCompletedHelipadRoute.value = null;
    }
    await loadHelipads();
    helipadStatus.value = `已删除 ${pad.code} ${pad.name}`;
  } catch (error) {
    console.error("停机坪删除失败:", error);
    helipadStatus.value = error.message;
  } finally {
    helipadLoading.value = false;
  }
}

/**
 * 封装handle helipad left click相关逻辑，保持调用处简洁并便于后续维护。
 */
function handleHelipadLeftClick(padId) {
  const pad = findHelipad(padId);
  if (!pad) return;
  selectedHelipad.value = pad;
  showHelipadInfoPopup(pad);
  focusHelipad(pad);
  helipadStatus.value = `${pad.code} ${pad.name} · 经度 ${pad.lon.toFixed(6)} · 纬度 ${pad.lat.toFixed(6)} · 高度 ${pad.alt.toFixed(0)}m`;
}

/**
 * 设置set helipad as mission point状态，并触发必要的后续联动。
 */
async function setHelipadAsMissionPoint(type) {
  const pad = helipadContextMenu.value.pad;
  if (!pad) return;
  hideHelipadContextMenu();
  currentAction.value = null;
  helipadEditMode.value = null;
  selectedHelipad.value = pad;
  await setMissionPoint(type, helipadMissionPoint(pad));

  if (type === "start") {
    missionStartHelipad.value = pad;
    if (missionEndHelipad.value?.id === pad.id) missionEndHelipad.value = null;
    helipadStatus.value = `已设为起点：${pad.code} ${pad.name}`;
  } else {
    missionEndHelipad.value = pad;
    if (missionStartHelipad.value?.id === pad.id) missionStartHelipad.value = null;
    helipadStatus.value = `已设为终点：${pad.code} ${pad.name}`;
  }

  helipadSelection = [missionStartHelipad.value, missionEndHelipad.value].filter(Boolean);
  selectedHelipadIds.value = Array.from(new Set(helipadSelection.map((item) => item.id)));
  await renderHelipads();
  if (startCoords && endCoords) {
    helipadStatus.value = `${helipadStatus.value}，点击“规划路径”开始规划`;
  }
}

/**
 * 判断can return from helipad条件是否成立，供上层流程决定是否继续执行。
 */
function canReturnFromHelipad(pad) {
  return Boolean(
    pad
    && lastCompletedHelipadRoute.value
    && lastCompletedHelipadRoute.value.endPadId === pad.id
    && lastCompletedHelipadRoute.value.startPadId !== pad.id
  );
}

/**
 * 封装return from helipad相关逻辑，保持调用处简洁并便于后续维护。
 */
async function returnFromHelipad() {
  const route = lastCompletedHelipadRoute.value;
  if (!route) return;
  const startPad = findHelipad(route.endPadId);
  const endPad = findHelipad(route.startPadId);
  hideHelipadContextMenu();
  if (!startPad || !endPad) {
    helipadStatus.value = "返航失败：原起终点停机坪不存在";
    return;
  }
  helipadSelection = [startPad, endPad];
  selectedHelipadIds.value = [startPad.id, endPad.id];
  selectedHelipad.value = startPad;
  await setMissionPoint("start", helipadMissionPoint(startPad));
  await setMissionPoint("end", helipadMissionPoint(endPad));
  await renderHelipads();
  helipadStatus.value = `正在返航：${startPad.code} → ${endPad.code}`;
  const plannedRoute = await triggerPlan();
  helipadStatus.value = plannedRoute
    ? `返航完成：${startPad.code} 至 ${endPad.code}`
    : `返航未完成：${startPad.code} 至 ${endPad.code}`;
}

/**
 * 封装delete context helipad相关逻辑，保持调用处简洁并便于后续维护。
 */
async function deleteContextHelipad() {
  const pad = helipadContextMenu.value.pad;
  hideHelipadContextMenu();
  if (pad) await deleteHelipad(pad);
}

/**
 * 格式化format datetime local显示内容，避免界面和日志直接暴露原始数据结构。
 */
function formatDatetimeLocal(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  const offsetMs = value.getTimezoneOffset() * 60 * 1000;
  return new Date(value.getTime() - offsetMs).toISOString().slice(0, 16);
}

/**
 * 规范化normalize control area输入，减少接口参数和内部数据格式差异带来的判断分支。
 */
function normalizeControlArea(raw) {
  return {
    id: Number(raw.id),
    name: raw.name || `管控区 ${raw.id}`,
    west: Number(raw.west),
    south: Number(raw.south),
    east: Number(raw.east),
    north: Number(raw.north),
    start_at: raw.start_at,
    end_at: raw.end_at,
    status: raw.status || "active",
    active_now: Boolean(raw.active_now),
    affected_grid_count: Number(raw.affected_grid_count || 0),
    notes: raw.notes || "",
  };
}

/**
 * 封装control area time label相关逻辑，保持调用处简洁并便于后续维护。
 */
function controlAreaTimeLabel(area) {
  const start = new Date(area.start_at);
  const end = new Date(area.end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "时间未设置";
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${formatter.format(start)}-${formatter.format(end)}`;
}

/**
 * 封装control area bounds from points相关逻辑，保持调用处简洁并便于后续维护。
 */
function controlAreaBoundsFromPoints(start, end) {
  if (!start || !end) return null;
  const bounds = {
    west: Math.min(start.lon, end.lon),
    east: Math.max(start.lon, end.lon),
    south: Math.min(start.lat, end.lat),
    north: Math.max(start.lat, end.lat),
  };
  if (Math.abs(bounds.east - bounds.west) < 1e-7 || Math.abs(bounds.north - bounds.south) < 1e-7) {
    return null;
  }
  return bounds;
}

/**
 * 封装control area color相关逻辑，保持调用处简洁并便于后续维护。
 */
function controlAreaColor(area) {
  if (area?.active_now) return Cesium.Color.fromCssColorString("#fb7185");
  const endMs = new Date(area?.end_at).getTime();
  if (Number.isFinite(endMs) && endMs < Date.now()) return Cesium.Color.fromCssColorString("#94a3b8");
  return Cesium.Color.fromCssColorString("#facc15");
}

/**
 * 封装make control rectangle相关逻辑，保持调用处简洁并便于后续维护。
 */
function makeControlRectangle(bounds) {
  return Cesium.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north);
}

/**
 * 封装control area label相关逻辑，保持调用处简洁并便于后续维护。
 */
function controlAreaLabel(area) {
  if (area.active_now) return `管控中 ${area.name}`;
  if (area.status === "expired") return `历史 ${area.name}`;
  return area.name;
}

/**
 * 维护add control area entity集合，保证场景实体和业务状态同步。
 */
function addControlAreaEntity(dataSource, area, options = {}) {
  const color = controlAreaColor(area);
  const replay = Boolean(options.replay);
  dataSource.entities.add({
    id: `${replay ? "control-area-replay" : "control-area"}-${area.id}`,
    name: area.name,
    position: Cesium.Cartesian3.fromDegrees(
      (area.west + area.east) / 2,
      (area.south + area.north) / 2,
      replay ? 110 : 80,
    ),
    rectangle: {
      coordinates: makeControlRectangle(area),
      height: 0,
      extrudedHeight: replay ? 340 : (area.active_now ? 320 : 160),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      material: color.withAlpha(replay ? 0.3 : (area.active_now ? 0.22 : 0.12)),
      outline: true,
      outlineColor: color.withAlpha(replay ? 1 : (area.active_now ? 0.98 : 0.72)),
    },
    label: {
      text: controlAreaLabel(area),
      font: "bold 12px sans-serif",
      fillColor: Cesium.Color.WHITE,
      outlineColor: color.withAlpha(0.95),
      outlineWidth: 4,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

/**
 * 维护remove control area draft entity集合，保证场景实体和业务状态同步。
 */
function removeControlAreaDraftEntity() {
  if (controlAreaDraftEntity && viewer) {
    viewer.entities.remove(controlAreaDraftEntity);
  }
  controlAreaDraftEntity = null;
}

/**
 * 控制hide control area replay的界面展示或相机定位。
 */
function hideControlAreaReplay() {
  if (controlAreaReplayDataSource && viewer) {
    viewer.dataSources.remove(controlAreaReplayDataSource, true);
  }
  controlAreaReplayDataSource = null;
  activeControlAreaReplayId.value = null;
}

/**
 * 清理clear rendered route相关状态，避免旧图层、旧结果或临时数据影响下一次操作。
 */
function clearRenderedRoute() {
  currentPathEntities.forEach((entity) => viewer.entities.remove(entity));
  currentPathEntities = [];
  stopDroneAnimation();
  activeRouteRender = null;
  pathLen.value = 0;
  pathTime.value = 0;
  flightTime.value = 0;
  routeGridCount.value = 0;
}

// 临时管控区使用矩形草图交互：先在前端预览，保存成功后再写入数据库并刷新网格。
function updateControlAreaDraft(start, end) {
  const bounds = controlAreaBoundsFromPoints(start, end);
  controlAreaDraftBounds.value = bounds;
  removeControlAreaDraftEntity();
  if (!bounds || !viewer) return;
  const color = Cesium.Color.fromCssColorString("#fb7185");
  controlAreaDraftEntity = viewer.entities.add({
    name: "矩形管控区草图",
    rectangle: {
      coordinates: makeControlRectangle(bounds),
      height: 0,
      extrudedHeight: 320,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      material: color.withAlpha(0.18),
      outline: true,
      outlineColor: color.withAlpha(0.95),
    },
  });
}

/**
 * 清理clear control area draft相关状态，避免旧图层、旧结果或临时数据影响下一次操作。
 */
function clearControlAreaDraft() {
  controlAreaDragStart = null;
  controlAreaDrawing.value = false;
  controlAreaDraftBounds.value = null;
  setCameraInputEnabled(true);
  removeControlAreaDraftEntity();
  controlAreaStatus.value = "管控区草图已清除";
}

/**
 * 切换toggle control area drawing开关状态，并同步界面显示与数据加载。
 */
function toggleControlAreaDrawing() {
  hideHelipadContextMenu();
  hideHelipadInfoPopup();
  hideMissionPointInfoPopup();
  clearGridHistory();
  currentAction.value = null;
  helipadEditMode.value = null;
  if (controlAreaDrawing.value) {
    controlAreaDrawing.value = false;
    controlAreaDragStart = null;
    setCameraInputEnabled(true);
    controlAreaStatus.value = "已退出绘制";
    return;
  }
  clearControlAreaDraft();
  controlAreaDrawing.value = true;
  controlAreaStatus.value = "按住左键拖出矩形管控区";
}

/**
 * 加载load control areas相关数据，并把结果同步到当前模块状态。
 */
async function loadControlAreas() {
  if (!viewer) return;
  controlAreaLoading.value = true;
  try {
    const response = await fetch(`${API_BASE}/api/control-areas`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "管控区读取失败");
    controlAreas.value = (data.controlAreas || [])
      .map(normalizeControlArea)
      .filter((area) => Number.isFinite(area.id) && Number.isFinite(area.west) && Number.isFinite(area.east));
    controlAreaPage.value = Math.min(controlAreaPage.value, controlAreaPageCount.value - 1);
    await renderControlAreas();
    controlAreaStatus.value = `已加载 ${controlAreas.value.length} 个管控区`;
  } catch (error) {
    console.error("管控区读取失败:", error);
    controlAreaStatus.value = error.message;
  } finally {
    controlAreaLoading.value = false;
  }
}

/**
 * 渲染render control areas相关图层或实体，并统一维护Cesium场景状态。
 */
async function renderControlAreas() {
  if (!viewer) return;
  if (controlAreaDataSource) {
    viewer.dataSources.remove(controlAreaDataSource, true);
    controlAreaDataSource = null;
  }
  const dataSource = new Cesium.CustomDataSource("control-areas");
  for (const area of controlAreas.value.filter((item) => item.active_now)) {
    addControlAreaEntity(dataSource, area);
  }
  viewer.dataSources.add(dataSource);
  controlAreaDataSource = dataSource;
}

/**
 * 封装save control area相关逻辑，保持调用处简洁并便于后续维护。
 */
async function saveControlArea() {
  if (!controlAreaDraftBounds.value) {
    controlAreaStatus.value = "请先绘制矩形管控区";
    return;
  }
  const start = new Date(controlAreaStartAt.value);
  const end = new Date(controlAreaEndAt.value);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    controlAreaStatus.value = "请设置有效的管控起止时间";
    return;
  }

  controlAreaLoading.value = true;
  try {
    const response = await fetch(`${API_BASE}/api/control-areas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: controlAreaName.value,
        ...controlAreaDraftBounds.value,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        levels: ["L16", "L19", "L22"],
        notes: "前端地图矩形绘制",
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "管控区保存失败");
    clearControlAreaDraft();
    await loadControlAreas();
    await loadDashboardStats();
    await refreshCurrentGrid();
    clearRenderedRoute();
    controlAreaStatus.value = `已保存 ${data.controlArea?.name || "管控区"}，影响 ${data.controlArea?.affected_grid_count || 0} 个网格，请重新规划航线`;
  } catch (error) {
    console.error("管控区保存失败:", error);
    controlAreaStatus.value = error.message;
  } finally {
    controlAreaLoading.value = false;
  }
}

/**
 * 封装delete control area相关逻辑，保持调用处简洁并便于后续维护。
 */
async function deleteControlArea(area) {
  if (!area) return;
  const confirmed = window.confirm(`确认删除 ${area.name}？`);
  if (!confirmed) return;
  controlAreaLoading.value = true;
  try {
    const response = await fetch(`${API_BASE}/api/control-areas/${area.id}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "管控区删除失败");
    if (activeControlAreaReplayId.value === area.id) {
      hideControlAreaReplay();
    }
    await loadControlAreas();
    await loadDashboardStats();
    await refreshCurrentGrid();
    clearRenderedRoute();
    controlAreaStatus.value = `已删除 ${area.name}，清理 ${data.cleared || 0} 个网格，请重新规划航线`;
  } catch (error) {
    console.error("管控区删除失败:", error);
    controlAreaStatus.value = error.message;
  } finally {
    controlAreaLoading.value = false;
  }
}

/**
 * 控制focus control area的界面展示或相机定位。
 */
function focusControlArea(area) {
  if (!viewer || !area) return;
  viewer.camera.flyTo({
    destination: makeControlRectangle(area),
    duration: 0.9,
  });
}

/**
 * 切换toggle control area replay开关状态，并同步界面显示与数据加载。
 */
function toggleControlAreaReplay(area) {
  if (!viewer || !area) return;
  if (activeControlAreaReplayId.value === area.id) {
    hideControlAreaReplay();
    controlAreaStatus.value = `已隐藏 ${area.name}`;
    return;
  }
  hideControlAreaReplay();
  const dataSource = new Cesium.CustomDataSource("control-area-replay");
  addControlAreaEntity(dataSource, area, { replay: true });
  viewer.dataSources.add(dataSource);
  controlAreaReplayDataSource = dataSource;
  activeControlAreaReplayId.value = area.id;
  focusControlArea(area);
  controlAreaStatus.value = `已复现 ${area.name}`;
}

// ==========================================
// 任务与路径规划业务逻辑
// ==========================================

function setAction(action) {
  hideHelipadContextMenu();
  hideHelipadInfoPopup();
  hideMissionPointInfoPopup();
  clearGridHistory();
  if (controlAreaDrawing.value) {
    controlAreaDrawing.value = false;
    controlAreaDragStart = null;
    setCameraInputEnabled(true);
  }
  currentAction.value = action;
  helipadEditMode.value = null;
  helipadSelection = [];
  missionStartHelipad.value = null;
  missionEndHelipad.value = null;
  selectedHelipadIds.value = [];
  selectedHelipad.value = null;
  renderHelipads();
}

/**
 * 清理clear all相关状态，避免旧图层、旧结果或临时数据影响下一次操作。
 */
function clearAll() {
  hideHelipadContextMenu();
  hideHelipadInfoPopup();
  hideMissionPointInfoPopup();
  clearGridHistory();
  clearControlAreaDraft();
  hideControlAreaReplay();
  showAirspaceOccupancy.value = false;
  clearAirspaceOccupancyLayer();
  removeMissionMarker(startEntity);
  removeMissionMarker(endEntity);
  currentPathEntities.forEach(e => viewer.entities.remove(e));
  stopDroneAnimation();
  
  startEntity = null; endEntity = null; startCoords = null; endCoords = null;
  currentPathEntities = []; currentAction.value = null;
  activeRouteRender = null;
  helipadSelection = [];
  missionStartHelipad.value = null;
  missionEndHelipad.value = null;
  selectedHelipadIds.value = [];
  selectedHelipad.value = null;
  lastCompletedHelipadRoute.value = null;
  helipadStatus.value = "已清除当前航线，停机坪保留";
  renderHelipads();
  pathLen.value = 0;
  pathTime.value = 0;
  flightTime.value = 0;
  routeRisk.value = "低";
  routeRiskScore.value = 0;
  maxVerticalRate.value = 0;
  routeGridCount.value = 0;
  planComparisons.value = [];
    activeSavedRouteId.value = null;
}

/**
 * 控制hide saved route replay的界面展示或相机定位。
 */
function hideSavedRouteReplay() {
  removeMissionMarker(startEntity);
  removeMissionMarker(endEntity);
  clearRenderedRoute();
  startEntity = null;
  endEntity = null;
  startCoords = null;
  endCoords = null;
  activeSavedRouteId.value = null;
  planComparisons.value = [];
}

/**
 * 封装route type name相关逻辑，保持调用处简洁并便于后续维护。
 */
function routeTypeName(routeType) {
  if (routeType === "comparison") return "方案对比";
  return "规划航线";
}

/**
 * 构建build route archive name所需的数据结构，供后续查询、渲染或路径计算复用。
 */
function buildRouteArchiveName(routeType) {
  const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
  return `${routeTypeName(routeType)} ${stamp}`;
}

/**
 * 封装archive route display name相关逻辑，保持调用处简洁并便于后续维护。
 */
function archiveRouteDisplayName(route) {
  return String(route?.route_name || "规划航线").replace(/道路巡检|河流巡检/g, "规划航线");
}

/**
 * 规范化normalize daily stats输入，减少接口参数和内部数据格式差异带来的判断分支。
 */
function normalizeDailyStats(rows = []) {
  const source = Array.isArray(rows) ? rows : [];
  if (source.length) {
    return source.map((row) => ({
      label: row.label || "",
      flight_count: Number(row.flight_count || 0),
      distance_m: Number(row.distance_m || 0),
      grid_count: Number(row.grid_count || 0),
    }));
  }
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return {
      label: `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
      flight_count: 0,
      distance_m: 0,
      grid_count: 0,
    };
  });
}

/**
 * 封装make bar series相关逻辑，保持调用处简洁并便于后续维护。
 */
function makeBarSeries(rows, key) {
  const values = rows.map((row) => Number(row[key] || 0));
  const max = Math.max(...values, 1);
  return rows.map((row) => {
    const value = Number(row[key] || 0);
    return {
      label: row.label,
      value,
      height: value > 0 ? Math.max(12, (value / max) * 100) : 4,
    };
  });
}

/**
 * 封装make line points相关逻辑，保持调用处简洁并便于后续维护。
 */
function makeLinePoints(rows, key) {
  const values = rows.map((row) => Number(row[key] || 0));
  const max = Math.max(...values, 1);
  const step = rows.length > 1 ? 240 / (rows.length - 1) : 240;
  return rows.map((row, index) => ({
    label: row.label,
    value: Number(row[key] || 0),
    x: Number((index * step).toFixed(2)),
    y: Number((62 - (Number(row[key] || 0) / max) * 52).toFixed(2)),
  }));
}

/**
 * 封装clamp number相关逻辑，保持调用处简洁并便于后续维护。
 */
function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * 格式化format distance value显示内容，避免界面和日志直接暴露原始数据结构。
 */
function formatDistanceValue(value) {
  const distance = Number(value || 0);
  if (distance >= 1000) return `${(distance / 1000).toFixed(1)} km`;
  return `${distance.toFixed(0)} m`;
}

/**
 * 封装make daily chart payload相关逻辑，保持调用处简洁并便于后续维护。
 */
function makeDailyChartPayload(type, item) {
  const isFlight = type === "flight";
  const isGrid = type === "grid";
  return {
    key: `${type}-${item.label}`,
    title: item.label,
    value: isFlight ? `${item.value} 次` : `${item.value} 格`,
    note: isFlight ? "当天飞行次数" : isGrid ? "当天占用网格数" : "",
  };
}

/**
 * 封装make distance chart payload相关逻辑，保持调用处简洁并便于后续维护。
 */
function makeDistanceChartPayload(point) {
  return {
    key: `distance-${point.label}`,
    title: point.label,
    value: formatDistanceValue(point.value),
    note: "当天飞行里程",
  };
}

/**
 * 封装make control total payload相关逻辑，保持调用处简洁并便于后续维护。
 */
function makeControlTotalPayload() {
  return {
    key: "control-total",
    title: "管控区统计",
    value: `${controlTotalCount.value} 个`,
    note: `管控中 ${dashboardControl.value.active_count || 0} · 历史 ${dashboardControl.value.historical_count || 0} · 待生效 ${dashboardControl.value.scheduled_count || 0}`,
  };
}

/**
 * 封装make control item payload相关逻辑，保持调用处简洁并便于后续维护。
 */
function makeControlItemPayload(item) {
  return {
    key: item.key,
    title: item.label,
    value: `${item.value} 个`,
    note: item.note,
  };
}

/**
 * 更新update chart tooltip position状态，使界面、缓存和计算结果保持一致。
 */
function updateChartTooltipPosition(event, payload) {
  const target = event?.currentTarget;
  const container = target?.closest?.(".center-stats-section");
  if (!container) {
    chartHover.value = payload;
    return;
  }

  const rect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect?.();
  const clientX = Number.isFinite(event.clientX)
    ? event.clientX
    : (targetRect ? targetRect.left + targetRect.width / 2 : rect.left + rect.width / 2);
  const clientY = Number.isFinite(event.clientY)
    ? event.clientY
    : (targetRect ? targetRect.top + targetRect.height / 2 : rect.top + rect.height / 2);

  chartHover.value = {
    ...payload,
    x: clampNumber(clientX - rect.left, 76, Math.max(76, rect.width - 76)),
    y: clampNumber(clientY - rect.top - 10, 46, Math.max(46, rect.height - 8)),
  };
}

/**
 * 控制show chart tooltip的界面展示或相机定位。
 */
function showChartTooltip(event, payload) {
  updateChartTooltipPosition(event, payload);
}

/**
 * 封装move chart tooltip相关逻辑，保持调用处简洁并便于后续维护。
 */
function moveChartTooltip(event) {
  if (!chartHover.value) return;
  updateChartTooltipPosition(event, chartHover.value);
}

/**
 * 控制hide chart tooltip的界面展示或相机定位。
 */
function hideChartTooltip() {
  chartHover.value = null;
}

/**
 * 判断is chart hover条件是否成立，供上层流程决定是否继续执行。
 */
function isChartHover(key) {
  return chartHover.value?.key === key;
}

/**
 * 格式化format route time显示内容，避免界面和日志直接暴露原始数据结构。
 */
function formatRouteTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 加载load dashboard stats相关数据，并把结果同步到当前模块状态。
 */
async function loadDashboardStats() {
  statsLoading.value = true;
  try {
    const response = await fetch(`${API_BASE}/api/dashboard-stats`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "统计数据读取失败");
    dashboardStats.value = {
      daily: normalizeDailyStats(data.daily),
      control: {
        active_count: Number(data.control?.active_count || 0),
        historical_count: Number(data.control?.historical_count || 0),
        scheduled_count: Number(data.control?.scheduled_count || 0),
        active_grid_count: Number(data.control?.active_grid_count || 0),
      },
      totals: {
        total_flights: Number(data.totals?.total_flights || 0),
        total_distance_m: Number(data.totals?.total_distance_m || 0),
        total_grid_count: Number(data.totals?.total_grid_count || 0),
      },
    };
  } catch (err) {
    console.warn("统计数据读取失败:", err);
  } finally {
    statsLoading.value = false;
  }
}

/**
 * 加载load saved routes相关数据，并把结果同步到当前模块状态。
 */
async function loadSavedRoutes() {
  routeArchiveLoading.value = true;
  try {
    const response = await fetch(`${API_BASE}/api/routes?limit=30`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "历史路径读取失败");
    savedRoutes.value = data.routes || [];
    routeArchivePage.value = Math.min(routeArchivePage.value, routeArchivePageCount.value - 1);
  } catch (err) {
    console.warn("历史路径读取失败:", err);
  } finally {
    routeArchiveLoading.value = false;
  }
}

/**
 * 切换toggle route archive开关状态，并同步界面显示与数据加载。
 */
async function toggleRouteArchive() {
  levelMenuOpen.value = false;
  routeArchiveOpen.value = !routeArchiveOpen.value;
  if (routeArchiveOpen.value) {
    await loadSavedRoutes();
  }
}

/**
 * 封装save planned route相关逻辑，保持调用处简洁并便于后续维护。
 */
async function savePlannedRoute(route, start, end, routeType = "mission") {
  try {
    const response = await fetch(`${API_BASE}/api/routes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: buildRouteArchiveName(routeType),
        routeType,
        start,
        end,
        route,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "路径保存失败");
    activeSavedRouteId.value = data.route?.id || null;
    await loadSavedRoutes();
    await loadDashboardStats();
    await loadAirspaceOccupancyStats();
    if (showAirspaceOccupancy.value) await loadAirspaceOccupancyLayer();
  } catch (err) {
    console.warn("路径保存失败:", err);
  }
}

/**
 * 封装route endpoint相关逻辑，保持调用处简洁并便于后续维护。
 */
function routeEndpoint(route) {
  const waypoints = route?.route?.waypoints || [];
  if (!waypoints.length) return null;
  return {
    start: waypoints[0],
    end: waypoints[waypoints.length - 1],
  };
}

/**
 * 封装fly to route相关逻辑，保持调用处简洁并便于后续维护。
 */
function flyToRoute(route) {
  const positions = (route?.route?.waypoints || [])
    .map((point) => Cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.alt || 0));
  if (positions.length < 2) return;
  const sphere = Cesium.BoundingSphere.fromPoints(positions);
  viewer.camera.flyToBoundingSphere(sphere, {
    duration: 1.2,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), Math.max(sphere.radius * 4, 800)),
  });
}

/**
 * 封装replay saved route相关逻辑，保持调用处简洁并便于后续维护。
 */
async function replaySavedRoute(id) {
  try {
    const response = await fetch(`${API_BASE}/api/routes/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "路径复现失败");

    const route = data.route;
    const endpoints = routeEndpoint(route);
    const routeStart = data.route_info?.start || endpoints?.start;
    const routeEnd = data.route_info?.end || endpoints?.end;
    if (!route || !routeStart || !routeEnd) throw new Error("历史路径数据不完整");

    currentPathEntities.forEach(e => viewer.entities.remove(e));
    currentPathEntities = [];
    stopDroneAnimation();
    activeRouteRender = null;
    planComparisons.value = [];
    activeSavedRouteId.value = id;

    await Promise.all([
      setMissionPoint("start", routeStart),
      setMissionPoint("end", routeEnd),
    ]);
    updateRouteMetrics(route, 0);
    await renderPath(route, routeStart, routeEnd);
    flyToRoute(route);
  } catch (err) {
    console.error("路径复现失败:", err);
    alert(`路径复现失败：${err.message}`);
  }
}

/**
 * 切换toggle saved route replay开关状态，并同步界面显示与数据加载。
 */
async function toggleSavedRouteReplay(id) {
  if (activeSavedRouteId.value === id) {
    hideSavedRouteReplay();
    return;
  }
  await replaySavedRoute(id);
}

/**
 * 封装trigger plan相关逻辑，保持调用处简洁并便于后续维护。
 */
async function triggerPlan() {
  if (planningBusy.value) return null;
  hideHelipadContextMenu();
  if (!startCoords || !endCoords) {
    alert("请先选择起点和终点！");
    return null;
  }
  planningBusy.value = true;
  try {
    const plannedRoute = await requestPath(startCoords, endCoords);
    if (plannedRoute && missionStartHelipad.value && missionEndHelipad.value) {
      lastCompletedHelipadRoute.value = {
        startPadId: missionStartHelipad.value.id,
        endPadId: missionEndHelipad.value.id,
      };
      helipadStatus.value = `规划完成：${missionStartHelipad.value.code} → ${missionEndHelipad.value.code}，可在终点右键一键返航`;
    }
    return plannedRoute;
  } finally {
    planningBusy.value = false;
  }
}
/**
 * 封装point inside bounds相关逻辑，保持调用处简洁并便于后续维护。
 */
function pointInsideBounds(point, bounds) {
  return point.lon >= bounds.minLon && point.lon <= bounds.maxLon
    && point.lat >= bounds.minLat && point.lat <= bounds.maxLat;
}

/**
 * 获取choose local level对应对象或配置，集中处理选择规则。
 */
function chooseLocalLevel(point) {
  if (pointInsideBounds(point, GRID_CONFIG.L22.bounds) && (point.alt || 0) < GRID_CONFIG.L22.maxAltitude) return "L22";
  if (pointInsideBounds(point, L19_PLANNING_BOUNDS) && (point.alt || 0) < GRID_CONFIG.L19.maxAltitude) return "L19";
  return "L16";
}

/**
 * 获取choose cruise level对应对象或配置，集中处理选择规则。
 */
function chooseCruiseLevel(start, end) {
  const dist = calculateDistance(start, end);
  const maxAlt = Math.max(start.alt || 0, end.alt || 0);
  if (dist <= 3500
    && maxAlt < GRID_CONFIG.L19.maxAltitude
    && pointInsideBounds(start, L19_PLANNING_BOUNDS)
    && pointInsideBounds(end, L19_PLANNING_BOUNDS)) {
    return "L19";
  }
  return "L16";
}

/**
 * 判断is fine l22 mission条件是否成立，供上层流程决定是否继续执行。
 */
function isFineL22Mission(start, end) {
  return [start, end].every((point) => (
    pointInsideBounds(point, GRID_CONFIG.L22.bounds)
    && Number(point.alt || 0) < GRID_CONFIG.L22.maxAltitude
  ));
}

/**
 * 封装clamp alt for level相关逻辑，保持调用处简洁并便于后续维护。
 */
function clampAltForLevel(alt, level) {
  return Math.max(0, Math.min(alt, GRID_CONFIG[level].maxAltitude - 1));
}

/**
 * 封装same mission point相关逻辑，保持调用处简洁并便于后续维护。
 */
function sameMissionPoint(a, b) {
  return a && b
    && Math.abs(a.lon - b.lon) < 1e-9
    && Math.abs(a.lat - b.lat) < 1e-9
    && Math.abs((a.alt || 0) - (b.alt || 0)) < 0.01;
}

/**
 * 封装interpolate mission point相关逻辑，保持调用处简洁并便于后续维护。
 */
function interpolateMissionPoint(start, end, distanceFromStart, altitude) {
  const total = Math.max(1, calculateDistance(start, end));
  const t = Math.max(0, Math.min(1, distanceFromStart / total));
  return {
    lon: start.lon + (end.lon - start.lon) * t,
    lat: start.lat + (end.lat - start.lat) * t,
    alt: altitude,
  };
}

/**
 * 封装terminal point inside level相关逻辑，保持调用处简洁并便于后续维护。
 */
function terminalPointInsideLevel(start, end, level, distanceFromStart, altitude) {
  let distance = Math.max(0, distanceFromStart);
  const bounds = GRID_CONFIG[level].bounds;
  for (let i = 0; i < 8; i++) {
    const point = interpolateMissionPoint(start, end, distance, altitude);
    if (pointInsideBounds(point, bounds)) return point;
    distance *= 0.5;
  }
  return { ...start, alt: altitude };
}

/**
 * 封装append segment相关逻辑，保持调用处简洁并便于后续维护。
 */
function appendSegment(segments, start, end, level, phase) {
  if (sameMissionPoint(start, end)) return;
  segments.push({ start, end, level, phase });
}

/**
 * 封装append waypoints相关逻辑，保持调用处简洁并便于后续维护。
 */
function appendWaypoints(target, incoming) {
  if (!Array.isArray(incoming)) return;
  incoming.forEach((point) => {
    if (!point) return;
    const normalized = {
      lon: Number(point.lon),
      lat: Number(point.lat),
      alt: Number(point.alt || 0),
    };
    const last = target[target.length - 1];
    if (last && Math.abs(last.lon - normalized.lon) < 1e-9
      && Math.abs(last.lat - normalized.lat) < 1e-9
      && Math.abs(last.alt - normalized.alt) < 0.01) {
      return;
    }
    target.push(normalized);
  });
}

/**
 * 封装append route features相关逻辑，保持调用处简洁并便于后续维护。
 */
function appendRouteFeatures(target, incoming, seen) {
  if (!Array.isArray(incoming)) return;
  for (const feature of incoming) {
    const key = feature?.properties?.geosot_id || JSON.stringify(feature?.geometry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    target.push({
      ...feature,
      properties: {
        ...(feature.properties || {}),
        route_grid: true,
        route_sequence: target.length,
      },
    });
  }
}

// 地形采样是异步网络/地形请求，批量失败时保留平地高度，保证规划流程不中断。
async function sampleTerrainHeights(points) {
  if (!terrainFollowEnabled.value || !viewer?.terrainProvider || !Array.isArray(points) || points.length === 0) {
    return points.map((point) => ({ ...point, height: 0 }));
  }

  try {
    const cartographics = points.map((point) => Cesium.Cartographic.fromDegrees(point.lon, point.lat));
    const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartographics);
    return points.map((point, index) => ({
      ...point,
      height: Number.isFinite(samples[index]?.height) ? samples[index].height : 0,
    }));
  } catch (err) {
    console.warn("地形采样失败，使用0米地形:", err);
    return points.map((point) => ({ ...point, height: 0 }));
  }
}

/**
 * 封装terrain safe mission point相关逻辑，保持调用处简洁并便于后续维护。
 */
async function terrainSafeMissionPoint(point) {
  if (!terrainFollowEnabled.value) return { ...point };
  const [sample] = await sampleTerrainHeights([{ lon: point.lon, lat: point.lat }]);
  const ground = sample?.height || 0;
  const agl = Math.max(Number(point.alt ?? point.agl ?? 0), minAgl.value);
  return {
    ...point,
    // 规划接口使用相对地面高度参与 GeoSOT 垂直层判断，避免 DEM 海拔把任务误推到粗层级。
    alt: agl,
    ground,
    agl,
    absoluteAlt: ground + agl,
  };
}

/**
 * 封装meters to lon degrees相关逻辑，保持调用处简洁并便于后续维护。
 */
function metersToLonDegrees(meters, latitude) {
  return meters / Math.max(1, 111320 * Math.cos(Cesium.Math.toRadians(latitude)));
}

/**
 * 封装meters to lat degrees相关逻辑，保持调用处简洁并便于后续维护。
 */
function metersToLatDegrees(meters) {
  return meters / 110574;
}

/**
 * 构建build terrain profile for segment所需的数据结构，供后续查询、渲染或路径计算复用。
 */
async function buildTerrainProfileForSegment(start, end, level) {
  if (!terrainFollowEnabled.value || !viewer?.terrainProvider) return null;

  const distance = calculateDistance(start, end);
  const spacing = level === "L22" ? 60 : (level === "L19" ? 120 : 260);
  const marginMeters = level === "L22" ? 120 : (level === "L19" ? 260 : 900);
  const centerLat = (start.lat + end.lat) / 2;
  const lonMargin = metersToLonDegrees(marginMeters, centerLat);
  const latMargin = metersToLatDegrees(marginMeters);
  const west = Math.min(start.lon, end.lon) - lonMargin;
  const east = Math.max(start.lon, end.lon) + lonMargin;
  const south = Math.min(start.lat, end.lat) - latMargin;
  const north = Math.max(start.lat, end.lat) + latMargin;

  let lonStep = metersToLonDegrees(spacing, centerLat);
  let latStep = metersToLatDegrees(spacing);
  let lonCount = Math.max(2, Math.ceil((east - west) / lonStep) + 1);
  let latCount = Math.max(2, Math.ceil((north - south) / latStep) + 1);
  while (lonCount * latCount > 625) {
    lonStep *= 1.25;
    latStep *= 1.25;
    lonCount = Math.max(2, Math.ceil((east - west) / lonStep) + 1);
    latCount = Math.max(2, Math.ceil((north - south) / latStep) + 1);
  }

  const samples = [];
  for (let y = 0; y < latCount; y++) {
    const lat = latCount === 1 ? south : south + ((north - south) * y) / (latCount - 1);
    for (let x = 0; x < lonCount; x++) {
      const lon = lonCount === 1 ? west : west + ((east - west) * x) / (lonCount - 1);
      samples.push({ lon, lat });
    }
  }

  const terrainSamples = await sampleTerrainHeights(samples);
  return {
    enabled: true,
    minClearanceM: minAgl.value,
    spacingM: spacing,
    routeDistanceM: distance,
    samples: terrainSamples.map((sample) => ({
      lon: Number(sample.lon.toFixed(8)),
      lat: Number(sample.lat.toFixed(8)),
      height: Number((sample.height || 0).toFixed(2)),
    })),
  };
}

/**
 * 封装summarize route grid features相关逻辑，保持调用处简洁并便于后续维护。
 */
function summarizeRouteGridFeatures(features) {
  const byLevel = {};
  for (const feature of features || []) {
    const level = feature?.properties?.grid_level || "unknown";
    byLevel[level] = (byLevel[level] || 0) + 1;
  }
  return {
    count: (features || []).length,
    by_level: byLevel,
  };
}

/**
 * 计算calculate route risk指标，用于路径评价、界面显示或约束判断。
 */
function calculateRouteRisk(features, metadata) {
  if (metadata?.risk?.level) return metadata.risk.level;
  const maxRisk = Math.max(0, ...features.map((f) => Number(f.properties?.risk_level || 0)));
  if (maxRisk >= 1) return "中";
  return "低";
}

/**
 * 判断can use planning level for segment条件是否成立，供上层流程决定是否继续执行。
 */
function canUsePlanningLevelForSegment(start, end, level) {
  const config = GRID_CONFIG[level];
  if (!config?.bounds) return false;
  return [start, end].every((point) => (
    pointInsideBounds(point, config.bounds)
    && Number(point.alt || 0) < Number(config.maxAltitude || 0)
  ));
}

/**
 * 封装fallback levels for segment相关逻辑，保持调用处简洁并便于后续维护。
 */
function fallbackLevelsForSegment(level, start, end) {
  const candidates = level === "L22"
    ? ["L22", "L19", "L16"]
    : (level === "L19" ? ["L19", "L22", "L16"] : ["L16", "L19", "L22"]);
  return candidates.filter((candidate, index) => (
    candidates.indexOf(candidate) === index
    && canUsePlanningLevelForSegment(start, end, candidate)
  ));
}

/**
 * 判断can try next segment level条件是否成立，供上层流程决定是否继续执行。
 */
function canTryNextSegmentLevel(error) {
  const message = String(error?.message || "");
  if (!([404, 409].includes(Number(error?.statusCode || 0)))) return false;
  return !/地形安全净空|飞行高度必须满足/.test(message);
}

/**
 * 向后端请求单段规划，并把地形剖面、目标函数和时间参数传给搜索服务。
 */
async function requestSegmentPlan(start, end, level, options = {}) {
  const terrain = await buildTerrainProfileForSegment(start, end, level);
  const requestOptions = terrain
    ? { ...options, terrain, minTerrainClearanceM: minAgl.value }
    : options;
  const response = await fetch(`${API_BASE}/api/plan-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start, end, level, options: requestOptions }),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message || `${GRID_CONFIG[level].label} 航段规划失败`);
    error.statusCode = response.status;
    error.level = level;
    throw error;
  }
  return data;
}

/**
 * 完成单段路径规划的主流程：校验点位、取候选网格、搜索、平滑、统计并返回结果。
 */
async function planSegment(start, end, level, options = {}) {
  const levels = options.preferLevelOnly
    ? [level].filter((candidate) => canUsePlanningLevelForSegment(start, end, candidate))
    : fallbackLevelsForSegment(level, start, end);
  let lastError = null;
  for (let index = 0; index < levels.length; index += 1) {
    const candidateLevel = levels[index];
    try {
      if (candidateLevel !== level) {
        console.warn(`${level} 航段不可用，尝试使用 ${candidateLevel} 重新规划`);
      }
      return await requestSegmentPlan(start, end, candidateLevel, {
        ...options,
        fallbackFromLevel: candidateLevel === level ? undefined : level,
      });
    } catch (error) {
      lastError = error;
      if (!canTryNextSegmentLevel(error)) {
        throw error;
      }
    }
  }
  throw lastError || new Error(`${GRID_CONFIG[level]?.label || level} 航段规划失败`);
}

// 一个完整任务可能跨越不同 GeoSOT 层级：起降使用精细网格，远距离段切换到较粗层级。
async function buildMissionRoute(start, end, objective = "balanced") {
  start = await terrainSafeMissionPoint(start);
  end = await terrainSafeMissionPoint(end);
  const cruiseLevel = chooseCruiseLevel(start, end);
  const startLevel = chooseLocalLevel(start);
  const endLevel = chooseLocalLevel(end);
  const missionDistance = calculateDistance(start, end);
  if (isFineL22Mission(start, end)) {
    const finalGeoJSON = {
      type: "FeatureCollection",
      features: [],
      route: { waypoints: [], timeline: [] },
      metadata: {
        objective,
        distance_m: 0,
        estimated_seconds: 0,
        searched_grids: 0,
        raw_grid_path_count: 0,
        total_grids: 0,
        max_vertical_rate_mps: 0,
        grid_corridor: { count: 0, by_level: {} },
        phases: [],
        risk: { score: 0, level: "低" },
      },
    };
    const data = await planSegment(start, end, "L22", {
      objective,
      departureTime: new Date().toISOString(),
      preferLevelOnly: true,
    });
    appendRouteFeatures(finalGeoJSON.features, data.features, new Set());
    appendWaypoints(finalGeoJSON.route.waypoints, data.route?.waypoints);
    finalGeoJSON.route.timeline.push(...(data.route?.timeline || []));
    finalGeoJSON.metadata.distance_m = Number(data.metadata?.distance_m || 0);
    finalGeoJSON.metadata.estimated_seconds = Number(data.metadata?.estimated_seconds || 0);
    finalGeoJSON.metadata.searched_grids = Number(data.metadata?.searched_grids || 0);
    finalGeoJSON.metadata.raw_grid_path_count = Number(data.metadata?.raw_grid_path_count || data.metadata?.total_grids || 0);
    finalGeoJSON.metadata.max_vertical_rate_mps = Number(data.metadata?.max_vertical_rate_mps || 0);
    finalGeoJSON.metadata.risk = data.metadata?.risk || finalGeoJSON.metadata.risk;
    finalGeoJSON.metadata.phases.push({
      phase: "fine-l22-direct",
      level: data.metadata?.level || "L22",
      requested_level: "L22",
      grids: Number(data.metadata?.total_grids || 0),
      distance_m: Number(data.metadata?.distance_m || 0),
    });
    finalGeoJSON.metadata.grid_corridor = summarizeRouteGridFeatures(finalGeoJSON.features);
    finalGeoJSON.metadata.total_grids = finalGeoJSON.metadata.grid_corridor.count;
    await applyTerrainFollowing(finalGeoJSON);
    return finalGeoJSON;
  }
  const cruiseAlt = clampAltForLevel(
    Math.max(UAV_PROFILE.cruiseAltitude, start.alt + 20, end.alt + 20),
    cruiseLevel,
  );

  const stageStartCruise = { ...start, alt: clampAltForLevel(cruiseAlt, startLevel) };
  const stageEndCruise = { ...end, alt: clampAltForLevel(cruiseAlt, endLevel) };
  const usesL22Terminal = startLevel === "L22" || endLevel === "L22";
  const terminalDistanceLimit = usesL22Terminal ? L22_TERMINAL_DISTANCE_M : DEFAULT_TERMINAL_DISTANCE_M;
  const terminalDistance = Math.min(terminalDistanceLimit, missionDistance * 0.28);
  const segments = [];

  if (startLevel === endLevel
    && missionDistance <= 2500
    && (startLevel !== "L22" || missionDistance <= L22_DIRECT_DISTANCE_M)) {
    appendSegment(segments, start, end, startLevel, "local-orthogonal-grid");
  } else {
    const departureExit = terminalPointInsideLevel(
      start,
      end,
      startLevel,
      terminalDistance,
      stageStartCruise.alt,
    );
    const arrivalEntry = terminalPointInsideLevel(
      end,
      start,
      endLevel,
      terminalDistance,
      stageEndCruise.alt,
    );

    appendSegment(segments, start, stageStartCruise, startLevel, "takeoff-climb");
    appendSegment(segments, stageStartCruise, departureExit, startLevel, "takeoff-fine-grid");

    const hasCruiseSegment = calculateDistance(departureExit, arrivalEntry) > 20;
    if (hasCruiseSegment) {
      appendSegment(segments, departureExit, arrivalEntry, cruiseLevel, "cruise");
      appendSegment(segments, arrivalEntry, stageEndCruise, endLevel, "landing-fine-grid");
    } else {
      appendSegment(segments, departureExit, stageEndCruise, startLevel, "short-fine-grid");
    }
    appendSegment(segments, stageEndCruise, end, endLevel, "landing-descent");
  }

  let departureTimeMs = Date.now();
  const seenFeatureKeys = new Set();
  const finalGeoJSON = {
    type: "FeatureCollection",
    features: [],
    route: { waypoints: [], timeline: [] },
    metadata: {
      objective,
      distance_m: 0,
      estimated_seconds: 0,
      searched_grids: 0,
      raw_grid_path_count: 0,
      total_grids: 0,
      max_vertical_rate_mps: 0,
      grid_corridor: { count: 0, by_level: {} },
      phases: [],
      risk: { score: 0, level: "低" },
    },
  };

  for (const segment of segments) {
    const data = await planSegment(segment.start, segment.end, segment.level, {
      objective,
      departureTime: new Date(departureTimeMs).toISOString(),
    });
    appendRouteFeatures(finalGeoJSON.features, data.features, seenFeatureKeys);
    appendWaypoints(finalGeoJSON.route.waypoints, data.route?.waypoints);
    finalGeoJSON.route.timeline.push(...(data.route?.timeline || []));
    finalGeoJSON.metadata.distance_m += Number(data.metadata?.distance_m || 0);
    finalGeoJSON.metadata.estimated_seconds += Number(data.metadata?.estimated_seconds || 0);
    finalGeoJSON.metadata.searched_grids += Number(data.metadata?.searched_grids || 0);
    finalGeoJSON.metadata.raw_grid_path_count += Number(data.metadata?.raw_grid_path_count || data.metadata?.total_grids || 0);
    finalGeoJSON.metadata.total_grids += Number(data.metadata?.total_grids || 0);
    finalGeoJSON.metadata.max_vertical_rate_mps = Math.max(
      finalGeoJSON.metadata.max_vertical_rate_mps,
      Number(data.metadata?.max_vertical_rate_mps || 0),
    );
    if (data.metadata?.risk?.score > finalGeoJSON.metadata.risk.score) {
      finalGeoJSON.metadata.risk = data.metadata.risk;
    }
    const actualLevel = data.metadata?.level || segment.level;
    finalGeoJSON.metadata.phases.push({
      phase: segment.phase,
      level: actualLevel,
      requested_level: segment.level,
      grids: Number(data.metadata?.total_grids || 0),
      distance_m: Number(data.metadata?.distance_m || 0),
    });
    departureTimeMs += Number(data.metadata?.estimated_seconds || 0) * 1000;
  }

  finalGeoJSON.metadata.grid_corridor = summarizeRouteGridFeatures(finalGeoJSON.features);
  finalGeoJSON.metadata.total_grids = finalGeoJSON.metadata.grid_corridor.count;
  await applyTerrainFollowing(finalGeoJSON);
  return finalGeoJSON;
}

// 标准路径规划入口：清理旧图层、请求后端、更新指标、渲染并归档本次航线。
async function requestPath(start, end, objective = "balanced") {
  currentPathEntities.forEach(e => viewer.entities.remove(e));
  currentPathEntities = [];
  stopDroneAnimation();
  activeRouteRender = null;

  const startTime = performance.now();

  try {
    const finalGeoJSON = await buildMissionRoute(start, end, objective);
    const endpoints = routeEndpoint(finalGeoJSON);
    const routeStart = endpoints?.start || start;
    const routeEnd = endpoints?.end || end;
    updateRouteMetrics(finalGeoJSON, performance.now() - startTime);
    await Promise.all([
      setMissionPoint("start", routeStart),
      setMissionPoint("end", routeEnd),
    ]);
    await renderPath(finalGeoJSON, routeStart, routeEnd);
    await savePlannedRoute(finalGeoJSON, routeStart, routeEnd, "mission");
    return finalGeoJSON;
  } catch (err) {
    console.error("航线规划失败:", err);
    alert(`规划失败：${err.message}`);
    return null;
  }
}

/**
 * 更新update route metrics状态，使界面、缓存和计算结果保持一致。
 */
function updateRouteMetrics(route, elapsedMs) {
  pathTime.value = elapsedMs.toFixed(0);
  pathLen.value = Number(route.metadata?.distance_m || 0).toFixed(1);
  flightTime.value = Number(route.metadata?.estimated_seconds || 0).toFixed(0);
  routeRisk.value = calculateRouteRisk(route.features || [], route.metadata);
  routeRiskScore.value = Number(route.metadata?.risk?.score || 0).toFixed(0);
  maxVerticalRate.value = Number(route.metadata?.max_vertical_rate_mps || 0).toFixed(1);
  routeGridCount.value = Number(route.metadata?.grid_corridor?.count || route.features?.length || 0);
}

/**
 * 封装close plan comparison相关逻辑，保持调用处简洁并便于后续维护。
 */
function closePlanComparison() {
  planComparisons.value = [];
}

/**
 * 分别调用不同目标函数和基线算法，形成方案对比面板中的评价数据。
 */
async function comparePlans() {
  if (planningBusy.value) return;
  if (!startCoords || !endCoords) {
    alert("请先选择起点和终点！");
    return;
  }
  planningBusy.value = true;

  currentPathEntities.forEach(e => viewer.entities.remove(e));
  currentPathEntities = [];
  stopDroneAnimation();
  activeRouteRender = null;

  const startTime = performance.now();
  // 同一对起终点依次跑三类改进 A* 目标和 Dijkstra 基线，便于论文中的算法对比。
  const objectives = COMPARISON_OBJECTIVES;
  const results = [];
  let routeToRender = null;

  try {
    for (const objective of objectives) {
      try {
        const objectiveStartTime = performance.now();
        const route = await buildMissionRoute(startCoords, endCoords, objective);
        const elapsedMs = Math.max(1, Math.round(performance.now() - objectiveStartTime));
        results.push({
          objective,
          status: "success",
          name: OBJECTIVE_LABELS[objective],
          distance: Number(route.metadata.distance_m || 0).toFixed(0),
          seconds: Number(route.metadata.estimated_seconds || 0).toFixed(0),
          risk: `${route.metadata.risk?.level || "低"}(${route.metadata.risk?.score || 0})`,
          riskScore: Number(route.metadata.risk?.score || 0).toFixed(0),
          searchedGrids: Number(route.metadata.searched_grids || 0),
          rawGrids: Number(route.metadata.raw_grid_path_count || route.metadata.total_grids || 0),
          grids: Number(route.metadata.grid_corridor?.count || route.features?.length || 0),
          waypoints: Number(route.route?.waypoints?.length || 0),
          elapsedMs,
          algorithm: route.metadata.algorithm || (objective === "baseline" ? "baseline-dijkstra" : "weighted-a-star"),
          route,
        });
        if (objective === "balanced" || !routeToRender) routeToRender = route;
      } catch (err) {
        results.push({
          objective,
          status: "failed",
          name: OBJECTIVE_LABELS[objective],
          message: err.message,
        });
      }
    }

    if (!routeToRender) throw new Error("三种目标均未找到可飞航线");
    const renderedObjective = routeToRender.metadata?.objective || results.find((item) => item.status === "success")?.objective;
    planComparisons.value = results.map(({
      objective,
      status,
      name,
      distance,
      seconds,
      risk,
      riskScore,
      searchedGrids,
      rawGrids,
      grids,
      waypoints,
      elapsedMs,
      algorithm,
      message,
    }) => ({
      objective,
      status,
      name,
      distance,
      seconds,
      risk,
      riskScore,
      searchedGrids,
      rawGrids,
      grids,
      waypoints,
      elapsedMs,
      algorithm,
      message,
      rendered: status === "success" && objective === renderedObjective,
    }));

    const endpoints = routeEndpoint(routeToRender);
    const routeStart = endpoints?.start || startCoords;
    const routeEnd = endpoints?.end || endCoords;
    updateRouteMetrics(routeToRender, performance.now() - startTime);
    await Promise.all([
      setMissionPoint("start", routeStart),
      setMissionPoint("end", routeEnd),
    ]);
    await renderPath(routeToRender, routeStart, routeEnd);
    await savePlannedRoute(routeToRender, routeStart, routeEnd, "comparison");
  } catch (err) {
    console.error("方案对比失败:", err);
    alert(`方案对比失败：${err.message}`);
  } finally {
    planningBusy.value = false;
  }
}

// 大地线距离用于任务指标；三维距离用于航线实际长度和爬升/下降约束。
function calculateDistance(p1, p2) {
    const c1 = Cesium.Cartographic.fromDegrees(p1.lon, p1.lat);
    const c2 = Cesium.Cartographic.fromDegrees(p2.lon, p2.lat);
    return new Cesium.EllipsoidGeodesic(c1, c2).surfaceDistance;
}

/**
 * 计算calculate3d distance指标，用于路径评价、界面显示或约束判断。
 */
function calculate3dDistance(p1, p2) {
  return Cesium.Cartesian3.distance(
    Cesium.Cartesian3.fromDegrees(p1.lon, p1.lat, p1.alt ?? p1.agl ?? 0),
    Cesium.Cartesian3.fromDegrees(p2.lon, p2.lat, p2.alt ?? p2.agl ?? 0),
  );
}

/**
 * 封装turn angle between mission points相关逻辑，保持调用处简洁并便于后续维护。
 */
function turnAngleBetweenMissionPoints(prev, curr, next) {
  const a = Cesium.Cartesian3.fromDegrees(prev.lon, prev.lat, prev.alt ?? prev.agl ?? 0);
  const b = Cesium.Cartesian3.fromDegrees(curr.lon, curr.lat, curr.alt ?? curr.agl ?? 0);
  const c = Cesium.Cartesian3.fromDegrees(next.lon, next.lat, next.alt ?? next.agl ?? 0);
  const ab = Cesium.Cartesian3.subtract(b, a, new Cesium.Cartesian3());
  const bc = Cesium.Cartesian3.subtract(c, b, new Cesium.Cartesian3());
  const abLen = Cesium.Cartesian3.magnitude(ab);
  const bcLen = Cesium.Cartesian3.magnitude(bc);
  if (abLen === 0 || bcLen === 0) return 0;
  const cos = Cesium.Math.clamp(Cesium.Cartesian3.dot(ab, bc) / (abLen * bcLen), -1, 1);
  return Cesium.Math.toDegrees(Math.acos(cos));
}

/**
 * 计算recalc route distance指标，用于路径评价、界面显示或约束判断。
 */
function recalcRouteDistance(waypoints) {
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    total += calculate3dDistance(waypoints[i - 1], waypoints[i]);
  }
  return total;
}

/**
 * 封装waypoint segment seconds相关逻辑，保持调用处简洁并便于后续维护。
 */
function waypointSegmentSeconds(prev, next) {
  const horizontal = calculateDistance(
    { lon: prev.lon, lat: prev.lat },
    { lon: next.lon, lat: next.lat },
  );
  const vertical = (next.alt || 0) - (prev.alt || 0);
  const horizontalSeconds = horizontal / UAV_PROFILE.cruiseSpeed;
  const verticalSeconds = Math.abs(vertical) / (vertical >= 0 ? UAV_PROFILE.climbRate : UAV_PROFILE.descendRate);
  return Math.max(horizontalSeconds, verticalSeconds, 0.1);
}

/**
 * 计算estimate route seconds指标，用于路径评价、界面显示或约束判断。
 */
function estimateRouteSeconds(waypoints) {
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    total += waypointSegmentSeconds(waypoints[i - 1], waypoints[i]);
  }
  return total;
}

/**
 * 计算recalc max vertical rate指标，用于路径评价、界面显示或约束判断。
 */
function recalcMaxVerticalRate(waypoints) {
  let maxRate = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const seconds = waypointSegmentSeconds(waypoints[i - 1], waypoints[i]);
    maxRate = Math.max(maxRate, Math.abs((waypoints[i].alt || 0) - (waypoints[i - 1].alt || 0)) / seconds);
  }
  return maxRate;
}

/**
 * 封装interpolate route point相关逻辑，保持调用处简洁并便于后续维护。
 */
function interpolateRoutePoint(start, end, t) {
  return {
    lon: start.lon + (end.lon - start.lon) * t,
    lat: start.lat + (end.lat - start.lat) * t,
    alt: (start.alt || 0) + ((end.alt || 0) - (start.alt || 0)) * t,
  };
}

/**
 * 封装densify waypoints for terrain相关逻辑，保持调用处简洁并便于后续维护。
 */
function densifyWaypointsForTerrain(waypoints) {
  if (!Array.isArray(waypoints) || waypoints.length <= 1) return waypoints || [];

  const dense = [];
  let totalHorizontal = 0;
  for (let i = 1; i < waypoints.length; i++) {
    totalHorizontal += calculateDistance(waypoints[i - 1], waypoints[i]);
  }
  const spacing = totalHorizontal > 8000 ? 90 : (totalHorizontal > 3000 ? 60 : 35);

  for (let i = 1; i < waypoints.length; i++) {
    const start = waypoints[i - 1];
    const end = waypoints[i];
    const segment = calculateDistance(start, end);
    const steps = Math.max(1, Math.ceil(segment / spacing));
    if (i === 1) dense.push({ ...start });
    for (let s = 1; s <= steps; s++) {
      dense.push(interpolateRoutePoint(start, end, s / steps));
    }
  }
  return dense;
}

// 地形跟随后处理：在后端给出的路径基础上加密采样，保证航点不低于最小离地高度。
async function applyTerrainFollowing(route) {
  const waypoints = route.route?.waypoints;
  if (!terrainFollowEnabled.value || !viewer?.terrainProvider || !Array.isArray(waypoints) || waypoints.length === 0) return;

  try {
    const denseWaypoints = densifyWaypointsForTerrain(waypoints);
    const terrainSamples = await sampleTerrainHeights(denseWaypoints);
    const terrainAwareWaypoints = denseWaypoints.map((point, index) => {
      const groundHeight = Number.isFinite(terrainSamples[index]?.height) ? terrainSamples[index].height : 0;
      const agl = Math.max(Number(point.agl ?? point.alt ?? 0), minAgl.value);
      return {
        ...point,
        ground: groundHeight,
        agl,
        alt: agl,
        absoluteAlt: groundHeight + agl,
      };
    });
    route.route.waypoints = terrainAwareWaypoints;
    route.metadata.distance_m = recalcRouteDistance(terrainAwareWaypoints);
    route.metadata.estimated_seconds = estimateRouteSeconds(terrainAwareWaypoints);
    route.metadata.max_vertical_rate_mps = Math.max(
      route.metadata.max_vertical_rate_mps || 0,
      recalcMaxVerticalRate(terrainAwareWaypoints),
    );
    route.metadata.terrain_follow = {
      enabled: true,
      min_agl_m: minAgl.value,
      sampled_points: terrainAwareWaypoints.length,
    };
  } catch (e) {
    console.warn("地形跟随采样失败，保留原始高度:", e);
  }
}

/**
 * 封装positions length相关逻辑，保持调用处简洁并便于后续维护。
 */
function positionsLength(positions) {
  let total = 0;
  for (let i = 1; i < positions.length; i++) {
    total += Cesium.Cartesian3.distance(positions[i - 1], positions[i]);
  }
  return total;
}

/**
 * 封装interpolate polyline相关逻辑，保持调用处简洁并便于后续维护。
 */
function interpolatePolyline(positions, targetDistance) {
  let travelled = 0;
  for (let i = 1; i < positions.length; i++) {
    const prev = positions[i - 1];
    const next = positions[i];
    const segment = Cesium.Cartesian3.distance(prev, next);
    if (travelled + segment >= targetDistance) {
      const t = segment <= 0 ? 0 : (targetDistance - travelled) / segment;
      return Cesium.Cartesian3.lerp(prev, next, t, new Cesium.Cartesian3());
    }
    travelled += segment;
  }
  return positions[positions.length - 1];
}

/**
 * 封装animated route segment positions相关逻辑，保持调用处简洁并便于后续维护。
 */
function animatedRouteSegmentPositions(positions, progress, fraction = 0.18, sampleCount = 18) {
  if (!Array.isArray(positions) || positions.length < 2) return positions || [];
  const total = positionsLength(positions);
  if (total <= 0) return positions;
  const startDistance = Math.max(0, Math.min(1, progress)) * total;
  const endDistance = Math.min(total, startDistance + total * fraction);
  const steps = Math.max(2, sampleCount);
  const segment = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const distance = startDistance + (endDistance - startDistance) * t;
    segment.push(interpolatePolyline(positions, distance));
  }
  return segment;
}

/**
 * 封装route grid color相关逻辑，保持调用处简洁并便于后续维护。
 */
function routeGridColor(level) {
  if (level === "L22") return Cesium.Color.fromCssColorString("#8b5cf6");
  if (level === "L19") return Cesium.Color.fromCssColorString("#7c3aed");
  return Cesium.Color.fromCssColorString("#a855f7");
}

/**
 * 封装route grid visual lift相关逻辑，保持调用处简洁并便于后续维护。
 */
function routeGridVisualLift() {
  return showTerrain.value ? 5.0 : 1.0;
}

/**
 * 封装base grid visual lift相关逻辑，保持调用处简洁并便于后续维护。
 */
function baseGridVisualLift() {
  return showTerrain.value ? 2.0 : 0.2;
}

/**
 * 封装ground attached grid heights相关逻辑，保持调用处简洁并便于后续维护。
 */
function groundAttachedGridHeights(entity, extraTop = 0) {
  const bottom = Number(entity.properties?.bottom?.getValue?.() || 0);
  const top = Number(entity.properties?.top?.getValue?.() || 0);
  const visualLift = baseGridVisualLift();
  return {
    height: bottom + visualLift,
    extrudedHeight: Math.max(bottom + visualLift + 0.2, top + visualLift + extraTop),
  };
}

/**
 * 规范化normalize route feature输入，减少接口参数和内部数据格式差异带来的判断分支。
 */
function normalizeRouteFeature(feature) {
  const coordinates = feature?.geometry?.coordinates?.[0] || [];
  if (!coordinates.length) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const coordinate of coordinates) {
    west = Math.min(west, Number(coordinate[0]));
    east = Math.max(east, Number(coordinate[0]));
    south = Math.min(south, Number(coordinate[1]));
    north = Math.max(north, Number(coordinate[1]));
  }
  if (![west, south, east, north].every(Number.isFinite)) return null;
  const level = feature.properties?.grid_level || "";
  const bottom = Number(feature.properties?.bottom ?? 0);
  const top = Number(feature.properties?.top ?? (GRID_CONFIG[level] ? bottom + GRID_CONFIG[level].verticalStep : NaN));
  if (!Number.isFinite(bottom) || !Number.isFinite(top)) return null;
  return {
    west,
    south,
    east,
    north,
    bottom,
    top,
    level,
  };
}

/**
 * 封装point in route feature2 d相关逻辑，保持调用处简洁并便于后续维护。
 */
function pointInRouteFeature2D(point, feature) {
  const tolerance = 1e-11;
  return point.lon >= feature.west - tolerance
    && point.lon <= feature.east + tolerance
    && point.lat >= feature.south - tolerance
    && point.lat <= feature.north + tolerance;
}

/**
 * 封装point in route feature3 d相关逻辑，保持调用处简洁并便于后续维护。
 */
function pointInRouteFeature3D(point, feature) {
  const agl = Number(point.agl ?? point.alt ?? 0);
  return pointInRouteFeature2D(point, feature)
    && agl >= feature.bottom - 0.5
    && agl <= feature.top + 0.5;
}

/**
 * 封装route altitude inside grid相关逻辑，保持调用处简洁并便于后续维护。
 */
function routeAltitudeInsideGrid(point, routeFeatures) {
  const sourceAlt = Number(point.agl ?? point.alt ?? 0);
  const candidates = routeFeatures.filter((feature) => pointInRouteFeature2D(point, feature));
  if (!candidates.length) return sourceAlt;

  const altitudeMatch = candidates.find((feature) => sourceAlt >= feature.bottom - 0.5 && sourceAlt <= feature.top + 0.5);
  if (altitudeMatch) return sourceAlt;
  const selected = altitudeMatch || candidates
    .slice()
    .sort((a, b) => Math.abs(((a.bottom + a.top) / 2) - sourceAlt) - Math.abs(((b.bottom + b.top) / 2) - sourceAlt))[0];
  return (selected.bottom + selected.top) / 2;
}

/**
 * 封装interpolate route point for render相关逻辑，保持调用处简洁并便于后续维护。
 */
function interpolateRoutePointForRender(start, end, t) {
  return {
    lon: start.lon + (end.lon - start.lon) * t,
    lat: start.lat + (end.lat - start.lat) * t,
    agl: (start.agl || 0) + ((end.agl || 0) - (start.agl || 0)) * t,
  };
}

/**
 * 封装route polyline within corridor相关逻辑，保持调用处简洁并便于后续维护。
 */
function routePolylineWithinCorridor(points, routeFeatures) {
  if (!routeFeatures.length || points.length < 2) return true;
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1];
    const end = points[i];
    const distance = calculateDistance(start, end);
    const steps = Math.max(1, Math.ceil(distance / 6));
    for (let s = 0; s <= steps; s++) {
      const sample = interpolateRoutePointForRender(start, end, s / steps);
      if (!routeFeatures.some((feature) => pointInRouteFeature3D(sample, feature))) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 封装smooth route render points相关逻辑，保持调用处简洁并便于后续维护。
 */
function smoothRouteRenderPoints(points) {
  // 航线平滑由后端完成：后端会验证曲线经过的所有网格是否可飞，
  // 并把被占用的周围网格一起返回给前端显示。前端不再私自生成新曲线，
  // 避免出现航线占用了未显示/未验证网格的情况。
  return points.map((point) => ({ ...point }));
}

// 渲染线按网格高度重新加密，避免航线在视觉上穿过未占用的网格层。
function densifyRouteRenderPoints(points, routeFeatures) {
  if (!Array.isArray(points) || points.length <= 1) return points || [];
  const densified = [{ ...points[0], agl: routeAltitudeInsideGrid(points[0], routeFeatures) }];

  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1];
    const end = points[i];
    const distance = calculate3dDistance(start, end);
    const steps = Math.max(1, Math.ceil(distance / 2));

    for (let step = 1; step <= steps; step++) {
      const point = interpolateRoutePointForRender(start, end, step / steps);
      densified.push({
        ...point,
        agl: routeAltitudeInsideGrid(point, routeFeatures),
      });
    }
  }

  return densified;
}

/**
 * 构建build route render positions所需的数据结构，供后续查询、渲染或路径计算复用。
 */
async function buildRouteRenderPositions(rawWaypoints, features) {
  const routeFeatures = (features || []).map(normalizeRouteFeature).filter(Boolean);
  const routePoints = (rawWaypoints || [])
    .map((point) => ({
      lon: Number(point.lon),
      lat: Number(point.lat),
      alt: Number(point.alt ?? 0),
      agl: Number(point.agl ?? point.alt ?? 0),
    }))
    .filter((point) => Number.isFinite(point.lon) && Number.isFinite(point.lat));

  if (!routePoints.length) return [];
  const centeredPoints = routePoints.map((point) => ({
    ...point,
    agl: routeAltitudeInsideGrid(point, routeFeatures),
  }));
  const displayPoints = densifyRouteRenderPoints(
    smoothRouteRenderPoints(centeredPoints),
    routeFeatures,
  );
  const terrainSamples = await sampleGridTerrain(displayPoints);
  const lift = routeGridVisualLift();

  return displayPoints.map((point, index) => {
    const terrainHeight = Number(terrainSamples[index]?.height || 0);
    return Cesium.Cartesian3.fromDegrees(point.lon, point.lat, terrainHeight + point.agl + lift);
  });
}

/**
 * 封装grid entity center相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridEntityCenter(entity) {
  const positions = entity.polygon?.hierarchy?.getValue(Cesium.JulianDate.now())?.positions || [];
  if (!positions.length) return null;
  let lon = 0;
  let lat = 0;
  for (const position of positions) {
    const carto = Cesium.Cartographic.fromCartesian(position);
    lon += Cesium.Math.toDegrees(carto.longitude);
    lat += Cesium.Math.toDegrees(carto.latitude);
  }
  return { lon: lon / positions.length, lat: lat / positions.length };
}

/**
 * 封装sample grid terrain相关逻辑，保持调用处简洁并便于后续维护。
 */
async function sampleGridTerrain(points) {
  if (!showTerrain.value || !viewer?.terrainProvider || !Array.isArray(points) || points.length === 0) {
    return points.map((point) => ({ ...point, height: 0 }));
  }

  const results = points.map((point) => ({ ...point, height: 0 }));
  const uncached = [];
  points.forEach((point, index) => {
    const key = `${point.lon.toFixed(6)},${point.lat.toFixed(6)}`;
    if (terrainHeightCache.has(key)) {
      results[index].height = terrainHeightCache.get(key);
    } else {
      uncached.push({ ...point, key, index });
    }
  });

  for (let start = 0; start < uncached.length; start += 250) {
    const chunk = uncached.slice(start, start + 250);
    try {
      const cartographics = chunk.map((point) => Cesium.Cartographic.fromDegrees(point.lon, point.lat));
      const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartographics);
      samples.forEach((sample, index) => {
        const height = Math.max(0, Number.isFinite(sample?.height) ? sample.height : 0);
        const item = chunk[index];
        terrainHeightCache.set(item.key, height);
        results[item.index].height = height;
      });
    } catch (error) {
      chunk.forEach((item) => terrainHeightCache.set(item.key, 0));
    }
  }

  return results;
}

// 网格以相对地形高度显示，避免 DEM 开启后网格沉入地表或悬浮过高。
async function applyTerrainAdjustedGridHeights(entities) {
  const gridEntities = (entities || []).filter((entity) => entity?.polygon);
  if (!gridEntities.length) return;

  gridEntities.forEach((entity) => {
    const bottom = Number(entity.properties?.bottom?.getValue?.() || 0);
    const top = Number(entity.properties?.top?.getValue?.() || 0);
    const isRouteGrid = Boolean(entity.properties?.route_grid?.getValue?.());
    const visualLift = isRouteGrid ? routeGridVisualLift() : baseGridVisualLift();
    entity.polygon.heightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
    entity.polygon.extrudedHeightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
    if (isRouteGrid) {
      entity.polygon.height = bottom + visualLift;
      entity.polygon.extrudedHeight = Math.max(bottom + visualLift + 0.2, top + visualLift);
    } else {
      const heights = groundAttachedGridHeights(entity);
      entity.polygon.height = heights.height;
      entity.polygon.extrudedHeight = heights.extrudedHeight;
    }
  });
}

// 航线渲染由最终网格走廊、发光航线与无人机动画组成。
async function renderPath(data, start, end, options = {}) {
  if ((!data.features || data.features.length === 0) && !data.route?.waypoints?.length) return;
  if (options.remember !== false) {
    activeRouteRender = { data, start, end };
  }

  const dataSource = await Cesium.GeoJsonDataSource.load(data);
  const entities = dataSource.entities.values;
  const rawBackendWaypoints = (data.route?.waypoints || [])
    .map((point) => ({
      lon: Number(point.lon),
      lat: Number(point.lat),
      alt: Number(point.alt ?? 0),
      agl: Number(point.agl ?? point.alt ?? 0),
    }))
    .filter((point) => Number.isFinite(point.lon) && Number.isFinite(point.lat));
  const useBackendWaypoints = rawBackendWaypoints.length >= 2;
  const fallbackRoutePoints = [];

  if (!useBackendWaypoints) {
    fallbackRoutePoints.push({ ...start });
  }

  entities.forEach(entity => {
    if (entity.polygon) {
      const level = entity.properties.grid_level?.getValue() || "";
      const sequence = entity.properties.route_sequence?.getValue();
      const color = routeGridColor(level);
      entity.polygon.fill = true;
      entity.polygon.material = color.withAlpha(level === "L22" ? 0.58 : 0.46);
      entity.polygon.outline = true;
      entity.polygon.outlineColor = Cesium.Color.fromCssColorString("#f5f3ff").withAlpha(1);

      const bottom = Number(entity.properties.bottom?.getValue() || 0);
      const top = Number(entity.properties.top?.getValue() || 10);

      const positions = entity.polygon.hierarchy.getValue(Cesium.JulianDate.now()).positions;
      const centerCartesian = Cesium.BoundingSphere.fromPoints(positions).center;
      const carto = Cesium.Cartographic.fromCartesian(centerCartesian);
      const z = (bottom + top) / 2;

      if (!useBackendWaypoints) {
        fallbackRoutePoints.push({
          lon: Cesium.Math.toDegrees(carto.longitude),
          lat: Cesium.Math.toDegrees(carto.latitude),
          alt: z,
          agl: z,
        });
      }

      entity.name = `最终航线走廊 ${level} #${sequence ?? ""}`;
      entity.description = `
        <table class="cesium-infoBox-defaultTable">
          <tr><th>GeoSOT</th><td>${entity.properties.geosot_id?.getValue() || ""}</td></tr>
          <tr><th>层级</th><td>${level}</td></tr>
          <tr><th>高度</th><td>${bottom}-${top} m</td></tr>
          <tr><th>路径序号</th><td>${sequence ?? ""}</td></tr>
        </table>
      `;

      entity.show = showPath.value;
      viewer.entities.add(entity);
      currentPathEntities.push(entity);
    }
  });

  await applyTerrainAdjustedGridHeights(entities);

  if (!useBackendWaypoints) {
    fallbackRoutePoints.push({ ...end });
  }

  const finalSmoothWaypoints = await buildRouteRenderPositions(
    useBackendWaypoints ? rawBackendWaypoints : fallbackRoutePoints,
    data.features || [],
  );

  if (finalSmoothWaypoints.length >= 2) {
    const underGlow = viewer.entities.add({
      polyline: {
        positions: finalSmoothWaypoints,
        width: 18,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.34,
          taperPower: 0.55,
          color: Cesium.Color.fromCssColorString("#1e1b4b").withAlpha(0.78),
        }),
        clampToGround: false,
      },
      show: showPath.value,
    });

    const energyCore = viewer.entities.add({
      polyline: {
        positions: finalSmoothWaypoints,
        width: 7,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.18,
          taperPower: 0.82,
          color: Cesium.Color.fromCssColorString("#ffffff").withAlpha(0.98),
        }),
        clampToGround: false,
      },
      show: showPath.value,
    });

    const violetTrace = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const progress = (Date.now() % 2600) / 2600;
          return animatedRouteSegmentPositions(finalSmoothWaypoints, progress, 0.22, 24);
        }, false),
        width: 10,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.42,
          taperPower: 0.65,
          color: Cesium.Color.fromCssColorString("#a78bfa").withAlpha(0.98),
        }),
        clampToGround: false,
      },
      show: showPath.value,
    });

    const whiteTrace = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const progress = ((Date.now() + 1200) % 3200) / 3200;
          return animatedRouteSegmentPositions(finalSmoothWaypoints, progress, 0.16, 18);
        }, false),
        width: 8,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.5,
          taperPower: 0.7,
          color: Cesium.Color.fromCssColorString("#f8fafc").withAlpha(0.94),
        }),
        clampToGround: false,
      },
      show: showPath.value,
    });

    currentPathEntities.push(underGlow, energyCore, violetTrace, whiteTrace);
    animateDrone(finalSmoothWaypoints, data);
  }
}


// 示例建筑白模来自 Cesium 3D Tiles，模型坐标存在轻微偏差时用本地 ENU 平移纠偏。
async function loadBuildings() {
  try {
    const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(96188);
    buildingTileset = tileset;
    buildingTileset.show = showBuildings.value;
    viewer.scene.primitives.add(tileset);
    await tileset.readyPromise;

    const basePoint = Cesium.Cartesian3.fromDegrees(118.7892, 31.9141, 0);
    const offsetX = 0; 
    const offsetY = 0;   
    const offsetZ = -10;    

    const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(basePoint);
    const offsetPoint = Cesium.Matrix4.multiplyByPoint(enuToFixed, new Cesium.Cartesian3(offsetX, offsetY, offsetZ), new Cesium.Cartesian3());
    const translationVector = Cesium.Cartesian3.subtract(offsetPoint, basePoint, new Cesium.Cartesian3());
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translationVector);
    tileset.style = new Cesium.Cesium3DTileStyle({ color: 'color("cyan", 0.7)' });
  } catch (e) {
    console.warn("模型加载跳过:", e);
  }
}

/**
 * 封装escape info value相关逻辑，保持调用处简洁并便于后续维护。
 */
function escapeInfoValue(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 加载load jiangning dem terrain相关数据，并把结果同步到当前模块状态。
 */
async function loadJiangningDemTerrain() {
  if (!viewer) return;

  try {
    if (!demTerrainProvider) {
      demTerrainProvider = await Cesium.createWorldTerrainAsync({
        requestWaterMask: true,
        requestVertexNormals: true,
      });
    }
    viewer.terrainProvider = demTerrainProvider;
    terrainStatus.value = "江宁DEM";
  } catch (e) {
    viewer.terrainProvider = ellipsoidTerrainProvider || new Cesium.EllipsoidTerrainProvider();
    terrainStatus.value = "DEM不可用";
    console.warn("江宁DEM加载失败，已回退到椭球地形:", e);
  }
}

/**
 * 加载load case scene layers相关数据，并把结果同步到当前模块状态。
 */
async function loadCaseSceneLayers() {
  await Promise.all([
    loadJiangningBoundaryLayer(),
    loadRoadLayer(),
    loadWaterLayer(),
  ]);
}

/**
 * 封装feature boundary rings相关逻辑，保持调用处简洁并便于后续维护。
 */
function featureBoundaryRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates?.[0] ? [geometry.coordinates[0]] : [];
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates || [])
      .map((polygon) => polygon?.[0])
      .filter((ring) => Array.isArray(ring) && ring.length >= 2);
  }
  return [];
}

/**
 * 加载load jiangning boundary layer相关数据，并把结果同步到当前模块状态。
 */
async function loadJiangningBoundaryLayer() {
  try {
    const response = await fetch(SCENE_DATA.boundary);
    const data = await response.json();
    const dataSource = await Cesium.GeoJsonDataSource.load(data, {
      clampToGround: true,
    });
    dataSource.name = `${SCENE_DATA.label}行政边界`;
    jiangningBoundaryDataSource = dataSource;
    viewer.dataSources.add(dataSource);

    for (const entity of dataSource.entities.values) {
      if (!entity.polygon) continue;
      entity.name = "江宁区行政边界";
      entity.polygon.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
      entity.polygon.material = Cesium.Color.fromCssColorString("#06b6d4").withAlpha(0.14);
      entity.polygon.outline = false;
    }

    for (const feature of data.features || []) {
      for (const ring of featureBoundaryRings(feature.geometry)) {
        const cleanRing = (ring || []).filter((coord) => Number.isFinite(Number(coord[0])) && Number.isFinite(Number(coord[1])));
        if (cleanRing.length < 2) continue;
        const positions = cleanRing.map((coord) => Cesium.Cartesian3.fromDegrees(Number(coord[0]), Number(coord[1]), 0));
        const closedPositions = Cesium.Cartesian3.equals(positions[0], positions[positions.length - 1])
          ? positions
          : [...positions, positions[0]];

        viewer.entities.add({
          name: "江宁区边界外发光",
          polyline: {
            positions: closedPositions,
            width: 9,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.3,
              taperPower: 0.9,
              color: Cesium.Color.fromCssColorString("#22d3ee").withAlpha(0.82),
            }),
            clampToGround: true,
          },
        });

        viewer.entities.add({
          name: "江宁区边界高亮",
          polyline: {
            positions: closedPositions,
            width: 3,
            material: new Cesium.PolylineOutlineMaterialProperty({
              color: Cesium.Color.fromCssColorString("#ecfeff").withAlpha(0.98),
              outlineColor: Cesium.Color.fromCssColorString("#38bdf8").withAlpha(0.9),
              outlineWidth: 1,
            }),
            clampToGround: true,
          },
        });

      }
    }
  } catch (e) {
    console.warn("江宁区行政边界加载失败:", e);
  }
}

/**
 * 加载道路GeoJSON并设置线宽、颜色和贴地显示效果。
 */
async function loadRoadLayer() {
  try {
    const dataSource = await Cesium.GeoJsonDataSource.load(SCENE_DATA.roads, {
      clampToGround: true,
    });
    dataSource.name = `${SCENE_DATA.label}道路`;
    dataSource.show = showRoads.value;
    roadDataSource = dataSource;
    viewer.dataSources.add(dataSource);

    for (const entity of dataSource.entities.values) {
      if (!entity.polyline) continue;
      const highway = entity.properties?.highway?.getValue() || "";
      const widthMeters = Number(entity.properties?.width_m?.getValue() || 0);
      entity.polyline.clampToGround = true;
      entity.polyline.width = roadDisplayWidth(highway, widthMeters);
      entity.polyline.material = roadMaterial(highway);
      entity.polyline.zIndex = 20;
    }
  } catch (e) {
    console.warn("道路场景图层加载失败:", e);
  }
}

/**
 * 加载水系GeoJSON并按线状或面状水体分别渲染。
 */
async function loadWaterLayer() {
  try {
    const dataSource = await Cesium.GeoJsonDataSource.load(SCENE_DATA.water, {
      clampToGround: true,
    });
    dataSource.name = `${SCENE_DATA.label}河流湖泊水系`;
    dataSource.show = showWater.value;
    waterDataSource = dataSource;
    viewer.dataSources.add(dataSource);

    for (const entity of dataSource.entities.values) {
      if (entity.polyline) {
        const waterway = entity.properties?.waterway?.getValue() || "";
        const widthMeters = Number(entity.properties?.width_m?.getValue() || 0);
        entity.polyline.clampToGround = true;
        entity.polyline.width = waterDisplayWidth(waterway, widthMeters);
        entity.polyline.material = new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.18,
          color: Cesium.Color.fromCssColorString("#38bdf8").withAlpha(0.85),
        });
        entity.polyline.zIndex = 18;
      }
      if (entity.polygon) {
        entity.polygon.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
        entity.polygon.material = Cesium.Color.fromCssColorString("#0ea5e9").withAlpha(0.42);
        entity.polygon.outline = true;
        entity.polygon.outlineColor = Cesium.Color.fromCssColorString("#7dd3fc").withAlpha(0.85);
      }
    }
  } catch (e) {
    console.warn("水系场景图层加载失败:", e);
  }
}

/**
 * 封装road display width相关逻辑，保持调用处简洁并便于后续维护。
 */
function roadDisplayWidth(highway, widthMeters = 0) {
  if (widthMeters > 0) return Math.max(2, Math.min(7, widthMeters / 4));
  if (["motorway", "trunk", "primary"].includes(highway)) return 5;
  if (["secondary", "tertiary"].includes(highway)) return 4;
  if (["residential", "unclassified"].includes(highway)) return 3;
  return 2;
}

/**
 * 封装road material相关逻辑，保持调用处简洁并便于后续维护。
 */
function roadMaterial(highway) {
  if (["motorway", "trunk", "primary"].includes(highway)) {
    return Cesium.Color.fromCssColorString("#f59e0b").withAlpha(0.95);
  }
  if (["secondary", "tertiary"].includes(highway)) {
    return Cesium.Color.fromCssColorString("#fde047").withAlpha(0.9);
  }
  if (["footway", "path", "cycleway", "steps"].includes(highway)) {
    return Cesium.Color.fromCssColorString("#94a3b8").withAlpha(0.75);
  }
  return Cesium.Color.fromCssColorString("#e5e7eb").withAlpha(0.82);
}

/**
 * 封装water display width相关逻辑，保持调用处简洁并便于后续维护。
 */
function waterDisplayWidth(waterway, widthMeters = 0) {
  if (widthMeters > 0) return Math.max(2, Math.min(8, widthMeters / 3));
  if (["river", "canal"].includes(waterway)) return 6;
  if (waterway === "stream") return 4;
  return 3;
}

/**
 * 封装grid number property相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridNumberProperty(entity, key, fallback = 0) {
  const value = Number(entity.properties?.[key]?.getValue?.(Cesium.JulianDate.now()) ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 封装clamp01相关逻辑，保持调用处简洁并便于后续维护。
 */
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * 封装grid weight score相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridWeightScore(entity) {
  const flyWeight = gridNumberProperty(entity, "fly_weight", 1);
  const surfaceWeight = gridNumberProperty(entity, "surface_weight", 1);
  const trafficDensity = gridNumberProperty(entity, "traffic_density", 0);
  const riskLevel = gridNumberProperty(entity, "risk_level", 0);
  return clamp01(Math.max(
    (flyWeight - 1) / 19,
    (surfaceWeight - 1) / 19,
    trafficDensity,
    riskLevel / 5,
  ));
}

/**
 * 封装grid string property相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridStringProperty(entity, key, fallback = "") {
  const value = entity.properties?.[key]?.getValue?.(Cesium.JulianDate.now()) ?? fallback;
  return String(value || fallback);
}

/**
 * 封装surface type label相关逻辑，保持调用处简洁并便于后续维护。
 */
function surfaceTypeLabel(type, status = 0) {
  const surfaceType = String(type || "normal");
  const statusValue = Number(status) || 0;
  if (statusValue !== 0 && surfaceType === "building") return "建筑占用禁飞";
  if (surfaceType === "building") return "建筑影响";
  if (surfaceType === "water") return "水域上方";
  if (surfaceType === "road") return "道路上方";
  return "普通空域";
}

/**
 * 封装grid weight style相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridWeightStyle(entity, status) {
  const statusValue = Number(status) || 0;
  const surfaceType = gridStringProperty(entity, "surface_type", "normal");
  if (statusValue !== 0) {
    return {
      label: surfaceTypeLabel(surfaceType, statusValue),
      color: Cesium.Color.fromCssColorString(surfaceType === "building" ? "#e11d48" : "#dc2626"),
      fillAlpha: 0.42,
      outlineAlpha: 0.95,
    };
  }

  if (surfaceType === "water") {
    return {
      label: "水域上方可飞",
      color: Cesium.Color.fromCssColorString("#2563eb"),
      fillAlpha: 0.24,
      outlineAlpha: 0.86,
    };
  }

  if (surfaceType === "road") {
    return {
      label: "道路上方可飞",
      color: Cesium.Color.fromCssColorString("#f59e0b"),
      fillAlpha: 0.22,
      outlineAlpha: 0.82,
    };
  }

  const score = gridWeightScore(entity);
  if (score >= 0.75) {
    return {
      label: "高权重可飞",
      color: Cesium.Color.fromCssColorString("#f97316"),
      fillAlpha: 0.24,
      outlineAlpha: 0.85,
    };
  }
  if (score >= 0.5) {
    return {
      label: "中高权重可飞",
      color: Cesium.Color.fromCssColorString("#facc15"),
      fillAlpha: 0.2,
      outlineAlpha: 0.78,
    };
  }
  if (score >= 0.25) {
    return {
      label: "中权重可飞",
      color: Cesium.Color.fromCssColorString("#a3e635"),
      fillAlpha: 0.16,
      outlineAlpha: 0.68,
    };
  }
  return {
    label: "低权重可飞",
    color: Cesium.Color.fromCssColorString("#16a34a"),
    fillAlpha: 0.11,
    outlineAlpha: 0.52,
  };
}

/**
 * 清理clear grid entity layer相关状态，避免旧图层、旧结果或临时数据影响下一次操作。
 */
function clearGridEntityLayer() {
  clearGridHighlight();
  if (gridDataSource) {
    viewer.dataSources.remove(gridDataSource, true);
    gridDataSource = null;
  }
}

/**
 * 清理clear l22 weight grid layer相关状态，避免旧图层、旧结果或临时数据影响下一次操作。
 */
function clearL22WeightGridLayer() {
  if (l22WeightGridDataSource) {
    viewer.dataSources.remove(l22WeightGridDataSource, true);
    l22WeightGridDataSource = null;
  }
}

/**
 * 清理clear airspace occupancy layer相关状态，避免旧图层、旧结果或临时数据影响下一次操作。
 */
function clearAirspaceOccupancyLayer() {
  if (airspaceOccupancyDataSource) {
    viewer.dataSources.remove(airspaceOccupancyDataSource, true);
    airspaceOccupancyDataSource = null;
  }
}

/**
 * 清理clear merged grid line layer相关状态，避免旧图层、旧结果或临时数据影响下一次操作。
 */
function clearMergedGridLineLayer() {
  if (gridLineDataSource) {
    viewer.dataSources.remove(gridLineDataSource, true);
    gridLineDataSource = null;
  }
}

/**
 * 封装aligned grid boundaries相关逻辑，保持调用处简洁并便于后续维护。
 */
function alignedGridBoundaries(minValue, maxValue, level) {
  const levelNumber = geosotLevelNumber(level);
  const step = cellSizeDegreesForLevel(levelNumber);
  const startIndex = Math.floor((minValue - MIN_GEOSOT_DOMAIN) / step + 1e-10);
  const endIndex = Math.ceil((maxValue - MIN_GEOSOT_DOMAIN) / step - 1e-10);
  const values = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    values.push(MIN_GEOSOT_DOMAIN + index * step);
  }
  return values;
}

/**
 * 封装display bounds for grid level相关逻辑，保持调用处简洁并便于后续维护。
 */
function displayBoundsForGridLevel(level) {
  return geosotLevelNumber(level) >= 22 ? FINE_BOUNDS : JIANGNING_BOUNDS;
}

/**
 * 封装camera focus lon lat相关逻辑，保持调用处简洁并便于后续维护。
 */
function cameraFocusLonLat() {
  if (!viewer) return null;
  const canvas = viewer.scene.canvas;
  const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const ray = viewer.camera.getPickRay(center);
  const cartesian = ray
    ? viewer.scene.globe.pick(ray, viewer.scene) || viewer.camera.pickEllipsoid(center, viewer.scene.globe.ellipsoid)
    : null;
  if (cartesian) {
    const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
    return {
      lon: Cesium.Math.toDegrees(cartographic.longitude),
      lat: Cesium.Math.toDegrees(cartographic.latitude),
    };
  }
  return {
    lon: Cesium.Math.toDegrees(viewer.camera.positionCartographic.longitude),
    lat: Cesium.Math.toDegrees(viewer.camera.positionCartographic.latitude),
  };
}

/**
 * 封装point inside lon lat bounds相关逻辑，保持调用处简洁并便于后续维护。
 */
function pointInsideLonLatBounds(point, bounds) {
  if (!point || !bounds) return false;
  return point.lon >= bounds.minLon && point.lon <= bounds.maxLon
    && point.lat >= bounds.minLat && point.lat <= bounds.maxLat;
}

/**
 * 封装merged grid bounds相关逻辑，保持调用处简洁并便于后续维护。
 */
function mergedGridBounds(w, s, e, n, level) {
  const west = Number(w);
  const south = Number(s);
  const east = Number(e);
  const north = Number(n);
  if (![west, south, east, north].every(Number.isFinite)) {
    return null;
  }
  const displayBounds = displayBoundsForGridLevel(level);
  const minLon = Math.max(Math.min(west, east), displayBounds.minLon, MIN_GEOSOT_DOMAIN);
  const minLat = Math.max(Math.min(south, north), displayBounds.minLat, MIN_GEOSOT_DOMAIN);
  const maxLon = Math.min(Math.max(west, east), displayBounds.maxLon, MAX_GEOSOT_DOMAIN);
  const maxLat = Math.min(Math.max(south, north), displayBounds.maxLat, MAX_GEOSOT_DOMAIN);
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite) || minLon >= maxLon || minLat >= maxLat) {
    return null;
  }
  return { minLon, minLat, maxLon, maxLat };
}

/**
 * 封装grid max axis lines相关逻辑，保持调用处简洁并便于后续维护。
 */
function gridMaxAxisLines(level) {
  const levelNumber = geosotLevelNumber(level);
  const layerCount = visualVerticalLayerCount(level);
  return levelNumber <= 16
    ? 120
    : Math.max(20, Math.min(110, Math.floor(Math.sqrt(GRID_RENDER_LIMIT * 1.8 / Math.max(1, layerCount)))));
}

/**
 * 封装limit grid bounds to render budget相关逻辑，保持调用处简洁并便于后续维护。
 */
function limitGridBoundsToRenderBudget(bounds, level, focusPoint = null) {
  const levelNumber = geosotLevelNumber(level);
  const step = cellSizeDegreesForLevel(levelNumber);
  if (!Number.isFinite(step) || step <= 0) return bounds;
  const lonLineCount = Math.ceil((bounds.maxLon - bounds.minLon) / step) + 1;
  const latLineCount = Math.ceil((bounds.maxLat - bounds.minLat) / step) + 1;
  const maxAxisLines = gridMaxAxisLines(level);
  if (lonLineCount <= maxAxisLines && latLineCount <= maxAxisLines) {
    return bounds;
  }
  const lonSpan = Math.min(bounds.maxLon - bounds.minLon, step * (maxAxisLines - 1));
  const latSpan = Math.min(bounds.maxLat - bounds.minLat, step * (maxAxisLines - 1));
  const useFocus = levelNumber >= 17 && pointInsideLonLatBounds(focusPoint, displayBoundsForGridLevel(level));
  const centerLon = useFocus
    ? clampNumber(focusPoint.lon, bounds.minLon + lonSpan / 2, bounds.maxLon - lonSpan / 2)
    : (bounds.minLon + bounds.maxLon) / 2;
  const centerLat = useFocus
    ? clampNumber(focusPoint.lat, bounds.minLat + latSpan / 2, bounds.maxLat - latSpan / 2)
    : (bounds.minLat + bounds.maxLat) / 2;
  const halfLonSpan = lonSpan / 2;
  const halfLatSpan = latSpan / 2;
  return {
    minLon: Math.max(centerLon - halfLonSpan, bounds.minLon, MIN_GEOSOT_DOMAIN),
    minLat: Math.max(centerLat - halfLatSpan, bounds.minLat, MIN_GEOSOT_DOMAIN),
    maxLon: Math.min(centerLon + halfLonSpan, bounds.maxLon, MAX_GEOSOT_DOMAIN),
    maxLat: Math.min(centerLat + halfLatSpan, bounds.maxLat, MAX_GEOSOT_DOMAIN),
  };
}

/**
 * 封装visual vertical layer count相关逻辑，保持调用处简洁并便于后续维护。
 */
function visualVerticalLayerCount(level) {
  return gridLevelLayerCount(GRID_CONFIG[level] || { key: level });
}

/**
 * 封装visual vertical step相关逻辑，保持调用处简洁并便于后续维护。
 */
function visualVerticalStep(level) {
  return theoreticalGridEdgeLength(GRID_CONFIG[level] || { key: level });
}

/**
 * 封装merged grid line material相关逻辑，保持调用处简洁并便于后续维护。
 */
function mergedGridLineMaterial(level) {
  const levelNumber = geosotLevelNumber(level);
  const alpha = levelNumber >= 20 ? 0.72 : 0.58;
  const color = levelNumber >= 19
    ? Cesium.Color.fromCssColorString("#22c55e")
    : Cesium.Color.fromCssColorString("#14b8a6");
  return color.withAlpha(alpha);
}

/**
 * 封装merged grid line width相关逻辑，保持调用处简洁并便于后续维护。
 */
function mergedGridLineWidth(level) {
  const levelNumber = geosotLevelNumber(level);
  if (levelNumber >= 21) return 0.7;
  if (levelNumber >= 19) return 0.9;
  return 1.1;
}

/**
 * 维护add merged grid polyline集合，保证场景实体和业务状态同步。
 */
function addMergedGridPolyline(dataSource, positions, material, width) {
  dataSource.entities.add({
    polyline: {
      positions,
      width,
      material,
      clampToGround: true,
      zIndex: 12,
    },
  });
}

/**
 * 维护add absolute grid polyline集合，保证场景实体和业务状态同步。
 */
function addAbsoluteGridPolyline(dataSource, positions, material, width) {
  if (!positions || positions.length < 2) return;
  dataSource.entities.add({
    polyline: {
      positions,
      width,
      material,
      depthFailMaterial: material,
      clampToGround: false,
      arcType: Cesium.ArcType.NONE,
    },
  });
}

/**
 * 封装terrain grid key相关逻辑，保持调用处简洁并便于后续维护。
 */
function terrainGridKey(lon, lat) {
  return `${lon.toFixed(10)},${lat.toFixed(10)}`;
}

/**
 * 构建build terrain height lookup所需的数据结构，供后续查询、渲染或路径计算复用。
 */
async function buildTerrainHeightLookup(lonLines, latLines) {
  const points = [];
  lonLines.forEach((lon) => {
    latLines.forEach((lat) => points.push({ lon, lat }));
  });
  const samples = await sampleGridTerrain(points);
  const lookup = new Map();
  samples.forEach((sample) => {
    lookup.set(terrainGridKey(sample.lon, sample.lat), Number(sample.height || 0));
  });
  return lookup;
}

/**
 * 封装terrain adjusted position相关逻辑，保持调用处简洁并便于后续维护。
 */
function terrainAdjustedPosition(lon, lat, relativeHeight, terrainLookup) {
  const terrainHeight = terrainLookup.get(terrainGridKey(lon, lat)) || 0;
  return Cesium.Cartesian3.fromDegrees(lon, lat, terrainHeight + relativeHeight);
}

/**
 * 生成地面贴合的多层三维格网线框，用于表现逐级空域剖分。
 */
async function renderLayeredAirspaceBoxes(dataSource, bounds, lonLines, latLines, level) {
  const layerCount = visualVerticalLayerCount(level);
  const layerStep = visualVerticalStep(level);
  const layerHeights = Array.from(
    { length: layerCount + 1 },
    (_, index) => layerStep * index + (showTerrain.value ? 1.5 : 0.2),
  );
  const shouldSampleTerrain = lonLines.length * latLines.length <= 5000;
  const terrainLookup = shouldSampleTerrain
    ? await buildTerrainHeightLookup(lonLines, latLines)
    : new Map();
  const bottomMaterial = Cesium.Color.fromCssColorString("#0f766e").withAlpha(0.55);
  const middleMaterial = Cesium.Color.fromCssColorString("#2dd4bf").withAlpha(0.52);
  const topMaterial = Cesium.Color.fromCssColorString("#ccfbf1").withAlpha(0.78);
  const sideMaterial = Cesium.Color.WHITE.withAlpha(0.68);

  layerHeights.forEach((height, index) => {
    const material = index === 0
      ? bottomMaterial
      : (index === layerHeights.length - 1 ? topMaterial : middleMaterial);
    const width = index === 0 || index === layerHeights.length - 1 ? 1.15 : 0.65;

    lonLines.forEach((lon) => {
      addAbsoluteGridPolyline(
        dataSource,
        latLines.map((lat) => terrainAdjustedPosition(lon, lat, height, terrainLookup)),
        material,
        width,
      );
    });

    latLines.forEach((lat) => {
      addAbsoluteGridPolyline(
        dataSource,
        lonLines.map((lon) => terrainAdjustedPosition(lon, lat, height, terrainLookup)),
        material,
        width,
      );
    });
  });

  lonLines.forEach((lon) => {
    latLines.forEach((lat) => {
      addAbsoluteGridPolyline(
        dataSource,
        layerHeights.map((height) => terrainAdjustedPosition(lon, lat, height, terrainLookup)),
        sideMaterial,
        1.2,
      );
    });
  });
}

/**
 * 按当前视野绘制合并后的三维网格线，减少实体数量并提升渲染速度。
 */
async function renderMergedGridLines(w, s, e, n, level, requestId) {
  clearGridEntityLayer();
  clearMergedGridLineLayer();

  if (!showAirspaceGrids.value) return;
  if (!viewer || !isOperationalGridLevel(level)) return;

  const focusPoint = cameraFocusLonLat();
  if (geosotLevelNumber(level) >= 17 && !pointInsideLonLatBounds(focusPoint, displayBoundsForGridLevel(level))) {
    return;
  }
  const rawBounds = mergedGridBounds(w, s, e, n, level);
  if (!rawBounds) return;
  const bounds = limitGridBoundsToRenderBudget(rawBounds, level, focusPoint);

  const lonLines = alignedGridBoundaries(bounds.minLon, bounds.maxLon, level);
  const latLines = alignedGridBoundaries(bounds.minLat, bounds.maxLat, level);
  const dataSource = new Cesium.CustomDataSource(`GeoSOT ${level} 合并线网`);

  await renderLayeredAirspaceBoxes(dataSource, bounds, lonLines, latLines, level);

  dataSource.show = showAirspaceGrids.value;
  if (requestId !== gridRenderRequestId) return;
  viewer.dataSources.add(dataSource);
  gridLineDataSource = dataSource;
}

/**
 * 加载数据库网格状态覆盖层，用颜色表达可飞、受限、禁飞等状态。
 */
async function loadGridStateOverlay(w, s, e, n, level, requestId) {
  const config = GRID_CONFIG[level];
  if (!viewer || !config?.databaseBacked || showAirspaceGrids.value || !showObstacleGrids.value) return;

  const params = new URLSearchParams({
    west: String(w),
    south: String(s),
    east: String(e),
    north: String(n),
    level,
    displayAlt: String(targetAltitude.value),
    limit: "8000",
  });
  const response = await fetch(`${API_BASE}/api/university-grids?${params.toString()}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "网格状态图层加载失败");
  if (data.metadata?.synthetic) return;
  if (requestId !== gridRenderRequestId || !Array.isArray(data.features) || data.features.length === 0) return;

  const dataSource = await Cesium.GeoJsonDataSource.load(data);
  if (requestId !== gridRenderRequestId) {
    viewer.dataSources.remove(dataSource, true);
    return;
  }
  dataSource.entities.values.forEach((entity) => {
    styleGridEntity(entity);
  });
  viewer.dataSources.add(dataSource);
  gridDataSource = dataSource;
  updateGridVisibility();
  if (highlightedGridEntity) applyGridHighlight(highlightedGridEntity);
}

/**
 * 加载L22底层权重网格，用于展示道路、水域、建筑等地物对通行代价的影响。
 */
async function loadL22WeightGridLayer() {
  if (!viewer) return;
  clearL22WeightGridLayer();
  const params = new URLSearchParams({
    west: String(FINE_BOUNDS.minLon),
    south: String(FINE_BOUNDS.minLat),
    east: String(FINE_BOUNDS.maxLon),
    north: String(FINE_BOUNDS.maxLat),
    level: "L22",
    displayAlt: "0",
    limit: "50000",
  });
  const response = await fetch(`${API_BASE}/api/university-grids?${params.toString()}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "L22权重网格加载失败");
  if (data.metadata?.synthetic || !Array.isArray(data.features) || data.features.length === 0) return;

  const dataSource = await Cesium.GeoJsonDataSource.load(data);
  dataSource.entities.values.forEach((entity) => {
    styleL22WeightGridEntity(entity);
    entity.name = "L22底层权重网格";
  });
  dataSource.show = showL22WeightGrid.value;
  viewer.dataSources.add(dataSource);
  l22WeightGridDataSource = dataSource;
}

/**
 * 封装occupancy layer bounds相关逻辑，保持调用处简洁并便于后续维护。
 */
function occupancyLayerBounds() {
  return currentViewBounds || FINE_BOUNDS;
}

/**
 * 封装occupancy display level相关逻辑，保持调用处简洁并便于后续维护。
 */
function occupancyDisplayLevel() {
  const level = currentGridLevel.value || "L22";
  return GRID_CONFIG[level]?.databaseBacked ? level : "L22";
}

/**
 * 封装current occupancy iso time相关逻辑，保持调用处简洁并便于后续维护。
 */
function currentOccupancyIsoTime() {
  if (viewer?.clock?.currentTime) {
    return Cesium.JulianDate.toDate(viewer.clock.currentTime).toISOString();
  }
  return new Date().toISOString();
}

/**
 * 加载某一时刻的空域占用网格，用于观察多机占用和路径避让结果。
 */
async function loadAirspaceOccupancyLayer() {
  if (!viewer || airspaceOccupancyLoading) return;
  airspaceOccupancyLoading = true;
  try {
    clearAirspaceOccupancyLayer();
    const bounds = occupancyLayerBounds();
    const params = new URLSearchParams({
      west: String(bounds.minLon ?? bounds.west),
      south: String(bounds.minLat ?? bounds.south),
      east: String(bounds.maxLon ?? bounds.east),
      north: String(bounds.maxLat ?? bounds.north),
      level: occupancyDisplayLevel(),
      at: currentOccupancyIsoTime(),
      limit: "12000",
    });
    const response = await fetch(`${API_BASE}/api/airspace-occupancy/grids?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "空域占用图层加载失败");
    if (!Array.isArray(data.features) || data.features.length === 0) return;

    const dataSource = await Cesium.GeoJsonDataSource.load(data);
    dataSource.entities.values.forEach((entity) => {
      styleAirspaceOccupancyEntity(entity);
    });
    dataSource.show = showAirspaceOccupancy.value;
    viewer.dataSources.add(dataSource);
    airspaceOccupancyDataSource = dataSource;
  } finally {
    airspaceOccupancyLoading = false;
  }
}

/**
 * 统计当前范围内多尺度网格占用数量，为容量分析提供界面数据。
 */
async function loadAirspaceOccupancyStats() {
  try {
    const bounds = occupancyLayerBounds();
    const params = new URLSearchParams({
      west: String(bounds.minLon ?? bounds.west),
      south: String(bounds.minLat ?? bounds.south),
      east: String(bounds.maxLon ?? bounds.east),
      north: String(bounds.maxLat ?? bounds.north),
      levels: "L16,L19,L22",
      at: currentOccupancyIsoTime(),
    });
    const response = await fetch(`${API_BASE}/api/airspace-occupancy/stats?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "空域占用统计读取失败");
    airspaceOccupancyStats.value = Array.isArray(data.levels) ? data.levels : [];
  } catch (err) {
    console.warn("空域占用统计读取失败:", err);
  }
}

// 辅助：普通背景网格按行列合并为线网显示；真实网格仍保留在后端和路径规划结果中。
async function loadGridsInView(w, s, e, n, level) {
  const requestId = ++gridRenderRequestId;
  try {
    await renderMergedGridLines(w, s, e, n, level, requestId);
    await loadGridStateOverlay(w, s, e, n, level, requestId);
  } catch (e) {
    console.error("动态加载网格失败:", e);
  }
}

// 当前动画无人机实体。每次重绘航线前先移除旧实体，避免多个模型同时播放。
let droneEntity = null;

/**
 * 封装stop drone animation相关逻辑，保持调用处简洁并便于后续维护。
 */
function stopDroneAnimation() {
  if (!viewer) return;
  const entityToRemove = droneEntity;
  if (entityToRemove) {
    if (viewer.trackedEntity === entityToRemove) {
      viewer.trackedEntity = undefined;
    }
    viewer.entities.remove(entityToRemove);
    droneEntity = null;
  }
  viewer.clock.shouldAnimate = false;
  viewer.clock.multiplier = 1.0;
}

/**
 * 封装rerender active route相关逻辑，保持调用处简洁并便于后续维护。
 */
async function rerenderActiveRoute() {
  if (!viewer || !activeRouteRender) return;
  const snapshot = activeRouteRender;
  currentPathEntities.forEach((entity) => viewer.entities.remove(entity));
  currentPathEntities = [];
  stopDroneAnimation();
  await renderPath(snapshot.data, snapshot.start, snapshot.end, { remember: false });
  activeRouteRender = snapshot;
}

// 用后端规划时间轴驱动无人机漫游，使动画位置与数据库占用时间保持一致。
function animateDrone(waypoints, routeData = {}) {
  if (waypoints.length < 2) return;

  stopDroneAnimation();

  const positionProperty = new Cesium.SampledPositionProperty();
  const departureMs = Date.parse(routeData?.metadata?.departure_time);
  const startTime = Cesium.JulianDate.fromDate(new Date(Number.isFinite(departureMs) ? departureMs : Date.now()));
  const backendSeconds = Number(routeData?.metadata?.estimated_seconds || 0);
  const segmentDistances = [];
  let totalVisualDistance = 0;
  for (let i = 1; i < waypoints.length; i += 1) {
    const distance = Cesium.Cartesian3.distance(waypoints[i - 1], waypoints[i]);
    segmentDistances.push(distance);
    totalVisualDistance += distance;
  }
  const totalSeconds = backendSeconds > 0
    ? backendSeconds
    : totalVisualDistance / Math.max(1, UAV_PROFILE.cruiseSpeed);
  let timeOffset = 0;
  let traveled = 0;

  // Cesium 会在相邻采样点之间插值，采样点时间由后端规划总时长按视觉航线长度比例分配。
  positionProperty.addSample(startTime, waypoints[0]);

  for (let i = 1; i < waypoints.length; i++) {
    traveled += segmentDistances[i - 1] || 0;
    timeOffset = totalVisualDistance > 0
      ? (traveled / totalVisualDistance) * totalSeconds
      : (i / (waypoints.length - 1)) * totalSeconds;
    
    const time = Cesium.JulianDate.addSeconds(startTime, timeOffset, new Cesium.JulianDate());
    positionProperty.addSample(time, waypoints[i]);
  }

  const stopTime = Cesium.JulianDate.addSeconds(startTime, timeOffset, new Cesium.JulianDate());

  viewer.clock.startTime = startTime.clone();
  viewer.clock.stopTime = stopTime.clone();
  viewer.clock.currentTime = startTime.clone();
  viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
  viewer.clock.multiplier = 1.0;
  viewer.clock.shouldAnimate = true;

  droneEntity = viewer.entities.add({
    availability: new Cesium.TimeIntervalCollection([new Cesium.TimeInterval({
      start: startTime,
      stop: stopTime
    })]),
    position: positionProperty,
    // 如需机头自动朝向航线，可开启 VelocityOrientationProperty；当前模型姿态先保持固定。
    // orientation: new Cesium.VelocityOrientationProperty(positionProperty),
    model: {
      uri: '/drone.glb',
      scale: 0.06,
      minimumPixelSize: 1,
      maximumScale: 4,
    }
  });

  // 需要第一视角演示时再开启跟随，日常操作保持地图自由浏览。
  // viewer.trackedEntity = droneEntity; 
}

</script>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: #05070a;
}

:global(*) {
  box-sizing: border-box;
}

.map-wrapper {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  --ui-panel-bg: rgba(6, 10, 13, 0.52);
  --ui-panel-bg-strong: rgba(9, 16, 22, 0.62);
  --ui-section-bg: rgba(15, 23, 30, 0.36);
  --ui-border: rgba(112, 210, 205, 0.34);
  --ui-border-soft: rgba(148, 163, 184, 0.21);
  --ui-cyan: #67e8f9;
  --ui-mint: #5eead4;
  --ui-green: #86efac;
  --ui-text: #f8fafc;
  --ui-muted: #b7c4d4;
  --frame-top: 64px;
  --frame-bottom: 38px;
  --frame-left: 292px;
  --frame-right: 300px;
  color: #f8fafc;
  font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #05070a;
}

.cesium-container {
  width: 100%;
  height: 100%;
  background-color: #05070a;
}

:deep(.cesium-viewer-toolbar),
:deep(.cesium-viewer-animationContainer),
:deep(.cesium-viewer-timelineContainer),
:deep(.cesium-viewer-bottom),
:deep(.cesium-widget-credits),
:deep(.cesium-credit-logoContainer),
:deep(.cesium-credit-textContainer) {
  display: none !important;
}

.dashboard-header,
.dashboard-panel,
.coordinate-panel {
  position: absolute;
  z-index: 999;
  border: 1px solid var(--ui-border);
  background: var(--ui-panel-bg);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.34);
  backdrop-filter: blur(8px) saturate(1.12);
}

.dashboard-header {
  top: 0;
  left: 0;
  right: 0;
  transform: none;
  width: auto;
  min-width: 0;
  height: var(--frame-top);
  border-radius: 0;
  padding: 9px calc(var(--frame-right) + 18px) 9px calc(var(--frame-left) + 18px);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  border-top: 0;
  border-left: 0;
  border-right: 0;
}

.system-title {
  min-width: 0;
  text-align: center;
}

.system-kicker {
  display: block;
  margin-top: 4px;
  color: var(--ui-cyan);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0;
}

.system-title h1 {
  margin: 0;
  color: var(--ui-text);
  font-size: 22px;
  line-height: 1.1;
  font-weight: 800;
  letter-spacing: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-status {
  position: absolute;
  top: 50%;
  right: 18px;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
  color: #d1fae5;
  font-size: 11px;
  font-weight: 700;
}

.header-status span {
  min-height: 22px;
  padding: 4px 7px;
  border-radius: 4px;
  background: rgba(20, 184, 166, 0.12);
  border: 1px solid rgba(45, 212, 191, 0.2);
  white-space: nowrap;
}

.header-meta {
  position: absolute;
  left: 18px;
  top: 50%;
  width: min(392px, calc(var(--frame-left) + 92px));
  min-height: 42px;
  transform: translateY(-50%);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  padding: 0;
  overflow: hidden;
}

.meta-clock,
.meta-weather {
  min-width: 0;
  display: grid;
  gap: 2px;
  align-content: center;
}

.meta-clock strong,
.meta-weather strong {
  color: #f8fafc;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 19px;
  line-height: 1;
  font-weight: 900;
  letter-spacing: 0;
  white-space: nowrap;
}

.meta-weather strong {
  color: #a7f3d0;
  font-family: inherit;
  font-size: 18px;
}

.meta-clock span,
.meta-weather span {
  min-width: 0;
  color: #9ed7e5;
  font-size: 12px;
  line-height: 1.1;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dashboard-panel {
  top: var(--frame-top);
  bottom: var(--frame-bottom);
  width: var(--frame-left);
  border-radius: 0;
  padding: 9px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #38bdf8 rgba(15, 23, 42, 0.4);
}

.left-panel {
  left: 0;
  border-left: 0;
}

.right-panel {
  right: 0;
  width: var(--frame-right);
  border-right: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.right-panel-main {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
  scrollbar-width: thin;
  scrollbar-color: #38bdf8 rgba(15, 23, 42, 0.4);
}

.right-panel-main .panel-section:last-child {
  margin-bottom: 0;
}

.panel-section {
  padding: 10px;
  margin-bottom: 9px;
  border-radius: 7px;
  border: 1px solid var(--ui-border-soft);
  background: var(--ui-section-bg);
}

.panel-section:last-child {
  margin-bottom: 0;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 21px;
  margin-bottom: 8px;
  color: #e2e8f0;
  font-size: 12px;
  font-weight: 800;
}

.section-title::after {
  content: "";
  flex: 1;
  height: 1px;
  margin-left: 10px;
  background: rgba(45, 212, 191, 0.28);
}

.section-actions {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex: 0 0 auto;
}

.section-pager,
.archive-tools {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.section-pager button,
.archive-tools button {
  min-width: 22px;
  min-height: 20px;
  padding: 2px 6px;
  font-size: 10px;
  line-height: 1;
}

.section-pager em,
.archive-tools em {
  color: #a7f3d0;
  font-size: 9px;
  font-style: normal;
  font-weight: 800;
  white-space: nowrap;
}

button,
select,
input {
  font: inherit;
}

button {
  min-height: 30px;
  padding: 6px 8px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 5px;
  background: rgba(30, 41, 59, 0.68);
  color: #e5e7eb;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.2;
  transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease, transform 0.18s ease;
  white-space: nowrap;
}

button:hover {
  background: rgba(51, 65, 85, 0.82);
  border-color: rgba(125, 211, 252, 0.42);
  transform: translateY(-1px);
}

button:disabled {
  cursor: wait;
  opacity: 0.55;
}

button.active {
  color: #022c22;
  border-color: rgba(94, 234, 212, 0.72);
  background: var(--ui-mint);
}

.plan-btn {
  color: #06240f;
  background: var(--ui-green);
  border-color: rgba(187, 247, 208, 0.86);
  font-weight: 800;
}

.plan-btn:hover {
  background: #bbf7d0;
}

.clear-btn {
  color: #fff7ed;
  background: #dc2626;
  border-color: rgba(254, 202, 202, 0.48);
}

.clear-btn:hover {
  background: #ef4444;
}

.action-grid,
.toggle-grid {
  display: grid;
  gap: 6px;
}

.two-columns {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.three-columns {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.primary-actions {
  margin: 6px 0;
}

.toggle-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.field-label {
  display: block;
  margin: 10px 0 5px;
  color: #cbd5e1;
  font-size: 11px;
  font-weight: 700;
}

.level-picker {
  position: relative;
  width: 100%;
}

.level-toggle {
  width: 100%;
  height: 32px;
  padding: 0 9px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid rgba(125, 211, 252, 0.35);
  border-radius: 5px;
  background: rgba(2, 6, 23, 0.68);
  color: #e0f2fe;
  font-size: 12px;
  outline: none;
}

.level-toggle:hover {
  transform: none;
}

.level-toggle span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.level-toggle small {
  margin-left: auto;
  color: inherit;
  font-size: 9.5px;
  font-weight: 800;
  line-height: 1;
  opacity: 0.78;
  white-space: nowrap;
}

.level-toggle i {
  width: 7px;
  height: 7px;
  border-right: 2px solid #67e8f9;
  border-bottom: 2px solid #67e8f9;
  transform: rotate(45deg) translateY(-2px);
  flex: 0 0 auto;
}

.level-toggle.active i {
  transform: rotate(225deg) translateY(-1px);
}

.level-menu {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 1002;
  width: 100%;
  max-height: 188px;
  margin-top: 0;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid rgba(125, 211, 252, 0.28);
  border-radius: 5px;
  background: rgba(2, 6, 23, 0.74);
  box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.72);
  scrollbar-width: thin;
  scrollbar-color: #38bdf8 rgba(15, 23, 42, 0.58);
}

.level-option {
  width: 100%;
  min-height: 28px;
  padding: 5px 7px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 0;
  border-bottom: 1px solid rgba(148, 163, 184, 0.11);
  border-radius: 3px;
  background: transparent;
  color: #dbeafe;
  font-size: 12px;
  text-align: left;
}

.level-option:last-child {
  border-bottom: 0;
}

.level-option:hover {
  transform: none;
  background: rgba(14, 116, 144, 0.45);
}

.level-option.active {
  color: #022c22;
  background: #5eead4;
}

.level-option span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.level-option small {
  color: inherit;
  font-size: 10px;
  opacity: 0.78;
  flex: 0 0 auto;
  white-space: nowrap;
}

.helipad-overview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px;
  gap: 3px 8px;
  align-items: center;
  min-height: 48px;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid rgba(94, 234, 212, 0.22);
  background: rgba(8, 47, 73, 0.24);
}

.helipad-overview span,
.helipad-overview em {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.helipad-overview span {
  color: #cbd5e1;
  font-size: 11px;
  font-weight: 800;
}

.helipad-overview strong {
  grid-row: 1 / span 2;
  grid-column: 2;
  color: #5eead4;
  font-size: 24px;
  line-height: 1;
  font-weight: 900;
  text-align: right;
}

.helipad-overview em {
  color: #bae6fd;
  font-size: 10px;
  font-style: normal;
  font-weight: 700;
}

.helipad-actions {
  margin-top: 7px;
}

.helipad-toggle-row {
  margin-top: 7px;
}

.helipad-visibility-btn {
  width: 100%;
}

.helipad-hint {
  min-height: 30px;
  margin: 7px 0;
  padding: 6px 8px;
  border-left: 3px solid #5eead4;
  border-radius: 5px;
  background: rgba(20, 184, 166, 0.08);
  color: #ccfbf1;
  font-size: 11px;
  line-height: 1.45;
}

.helipad-list {
  display: grid;
  gap: 5px;
  max-height: 138px;
  overflow-y: auto;
  padding-right: 2px;
}

.helipad-row {
  display: block;
  width: 100%;
  min-height: 43px;
  padding: 7px 8px;
  text-align: left;
  white-space: normal;
  background: rgba(2, 6, 23, 0.48);
}

.helipad-row span,
.helipad-row small {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.helipad-row span {
  color: #f8fafc;
  font-size: 11px;
  font-weight: 800;
}

.helipad-row small {
  margin-top: 4px;
  color: #a7f3d0;
  font-size: 10px;
}

.helipad-row.active {
  border-color: rgba(250, 204, 21, 0.72);
  background: rgba(113, 63, 18, 0.38);
}

.helipad-detail {
  display: grid;
  gap: 3px;
  padding: 7px 8px;
  border: 1px solid rgba(94, 234, 212, 0.28);
  background: rgba(4, 20, 28, 0.46);
  color: #d8fbff;
}

.helipad-detail div {
  display: grid;
  gap: 2px;
}

.helipad-detail span,
.helipad-detail small {
  color: #9fb8c7;
  font-size: 10px;
}

.helipad-detail strong {
  color: #f8fafc;
  font-size: 11px;
  line-height: 1.25;
}

.helipad-empty {
  padding: 8px 0 2px;
  color: #94a3b8;
  font-size: 11px;
}

.control-area-section {
  gap: 9px;
}

.control-input,
.time-grid input {
  width: 100%;
  min-width: 0;
  border: 1px solid rgba(103, 232, 249, 0.18);
  border-radius: 4px;
  background: rgba(4, 12, 20, 0.52);
  color: #ddfbff;
  font-size: 11px;
  font-weight: 700;
  outline: none;
}

.control-input {
  height: 30px;
  padding: 0 9px;
}

.time-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.time-grid label {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.time-grid span {
  color: #90aebb;
  font-size: 10px;
  font-weight: 800;
}

.time-grid input {
  height: 29px;
  padding: 0 6px;
  color-scheme: dark;
  font-size: 10px;
}

.control-hint {
  min-height: 28px;
  padding: 7px 8px;
  border: 1px solid rgba(250, 204, 21, 0.24);
  background: rgba(250, 204, 21, 0.08);
  color: #e8f7bb;
  font-size: 10px;
  line-height: 1.35;
}

.weather-control-section {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-bottom: 6px;
}

.weather-control-section .section-title {
  margin-bottom: 3px;
}

.weather-control-card {
  display: grid;
  gap: 2px;
  min-height: 31px;
  padding: 3px 8px;
  border: 1px solid rgba(103, 232, 249, 0.22);
  border-radius: 5px;
  background: rgba(4, 20, 28, 0.46);
}

.weather-control-card.active {
  border-color: rgba(250, 204, 21, 0.38);
  background: rgba(113, 63, 18, 0.28);
}

.weather-control-card div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.weather-control-card span,
.weather-control-card small,
.weather-control-card strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.weather-control-card span {
  color: #dbeafe;
  font-size: 10px;
  font-weight: 800;
}

.weather-control-card strong {
  color: #fde68a;
  font-size: 11px;
  font-weight: 900;
}

.weather-control-card small {
  color: #93c5fd;
  font-size: 9px;
  font-weight: 700;
}

.weather-control-actions button {
  min-height: 20px;
  padding: 2px 5px;
  font-size: 10px;
}

.control-area-list {
  display: grid;
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 6px;
  max-height: 136px;
  overflow-y: auto;
}

.control-area-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 28px;
  gap: 6px;
  min-height: 0;
  height: 100%;
  padding: 6px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(15, 23, 42, 0.42);
}

.control-area-main {
  display: grid;
  gap: 3px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
}

.control-area-main span,
.control-area-main small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.control-area-main span {
  color: #f8fafc;
  font-size: 11px;
  font-weight: 900;
  line-height: 1.16;
}

.control-area-main small {
  color: #99f6e4;
  font-size: 10px;
  line-height: 1.18;
}

.control-area-delete {
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  align-self: center;
  border-color: rgba(251, 113, 133, 0.28);
  background: rgba(127, 29, 29, 0.28);
  color: #fecdd3;
  font-size: 14px;
  line-height: 1;
}

.control-area-row.active {
  border-color: rgba(251, 113, 133, 0.55);
  background: rgba(127, 29, 29, 0.22);
}

.control-area-row.live:not(.active) {
  border-color: rgba(251, 113, 133, 0.32);
}

.control-empty {
  color: #8fb2c2;
  font-size: 11px;
}

.grid-history-section {
  display: grid;
  gap: 8px;
}

.grid-history-section .section-title {
  grid-template-columns: minmax(0, 1fr) auto;
}

.grid-state-detail {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  padding-right: 2px;
}

.grid-history-summary {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid rgba(56, 189, 248, 0.2);
  background: rgba(8, 47, 73, 0.26);
}

.grid-history-summary strong,
.grid-history-summary small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid-history-summary strong {
  color: #f8fafc;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 10px;
  font-weight: 900;
}

.grid-history-summary small {
  color: #99f6e4;
  font-size: 9px;
  font-weight: 800;
}

.grid-history-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}

.grid-history-meta span {
  min-height: 24px;
  padding: 5px 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(15, 23, 42, 0.38);
  color: #dbeafe;
  font-size: 10px;
  font-weight: 800;
  text-align: center;
}

.grid-state-editor {
  display: grid;
  grid-template-columns: 1fr 1fr;
  flex: 0 0 auto;
  gap: 5px;
  padding: 6px;
  border: 1px solid rgba(251, 113, 133, 0.22);
  border-radius: 5px;
  background: rgba(15, 23, 42, 0.36);
}

.grid-state-title {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.grid-state-title span,
.grid-state-title small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid-state-title span {
  color: #f8fafc;
  font-size: 11px;
  font-weight: 900;
}

.grid-state-title small {
  color: #fda4af;
  font-size: 9px;
  font-weight: 800;
}

.grid-state-toggle {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}

.grid-state-toggle button,
.grid-state-save {
  min-height: 24px;
  padding: 4px 6px;
  font-size: 11px;
}

.grid-state-toggle button.active {
  border-color: rgba(251, 191, 36, 0.55);
  background: linear-gradient(180deg, rgba(251, 191, 36, 0.8), rgba(234, 88, 12, 0.62));
  color: #061018;
}

.grid-state-inputs {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}

.grid-state-inputs label,
.grid-state-check {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.grid-state-inputs span,
.grid-state-check span {
  color: #bfdbfe;
  font-size: 9px;
  font-weight: 800;
}

.grid-state-inputs input,
.grid-state-reason {
  width: 100%;
  min-width: 0;
  height: 25px;
  padding: 4px 6px;
  border: 1px solid rgba(103, 232, 249, 0.22);
  border-radius: 4px;
  background: rgba(2, 8, 23, 0.52);
  color: #f8fafc;
  font-size: 11px;
  font-weight: 800;
}

.grid-state-check {
  grid-template-columns: 14px minmax(0, 1fr);
  align-items: center;
  gap: 5px;
  padding: 5px 6px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 4px;
  background: rgba(2, 8, 23, 0.28);
}

.grid-state-check input {
  width: 13px;
  height: 13px;
}

.grid-state-reason {
  height: 25px;
}

.grid-state-save {
  grid-column: 1 / -1;
  border-color: rgba(74, 222, 128, 0.38);
  background: linear-gradient(180deg, rgba(110, 231, 183, 0.9), rgba(16, 185, 129, 0.72));
  color: #052016;
  font-weight: 900;
}

.spatiotemporal-index-card {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  flex: 0 0 auto;
  gap: 5px;
  padding: 6px;
  border: 1px solid rgba(45, 212, 191, 0.2);
  border-radius: 5px;
  background: rgba(4, 20, 28, 0.42);
}

.spatiotemporal-index-card div {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.spatiotemporal-index-card span,
.spatiotemporal-index-card strong,
.spatiotemporal-index-card small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spatiotemporal-index-card span {
  color: #93c5fd;
  font-size: 9px;
  font-weight: 800;
}

.spatiotemporal-index-card strong {
  color: #f8fafc;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 9px;
  font-weight: 900;
}

.spatiotemporal-index-card small {
  grid-column: 1 / -1;
  color: #a7f3d0;
  font-size: 8px;
  font-weight: 700;
}

.right-panel .helipad-list {
  max-height: 118px;
}

.helipad-status {
  border-color: rgba(94, 234, 212, 0.34);
  border-left-color: #5eead4;
  background: rgba(8, 47, 73, 0.42);
  color: #ccfbf1;
}

.helipad-context-menu {
  position: absolute;
  z-index: 1200;
  width: 148px;
  padding: 7px;
  border: 1px solid rgba(94, 234, 212, 0.48);
  background: rgba(3, 12, 18, 0.86);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.36), inset 0 0 18px rgba(34, 211, 238, 0.08);
  backdrop-filter: blur(14px);
}

.context-title {
  display: grid;
  gap: 2px;
  padding: 4px 5px 7px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  margin-bottom: 6px;
}

.context-title span {
  color: #67e8f9;
  font-size: 10px;
  font-weight: 800;
}

.context-title strong {
  overflow: hidden;
  color: #f8fafc;
  font-size: 11px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.helipad-context-menu button {
  display: block;
  width: 100%;
  min-height: 28px;
  margin-top: 4px;
  border-color: rgba(94, 234, 212, 0.28);
  background: rgba(8, 47, 73, 0.42);
  color: #ccfbf1;
  text-align: left;
}

.helipad-context-menu button:hover {
  border-color: rgba(250, 204, 21, 0.58);
  background: rgba(113, 63, 18, 0.44);
  color: #fff7ed;
}

.helipad-context-menu button.danger {
  border-color: rgba(248, 113, 113, 0.4);
  color: #fecaca;
}

.helipad-info-popup {
  position: absolute;
  z-index: 48;
  width: 210px;
  padding: 10px;
  border: 1px solid rgba(103, 232, 249, 0.42);
  background: rgba(2, 8, 14, 0.78);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.38), inset 0 0 22px rgba(20, 184, 166, 0.08);
  backdrop-filter: blur(14px);
  color: #e0faff;
}

.helipad-info-popup::before {
  content: "";
  position: absolute;
  left: 13px;
  top: -7px;
  width: 12px;
  height: 12px;
  border-left: 1px solid rgba(103, 232, 249, 0.42);
  border-top: 1px solid rgba(103, 232, 249, 0.42);
  background: rgba(2, 8, 14, 0.78);
  transform: rotate(45deg);
}

.popup-close {
  position: absolute;
  top: 5px;
  right: 6px;
  width: 22px;
  min-width: 22px;
  height: 22px;
  min-height: 22px;
  padding: 0;
  border-color: rgba(148, 163, 184, 0.2);
  background: rgba(15, 23, 42, 0.48);
  color: #b6d7e2;
  line-height: 1;
}

.popup-title {
  display: grid;
  gap: 2px;
  padding-right: 26px;
  padding-bottom: 7px;
  margin-bottom: 7px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
}

.popup-title span {
  color: #67e8f9;
  font-size: 10px;
  font-weight: 900;
}

.popup-title strong {
  color: #f8fafc;
  font-size: 12px;
  line-height: 1.25;
}

.helipad-info-popup dl {
  display: grid;
  gap: 5px;
  margin: 0;
}

.helipad-info-popup dl div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.helipad-info-popup dt,
.helipad-info-popup dd {
  margin: 0;
  font-size: 10px;
  line-height: 1.25;
}

.helipad-info-popup dt {
  color: #9fb8c7;
}

.helipad-info-popup dd {
  color: #e7fff7;
  font-family: "Avenir Next", "Microsoft YaHei", sans-serif;
  font-weight: 800;
}

.helipad-info-popup p {
  margin: 8px 0 0;
  padding-top: 7px;
  border-top: 1px solid rgba(148, 163, 184, 0.14);
  color: #bdebdc;
  font-size: 10px;
  line-height: 1.35;
}

.mission-point-info-popup .popup-title span {
  color: #facc15;
}

.range-control {
  display: grid;
  grid-template-columns: 78px 1fr 50px;
  gap: 7px;
  align-items: center;
  min-height: 32px;
  color: #e2e8f0;
  font-size: 11px;
}

.range-control + .range-control {
  margin-top: 6px;
}

.range-control label {
  color: #cbd5e1;
  font-weight: 700;
}

.range-control span {
  color: #67e8f9;
  font-weight: 800;
  text-align: right;
  white-space: nowrap;
}

.range-control input[type="range"] {
  width: 100%;
  min-width: 0;
  accent-color: #22c55e;
}

.range-control input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: #22c55e;
}

.terrain-row {
  grid-template-columns: 62px 18px 1fr 50px;
}

.status-bar {
  padding: 8px 10px;
  border: 1px solid rgba(250, 204, 21, 0.32);
  border-left: 3px solid #facc15;
  border-radius: 5px;
  background: rgba(113, 63, 18, 0.38);
  color: #fde68a;
  font-size: 12px;
  font-weight: 700;
}

.floating-status-bar {
  position: absolute;
  z-index: 1005;
  left: calc(var(--frame-left) + 18px);
  bottom: calc(var(--frame-bottom) + 12px);
  max-width: min(420px, calc(100vw - var(--frame-left) - var(--frame-right) - 48px));
  min-height: 28px;
  padding: 7px 10px;
  overflow: hidden;
  border: 1px solid rgba(250, 204, 21, 0.34);
  border-left: 3px solid #facc15;
  border-radius: 5px;
  background: rgba(113, 63, 18, 0.52);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.26);
  color: #fde68a;
  font-size: 11px;
  font-weight: 800;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.metric-tile {
  min-height: 64px;
  padding: 8px;
  border-radius: 7px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(2, 6, 23, 0.42);
  overflow: hidden;
}

.metric-tile span,
.metric-tile em {
  display: block;
  color: #cbd5e1;
  font-size: 10px;
  font-style: normal;
  white-space: nowrap;
}

.metric-tile strong {
  display: block;
  margin: 5px 0 2px;
  color: #f8fafc;
  font-size: 19px;
  line-height: 1;
  font-weight: 900;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.accent-cyan {
  border-color: rgba(34, 211, 238, 0.42);
}

.accent-green {
  border-color: rgba(74, 222, 128, 0.42);
}

.accent-yellow {
  border-color: rgba(250, 204, 21, 0.42);
}

.accent-orange {
  border-color: rgba(251, 146, 60, 0.42);
}

.status-list {
  list-style: none;
  padding: 0;
  margin: 9px 0 0;
}

.status-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 26px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  color: #cbd5e1;
  font-size: 11px;
}

.status-list li:last-child {
  border-bottom: 0;
}

.status-list b {
  color: #f8fafc;
  font-weight: 800;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stats-section {
  display: grid;
  gap: 8px;
}

.section-refresh {
  min-height: 22px;
  padding: 3px 7px;
  border-color: rgba(103, 232, 249, 0.24);
  background: rgba(8, 47, 73, 0.46);
  color: #bae6fd;
  font-size: 10px;
}

.stats-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.stats-summary div {
  min-height: 48px;
  padding: 7px 8px;
  border: 1px solid rgba(94, 234, 212, 0.2);
  border-radius: 6px;
  background: rgba(4, 20, 28, 0.42);
}

.stats-summary span,
.stats-summary em {
  display: block;
  color: #9fb8c7;
  font-size: 10px;
  font-style: normal;
}

.stats-summary strong {
  display: inline-block;
  margin-top: 4px;
  color: #f8fafc;
  font-size: 18px;
  line-height: 1;
  font-weight: 900;
}

.stats-summary em {
  display: inline-block;
  margin-left: 4px;
  color: #67e8f9;
  font-weight: 800;
}

.mini-chart {
  padding: 7px;
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 6px;
  background: rgba(2, 6, 23, 0.34);
}

.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.chart-head span {
  color: #e0f2fe;
  font-size: 11px;
  font-weight: 900;
}

.chart-head b {
  color: #93c5fd;
  font-size: 9px;
  font-weight: 800;
}

.bar-chart {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  align-items: end;
  gap: 5px;
  height: 58px;
}

.bar-column {
  position: relative;
  display: grid;
  grid-template-rows: minmax(0, 1fr) 12px;
  align-items: end;
  min-width: 0;
  height: 100%;
  gap: 4px;
  cursor: crosshair;
  outline: none;
  transition: transform 0.18s ease, filter 0.18s ease;
}

.bar-column::before {
  content: "";
  position: absolute;
  left: 50%;
  top: -2px;
  bottom: 14px;
  width: 1px;
  background: linear-gradient(180deg, rgba(248, 250, 252, 0.72), rgba(103, 232, 249, 0));
  opacity: 0;
  transform: translateX(-50%);
  transition: opacity 0.18s ease;
}

.bar-column i {
  display: block;
  width: 100%;
  min-height: 2px;
  border-radius: 4px 4px 2px 2px;
  box-shadow: 0 0 12px currentColor;
  transform-origin: bottom center;
  transition: transform 0.18s ease, box-shadow 0.18s ease, filter 0.18s ease;
}

.bar-column:hover,
.bar-column:focus-visible,
.bar-column.active {
  transform: translateY(-2px);
  filter: brightness(1.16);
}

.bar-column:hover::before,
.bar-column:focus-visible::before,
.bar-column.active::before {
  opacity: 1;
}

.bar-column:hover i,
.bar-column:focus-visible i,
.bar-column.active i {
  transform: scaleY(1.05);
  box-shadow: 0 0 18px currentColor, 0 0 28px rgba(103, 232, 249, 0.22);
}

.bar-column.cyan i {
  color: rgba(103, 232, 249, 0.58);
  background: linear-gradient(180deg, rgba(103, 232, 249, 0.92), rgba(14, 116, 144, 0.32));
}

.bar-column.green i {
  color: rgba(94, 234, 212, 0.55);
  background: linear-gradient(180deg, rgba(134, 239, 172, 0.9), rgba(20, 184, 166, 0.28));
}

.bar-column em {
  color: #8fb2c2;
  font-size: 9px;
  font-style: normal;
  text-align: center;
  white-space: nowrap;
}

.bar-chart.compact {
  height: 52px;
}

.line-chart {
  width: 100%;
  height: 70px;
  display: block;
  overflow: visible;
}

.line-area {
  fill: rgba(56, 189, 248, 0.16);
}

.line-path {
  fill: none;
  stroke: #67e8f9;
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 5px rgba(103, 232, 249, 0.72));
}

.line-dot {
  fill: #f8fafc;
  stroke: #22d3ee;
  stroke-width: 1.5;
  pointer-events: none;
  transition: r 0.18s ease, filter 0.18s ease, stroke-width 0.18s ease;
}

.line-hit {
  fill: transparent;
  stroke: transparent;
  cursor: crosshair;
  outline: none;
  pointer-events: all;
}

.line-hit:hover + .line-dot,
.line-hit:focus-visible + .line-dot,
.line-dot.active {
  stroke-width: 2.4;
  filter: drop-shadow(0 0 8px rgba(103, 232, 249, 0.95));
}

.control-stat-card {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 9px;
  align-items: center;
  padding: 7px;
  border: 1px solid rgba(251, 113, 133, 0.2);
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.36);
}

.donut-chart {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background:
    radial-gradient(circle, rgba(5, 13, 18, 0.95) 0 48%, transparent 49%),
    conic-gradient(#fb7185 0deg var(--active-angle), #94a3b8 var(--active-angle) var(--history-angle), var(--future-color) var(--history-angle) 360deg);
  box-shadow: inset 0 0 18px rgba(103, 232, 249, 0.08), 0 0 14px rgba(251, 113, 133, 0.12);
  cursor: crosshair;
  outline: none;
  transition: transform 0.18s ease, filter 0.18s ease, box-shadow 0.18s ease;
}

.donut-chart:hover,
.donut-chart:focus-visible,
.donut-chart.active {
  transform: scale(1.04);
  filter: brightness(1.12);
  box-shadow: inset 0 0 18px rgba(103, 232, 249, 0.12), 0 0 18px rgba(251, 113, 133, 0.3);
}

.donut-chart span,
.donut-chart em {
  position: absolute;
  display: block;
  text-align: center;
}

.donut-chart span {
  margin-top: -8px;
  color: #f8fafc;
  font-size: 20px;
  line-height: 1;
  font-weight: 900;
}

.donut-chart em {
  margin-top: 18px;
  color: #fecdd3;
  font-size: 9px;
  font-style: normal;
  font-weight: 800;
}

.control-stat-list {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.control-stat-list span,
.control-stat-list small {
  min-width: 0;
  color: #cbd5e1;
  font-size: 10px;
}

.control-stat-list span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.control-stat-item {
  cursor: crosshair;
  border-radius: 4px;
  outline: none;
  transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
}

.control-stat-item:hover,
.control-stat-item:focus-visible,
.control-stat-item.active {
  color: #f8fafc;
  background: rgba(103, 232, 249, 0.1);
  transform: translateX(2px);
}

.control-stat-list b {
  color: #f8fafc;
}

.control-stat-list small {
  color: #8fb2c2;
}

.control-stat-list i {
  width: 7px;
  height: 7px;
  margin-right: 5px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.live-dot {
  background: #fb7185;
  box-shadow: 0 0 8px rgba(251, 113, 133, 0.74);
}

.history-dot {
  background: #94a3b8;
}

.future-dot {
  background: #facc15;
}

.chart-tooltip {
  position: absolute;
  z-index: 8;
  min-width: 132px;
  padding: 7px 9px;
  border: 1px solid rgba(103, 232, 249, 0.46);
  border-radius: 6px;
  background: rgba(3, 18, 28, 0.88);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28), 0 0 18px rgba(45, 212, 191, 0.18);
  pointer-events: none;
  transform: translate(-50%, -100%);
  backdrop-filter: blur(10px);
}

.chart-tooltip::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -5px;
  width: 9px;
  height: 9px;
  border-right: 1px solid rgba(103, 232, 249, 0.46);
  border-bottom: 1px solid rgba(103, 232, 249, 0.46);
  background: rgba(3, 18, 28, 0.88);
  transform: translateX(-50%) rotate(45deg);
}

.chart-tooltip strong,
.chart-tooltip span,
.chart-tooltip em {
  position: relative;
  z-index: 1;
  display: block;
  white-space: nowrap;
}

.chart-tooltip strong {
  color: #a7f3d0;
  font-size: 11px;
  line-height: 1.2;
  font-weight: 900;
}

.chart-tooltip span {
  margin-top: 3px;
  color: #f8fafc;
  font-size: 17px;
  line-height: 1.05;
  font-weight: 900;
}

.chart-tooltip em {
  margin-top: 3px;
  color: #93c5fd;
  font-size: 10px;
  font-style: normal;
  font-weight: 700;
}

.comparison-list {
  font-size: 11px;
}

.comparison-title {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 8px;
  padding-bottom: 7px;
  margin-bottom: 5px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

.comparison-title span {
  color: #e0f2fe;
  font-weight: 800;
}

.comparison-title small {
  grid-column: 1 / -1;
  color: #93c5fd;
  font-size: 10px;
}

.comparison-title button {
  min-height: 24px;
  padding: 3px 7px;
  background: rgba(148, 163, 184, 0.22);
  color: #e2e8f0;
  font-size: 10px;
}

.comparison-title button:hover {
  background: rgba(248, 113, 113, 0.48);
}

.comparison-results {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding-bottom: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(56, 189, 248, 0.65) rgba(15, 23, 42, 0.28);
}

.comparison-row {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  gap: 7px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.comparison-row:last-child {
  border-bottom: 0;
}

.comparison-row span,
.comparison-row strong,
.comparison-row em,
.comparison-row small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.comparison-row span {
  color: #f8fafc;
  font-weight: 700;
}

.comparison-row span b {
  display: block;
  margin-top: 2px;
  color: #22c55e;
  font-size: 9px;
  font-weight: 800;
}

.comparison-row strong {
  color: #fde68a;
  font-size: 9px;
  white-space: nowrap;
}

.comparison-row em {
  grid-column: 2;
  color: #7dd3fc;
  font-style: normal;
  white-space: nowrap;
}

.comparison-row small {
  grid-column: 2;
  color: #c4b5fd;
  font-size: 8px;
  font-weight: 700;
  line-height: 1.15;
  white-space: nowrap;
}

.comparison-row.failed {
  opacity: 0.74;
}

.comparison-row.failed em {
  color: #fca5a5;
}

.route-archive .comparison-row {
  flex: 1 1 0;
  min-height: 0;
}

.route-archive.comparison-mode {
  padding-bottom: 8px;
  overflow: hidden;
}

.route-archive.comparison-mode .archive-header {
  flex: 0 0 21px;
  min-height: 21px;
  margin-bottom: 2px;
}

.route-archive.comparison-mode .comparison-row {
  flex: 1 1 0;
  min-height: 0;
  padding: 0;
  grid-template-columns: 104px minmax(0, 1fr);
  grid-template-rows: repeat(3, auto);
  align-content: center;
  gap: 1px 8px;
}

.route-archive.comparison-mode .comparison-row span,
.route-archive.comparison-mode .comparison-row strong,
.route-archive.comparison-mode .comparison-row em,
.route-archive.comparison-mode .comparison-row small {
  line-height: 1.1;
}

.route-archive.comparison-mode .comparison-row span b {
  margin-top: 1px;
  font-size: 10.5px;
  line-height: 1;
}

.route-archive.comparison-mode .comparison-row > span {
  grid-row: 1 / 4;
  align-self: center;
  font-size: 12.5px;
}

.route-archive.comparison-mode .comparison-row strong {
  font-size: 12px;
}

.route-archive.comparison-mode .comparison-row em {
  font-size: 11px;
}

.route-archive.comparison-mode .comparison-row small {
  font-size: 10px;
}

.route-archive {
  flex: 0 0 auto;
  margin-top: 9px;
  max-height: 174px;
  overflow-y: auto;
}

.archive-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
  color: #e0f2fe;
  font-size: 12px;
  font-weight: 800;
}

.archive-header span {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 7px;
  overflow: hidden;
  white-space: nowrap;
}

.archive-header span small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #93c5fd;
  font-size: 10px;
  font-weight: 700;
}

.archive-header button {
  min-height: 26px;
  padding: 4px 7px;
  font-size: 11px;
  background: rgba(37, 99, 235, 0.82);
}

.archive-tools button {
  min-height: 22px;
  padding: 3px 6px;
  font-size: 10px;
}

.archive-message {
  color: #94a3b8;
  font-size: 12px;
  padding: 8px 0;
}

.archive-row {
  display: block;
  width: 100%;
  padding: 7px;
  margin-bottom: 5px;
  text-align: left;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 5px;
  background: rgba(2, 6, 23, 0.48);
}

.archive-row span,
.archive-row small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-row span {
  color: #f8fafc;
  font-size: 11px;
  font-weight: 700;
}

.archive-row small {
  margin-top: 4px;
  color: #bae6fd;
  font-size: 10px;
}

.archive-row.active {
  border-color: #22d3ee;
  background: rgba(14, 116, 144, 0.55);
}

.coordinate-panel {
  left: 0;
  right: 0;
  bottom: 0;
  transform: none;
  max-width: none;
  height: var(--frame-bottom);
  min-height: var(--frame-bottom);
  padding: 6px 10px;
  border-radius: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #dbeafe;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 11px;
  pointer-events: none;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  border-left: 0;
  border-right: 0;
  border-bottom: 0;
}

.coordinate-panel span {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 数字化大屏布局：页面级无滚动，中间地图最大化，左右信息舱固定分区。 */
.map-wrapper {
  --frame-top: 76px;
  --frame-bottom: 40px;
  --frame-left: clamp(316px, 21.5vw, 348px);
  --frame-right: clamp(382px, 26vw, 420px);
  --ui-panel-bg: rgba(5, 13, 18, 0.46);
  --ui-panel-bg-strong: rgba(6, 18, 26, 0.58);
  --ui-section-bg: rgba(7, 22, 30, 0.34);
  --ui-border: rgba(103, 232, 249, 0.42);
  --ui-border-soft: rgba(125, 211, 252, 0.2);
}

.dashboard-header {
  height: var(--frame-top);
  padding-top: 8px;
  padding-bottom: 8px;
  background:
    linear-gradient(90deg, rgba(5, 13, 18, 0.78), rgba(8, 47, 73, 0.58) 45%, rgba(5, 13, 18, 0.78)),
    var(--ui-panel-bg);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.28), inset 0 -1px 0 rgba(103, 232, 249, 0.18);
}

.system-title h1 {
  font-size: clamp(26px, 2.1vw, 36px);
  line-height: 1.02;
  text-shadow: 0 0 18px rgba(103, 232, 249, 0.18);
}

.system-kicker {
  margin-top: 6px;
  font-size: clamp(15px, 1vw, 18px);
}

.dashboard-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow: hidden;
}

.dashboard-panel .panel-section {
  min-height: 0;
  margin-bottom: 0;
}

.panel-section {
  padding: 9px;
  border-radius: 6px;
  background:
    linear-gradient(180deg, rgba(14, 116, 144, 0.09), rgba(2, 6, 23, 0.08)),
    var(--ui-section-bg);
}

.section-title {
  height: 18px;
  margin-bottom: 7px;
  font-size: 12px;
}

.left-panel > .panel-section:nth-of-type(1) {
  flex: 0 0 134px;
}

.left-panel > .panel-section:nth-of-type(2) {
  flex: 0 0 178px;
}

.left-panel > .panel-section:nth-of-type(3) {
  flex: 0 0 74px;
}

.left-panel > .weather-control-section {
  flex: 0 0 auto;
}

.left-panel > .control-area-section {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.left-panel > .status-bar {
  flex: 0 0 auto;
}

button {
  min-height: 28px;
  padding: 5px 7px;
  border-radius: 4px;
  font-size: 11px;
}

.action-grid,
.toggle-grid {
  gap: 5px;
}

.primary-actions {
  margin: 5px 0;
}

.toggle-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.field-label {
  margin: 8px 0 4px;
}

.level-toggle {
  height: 30px;
}

.level-menu {
  bottom: calc(100% + 5px);
  max-height: min(168px, calc(100vh - 220px));
}

.range-control {
  min-height: 27px;
  grid-template-columns: 74px 1fr 44px;
  gap: 6px;
  font-size: 10px;
}

.terrain-row {
  grid-template-columns: 58px 18px 1fr 44px;
}

.control-input {
  height: 28px;
  flex: 0 0 auto;
}

.time-grid {
  flex: 0 0 auto;
  gap: 6px;
}

.time-grid input {
  height: 28px;
}

.control-area-section .action-grid {
  flex: 0 0 auto;
}

.control-hint {
  flex: 0 0 auto;
  min-height: 28px;
  padding: 6px 8px;
}

.control-area-list {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  overflow: hidden;
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.control-area-row {
  min-height: 0;
  height: 100%;
  padding: 6px;
}

.status-bar {
  padding: 7px 9px;
  font-size: 11px;
  line-height: 1.35;
}

.right-panel {
  gap: 8px;
}

.right-panel-main {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-rows: 130px 260px minmax(0, 1fr) auto;
  gap: 8px;
  overflow: hidden;
  padding-right: 0;
}

.right-panel-main > .panel-section {
  min-height: 0;
  overflow: hidden;
}

.right-panel-main > .panel-section:first-child {
  padding: 7px;
}

.right-panel-main > .panel-section:first-child .section-title {
  height: 16px;
  margin-bottom: 5px;
}

.metric-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 5px;
}

.metric-tile {
  min-height: 38px;
  padding: 4px 5px;
  border-radius: 5px;
}

.metric-tile strong {
  margin: 3px 0 1px;
  font-size: 15px;
}

.metric-tile span,
.metric-tile em {
  font-size: 9px;
}

.status-list {
  margin-top: 5px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 8px;
}

.status-list li {
  min-height: 14px;
  gap: 6px;
  font-size: 9px;
}

.stats-section {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: 18px 38px minmax(44px, 1fr) minmax(46px, 1fr);
  align-content: stretch;
  gap: 5px 6px;
}

.stats-section .section-title,
.stats-summary {
  grid-column: 1 / -1;
}

.stats-summary {
  gap: 6px;
  min-height: 0;
}

.stats-summary div {
  min-height: 0;
  padding: 4px 7px;
}

.stats-summary strong {
  font-size: 14px;
}

.mini-chart {
  min-height: 0;
  padding: 4px 5px;
  overflow: hidden;
}

.chart-head {
  height: 12px;
  margin-bottom: 2px;
}

.chart-head span {
  font-size: 9px;
  line-height: 1;
}

.chart-head b {
  display: none;
}

.bar-chart,
.bar-chart.compact {
  height: calc(100% - 14px);
  min-height: 18px;
  gap: 3px;
}

.bar-column {
  grid-template-rows: minmax(0, 1fr);
}

.bar-column em {
  display: none;
}

.line-chart {
  height: calc(100% - 14px);
  min-height: 22px;
}

.control-stat-card {
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 5px;
  padding: 5px;
  overflow: hidden;
}

.donut-chart {
  width: 40px;
  height: 40px;
}

.donut-chart span {
  font-size: 15px;
}

.donut-chart em {
  margin-top: 13px;
  font-size: 8px;
}

.control-stat-list {
  gap: 2px;
}

.control-stat-list span,
.control-stat-list small {
  font-size: 8px;
  line-height: 1.15;
}

.helipad-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.helipad-section .section-title,
.helipad-overview,
.helipad-toggle-row,
.helipad-actions,
.helipad-hint,
.helipad-detail,
.helipad-empty {
  flex: 0 0 auto;
}

.helipad-overview {
  grid-template-columns: minmax(0, 1fr) 36px;
  min-height: 32px;
  padding: 3px 6px;
}

.helipad-overview strong {
  font-size: 18px;
}

.helipad-toggle-row,
.helipad-actions {
  margin-top: 0;
}

.helipad-hint {
  min-height: 20px;
  margin: 0;
  padding: 3px 7px;
  font-size: 9px;
}

.helipad-detail {
  padding: 6px 8px;
}

.helipad-list {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  overflow: hidden;
  gap: 3px;
}

.right-panel .helipad-list {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  max-height: none;
}

.helipad-row {
  min-height: 28px;
  padding: 3px 6px;
}

.helipad-visibility-btn,
.helipad-actions button {
  min-height: 22px;
}

.helipad-row small {
  margin-top: 2px;
}

.comparison-list {
  max-height: 96px;
}

.comparison-title {
  padding-bottom: 5px;
  margin-bottom: 4px;
}

.comparison-row {
  padding: 4px 0;
}

.route-archive {
  flex: 0 0 118px;
  max-height: 118px;
  margin-top: 0;
  overflow: hidden;
}

.archive-header {
  min-height: 21px;
  margin-bottom: 3px;
}

.archive-header button {
  min-height: 20px;
}

.archive-row {
  min-height: 24px;
  padding: 3px 6px;
  margin-bottom: 2px;
}

.archive-row small {
  margin-top: 1px;
  font-size: 9px;
  line-height: 1.12;
}

.archive-row span {
  font-size: 10px;
  line-height: 1.12;
}

.coordinate-panel {
  background: rgba(5, 13, 18, 0.56);
  backdrop-filter: blur(8px) saturate(1.12);
}

@media (max-height: 880px) {
  .map-wrapper {
    --frame-top: 68px;
    --frame-bottom: 36px;
  }

  .left-panel > .panel-section:nth-of-type(1) {
    flex-basis: 122px;
  }

  .left-panel > .panel-section:nth-of-type(2) {
    flex-basis: 164px;
  }

  .left-panel > .panel-section:nth-of-type(3) {
    flex-basis: 68px;
  }

  .right-panel-main {
    grid-template-rows: 118px 232px minmax(0, 1fr) auto;
  }

  .system-title h1 {
    font-size: clamp(22px, 1.9vw, 30px);
  }

  .system-kicker {
    font-size: 13px;
  }

  .metric-tile {
    min-height: 48px;
    padding: 6px;
  }

  .metric-tile strong {
    font-size: 15px;
  }

  .status-list li {
    min-height: 18px;
  }

  .stats-summary div {
    min-height: 38px;
  }

  .bar-chart,
  .bar-chart.compact {
    height: 28px;
  }

  .line-chart {
    height: 32px;
  }

  .donut-chart {
    width: 50px;
    height: 50px;
  }

  .control-stat-card {
    grid-template-columns: 52px minmax(0, 1fr);
  }

.route-archive {
    flex-basis: 104px;
    max-height: 104px;
  }
}

/* 二次修正：顶部任务导航 + 侧栏重新分配，避免面板内容互相覆盖。 */
.map-wrapper {
  --header-h: 72px;
  --command-h: 50px;
  --frame-top: calc(var(--header-h) + var(--command-h));
  --frame-left: clamp(300px, 20.5vw, 330px);
  --frame-right: clamp(360px, 25vw, 400px);
}

.dashboard-header {
  height: var(--header-h);
  padding-top: 7px;
  padding-bottom: 7px;
}

.system-title h1 {
  font-size: clamp(24px, 1.9vw, 32px);
}

.system-kicker {
  margin-top: 5px;
  font-size: clamp(13px, 0.92vw, 16px);
}

.top-command-bar {
  position: absolute;
  z-index: 1000;
  top: var(--header-h);
  left: 0;
  right: 0;
  height: var(--command-h);
  padding: 6px calc(var(--frame-right) + 14px) 6px calc(var(--frame-left) + 14px);
  border-bottom: 1px solid rgba(103, 232, 249, 0.3);
  background:
    linear-gradient(90deg, rgba(3, 12, 18, 0.82), rgba(8, 47, 73, 0.48) 50%, rgba(3, 12, 18, 0.82)),
    rgba(5, 13, 18, 0.55);
  box-shadow: inset 0 1px 0 rgba(125, 211, 252, 0.12), 0 12px 26px rgba(0, 0, 0, 0.2);
  backdrop-filter: blur(8px) saturate(1.1);
}

.command-group {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
  width: min(820px, 100%);
  height: 100%;
  margin: 0 auto;
}

.command-group button {
  min-width: 0;
  min-height: 36px;
  padding: 7px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  border-color: rgba(103, 232, 249, 0.24);
  background: rgba(8, 24, 34, 0.68);
  color: #dffbff;
  font-size: 13px;
  font-weight: 800;
}

.command-group .plan-btn {
  color: #031b12;
  background: linear-gradient(180deg, #a7f3d0, #34d399);
}

.command-group .clear-btn {
  color: #fff7ed;
  background: linear-gradient(180deg, #ef4444, #991b1b);
}

.dashboard-panel {
  top: var(--frame-top);
  bottom: var(--frame-bottom);
}

.left-panel > .panel-section:nth-of-type(1) {
  flex: 0 0 222px;
}

.left-panel > .panel-section:nth-of-type(2) {
  flex: 0 0 96px;
}

.left-panel > .panel-section:nth-of-type(3) {
  flex: 1 1 0;
}

.left-panel > .control-area-section {
  flex: 1 1 0;
}

.right-panel-main {
  grid-template-rows: 132px 204px minmax(132px, 1fr) auto;
}

@media (max-height: 880px) {
  .map-wrapper {
    --header-h: 66px;
    --command-h: 42px;
  }

  .header-meta {
    min-height: 38px;
    gap: 14px;
  }

  .meta-clock strong,
  .meta-weather strong {
    font-size: 17px;
  }

  .meta-clock span,
  .meta-weather span {
    font-size: 11px;
  }

  .command-group button {
    min-height: 34px;
    padding: 6px 7px;
    font-size: 12px;
  }

  .left-panel > .panel-section:nth-of-type(1) {
    flex-basis: 222px;
  }

  .left-panel > .panel-section:nth-of-type(2) {
    flex-basis: 96px;
  }

  .left-panel > .panel-section:nth-of-type(3) {
    flex: 1 1 0;
  }

  .right-panel-main {
    grid-template-rows: 122px 184px minmax(126px, 1fr) auto;
  }

  .right-panel {
    gap: 6px;
    padding: 8px;
  }

  .right-panel-main {
    grid-template-rows: 104px 168px minmax(122px, 1fr) auto;
    gap: 6px;
  }

  .right-panel-main > .panel-section:first-child {
    padding: 5px;
  }

  .right-panel-main > .panel-section:first-child .section-title {
    height: 14px;
    margin-bottom: 4px;
  }

  .metric-grid {
    gap: 4px;
  }

  .metric-tile {
    min-height: 31px;
    padding: 3px 4px;
  }

  .metric-tile strong {
    margin: 1px 0;
    font-size: 13px;
  }

  .metric-tile span,
  .metric-tile em,
  .status-list li {
    font-size: 8px;
  }

  .status-list {
    margin-top: 3px;
    gap: 2px 6px;
  }

  .status-list li {
    min-height: 11px;
  }

  .stats-section {
    grid-template-rows: 15px 28px minmax(34px, 1fr) minmax(36px, 1fr);
    gap: 4px 5px;
  }

  .stats-summary div {
    min-height: 0;
    padding: 3px 6px;
  }

  .stats-summary strong {
    font-size: 13px;
  }

  .chart-head {
    height: 10px;
    margin-bottom: 1px;
  }

  .bar-chart,
  .bar-chart.compact,
  .line-chart {
    height: calc(100% - 11px);
    min-height: 18px;
  }

  .donut-chart {
    width: 34px;
    height: 34px;
  }

  .control-stat-card {
    grid-template-columns: 36px minmax(0, 1fr);
    gap: 4px;
    padding: 4px;
  }

  .helipad-section {
    gap: 3px;
  }

  .helipad-overview {
    min-height: 28px;
    padding: 3px 6px;
  }

  .helipad-hint {
    display: none;
  }

  .helipad-visibility-btn,
  .helipad-actions button {
    min-height: 20px;
    padding: 3px 6px;
  }

  .helipad-row {
    min-height: 24px;
    padding: 3px 5px;
  }

  .route-archive {
    flex-basis: 96px;
    max-height: 96px;
  }

  .archive-header {
    min-height: 18px;
    margin-bottom: 2px;
  }

  .archive-tools button,
  .archive-header button {
    min-height: 18px;
    padding: 2px 5px;
  }

  .archive-row {
    min-height: 20px;
    padding: 2px 5px;
    margin-bottom: 2px;
  }

  .archive-row span,
  .archive-row small {
    font-size: 8px;
  }
}

/* 当前调整：运行统计移到地图中下部，右侧功能区字号统一放大。 */
.map-wrapper {
  --frame-bottom: 10px;
}

.center-bottom-stack {
  position: absolute;
  z-index: 998;
  left: calc(var(--frame-left) + 16px);
  right: calc(var(--frame-right) + 16px);
  bottom: 12px;
  display: grid;
  grid-template-rows: 32px 164px;
  gap: 8px;
  pointer-events: none;
}

.center-bottom-stack .coordinate-panel,
.center-bottom-stack .stats-section {
  pointer-events: auto;
}

.center-bottom-stack .coordinate-panel {
  position: static;
  width: 100%;
  max-width: none;
  min-height: 32px;
  height: 32px;
  padding: 6px 12px;
  border: 1px solid rgba(103, 232, 249, 0.34);
  border-radius: 6px;
  background: rgba(5, 13, 18, 0.58);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.24);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: #dbeafe;
  font-size: 12px;
  overflow: hidden;
  white-space: nowrap;
}

.center-bottom-stack .coordinate-panel span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.center-bottom-stack .stats-section {
  display: grid;
  grid-template-columns: 1fr 1fr 1.12fr 1.12fr;
  grid-template-rows: 22px 48px minmax(0, 70px);
  gap: 7px;
  min-height: 0;
  margin: 0;
  padding: 8px;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(14, 116, 144, 0.12), rgba(2, 6, 23, 0.08)),
    rgba(7, 22, 30, 0.5);
  backdrop-filter: blur(8px) saturate(1.12);
}

.center-bottom-stack .stats-section .section-title {
  grid-column: 1 / -1;
  height: 20px;
  margin: 0;
  font-size: 13px;
}

.center-bottom-stack .stats-summary {
  grid-column: 1 / 3;
  grid-row: 2;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
  min-height: 0;
}

.center-bottom-stack .stats-summary div {
  min-height: 0;
  padding: 6px 8px;
}

.center-bottom-stack .stats-summary span,
.center-bottom-stack .stats-summary em {
  font-size: 11px;
}

.center-bottom-stack .stats-summary strong {
  margin-top: 5px;
  font-size: 18px;
}

.center-bottom-stack .mini-chart {
  min-height: 0;
  padding: 6px 7px;
  overflow: hidden;
}

.center-bottom-stack .flight-chart {
  grid-column: 3;
  grid-row: 2 / 4;
}

.center-bottom-stack .distance-chart {
  grid-column: 4;
  grid-row: 2 / 4;
}

.center-bottom-stack .grid-chart {
  grid-column: 1 / 3;
  grid-row: 3;
}

.center-bottom-stack .control-stat-card {
  grid-column: 3 / 5;
  grid-row: 3;
  grid-template-columns: 52px minmax(0, 1fr);
  gap: 8px;
  min-height: 0;
  padding: 6px 8px;
  overflow: hidden;
}

.center-bottom-stack .chart-head {
  height: 15px;
  margin-bottom: 4px;
}

.center-bottom-stack .chart-head span {
  font-size: 11px;
}

.center-bottom-stack .chart-head b {
  display: none;
}

.center-bottom-stack .bar-chart,
.center-bottom-stack .bar-chart.compact {
  height: calc(100% - 19px);
  min-height: 34px;
  gap: 4px;
}

.center-bottom-stack .bar-column {
  grid-template-rows: minmax(0, 1fr) 11px;
  gap: 3px;
}

.center-bottom-stack .bar-column em {
  display: block;
  font-size: 9px;
}

.center-bottom-stack .line-chart {
  height: calc(100% - 19px);
  min-height: 44px;
}

.center-bottom-stack .donut-chart {
  width: 48px;
  height: 48px;
}

.center-bottom-stack .donut-chart span {
  font-size: 17px;
}

.center-bottom-stack .donut-chart em {
  margin-top: 15px;
  font-size: 8px;
}

.center-bottom-stack .control-stat-list {
  gap: 3px;
}

.center-bottom-stack .control-stat-list span,
.center-bottom-stack .control-stat-list small {
  font-size: 10px;
  line-height: 1.18;
}

.right-panel {
  font-size: 12px;
}

.right-panel-main {
  grid-template-rows: 164px minmax(236px, 1fr) auto;
}

.right-panel .section-title,
.right-panel .archive-header {
  height: 22px;
  font-size: 13px;
}

.right-panel button,
.right-panel input,
.right-panel select {
  font-size: 12px;
}

.right-panel .metric-grid {
  gap: 6px;
}

.right-panel .metric-tile {
  min-height: 48px;
  padding: 6px;
}

.right-panel .metric-tile strong {
  margin: 3px 0 2px;
  font-size: 20px;
}

.right-panel .metric-tile span,
.right-panel .metric-tile em,
.right-panel .status-list li {
  font-size: 11px;
}

.right-panel .status-list {
  margin-top: 8px;
  gap: 5px 10px;
}

.right-panel .status-list li {
  min-height: 20px;
}

.right-panel .helipad-section {
  gap: 7px;
}

.right-panel .helipad-overview {
  min-height: 42px;
  padding: 7px 9px;
}

.right-panel .helipad-overview strong {
  font-size: 24px;
}

.right-panel .helipad-hint {
  min-height: 28px;
  padding: 6px 8px;
  font-size: 11px;
}

.right-panel .helipad-detail {
  padding: 8px 9px;
  font-size: 12px;
}

.right-panel .helipad-detail small,
.right-panel .helipad-overview span,
.right-panel .helipad-overview em,
.right-panel .helipad-row span,
.right-panel .helipad-row small,
.right-panel .archive-row span,
.right-panel .archive-row small,
.right-panel .archive-message {
  font-size: 12px;
  line-height: 1.25;
}

.right-panel .helipad-visibility-btn,
.right-panel .helipad-actions button {
  min-height: 28px;
}

.right-panel .helipad-list {
  grid-template-columns: 1fr;
  gap: 5px;
}

.right-panel .helipad-row {
  min-height: 42px;
  padding: 6px 8px;
}

.right-panel .route-archive {
  flex-basis: 134px;
  max-height: 134px;
}

.right-panel .archive-row {
  min-height: 38px;
  padding: 6px 8px;
}

.right-panel .archive-tools button,
.right-panel .archive-header button {
  min-height: 24px;
  font-size: 11px;
}

.right-panel .archive-tools em {
  font-size: 11px;
}

@media (max-height: 880px) {
  .center-bottom-stack {
    grid-template-rows: 28px 142px;
    gap: 6px;
    bottom: 10px;
  }

  .center-bottom-stack .coordinate-panel {
    min-height: 28px;
    height: 28px;
    padding: 5px 10px;
    font-size: 11px;
  }

  .center-bottom-stack .stats-section {
    grid-template-rows: 20px 42px minmax(0, 58px);
    gap: 6px;
    padding: 7px;
  }

  .center-bottom-stack .stats-summary strong {
    font-size: 16px;
  }

  .center-bottom-stack .bar-chart,
  .center-bottom-stack .bar-chart.compact {
    min-height: 28px;
  }

  .center-bottom-stack .line-chart {
    min-height: 36px;
  }

  .center-bottom-stack .control-stat-card {
    grid-template-columns: 44px minmax(0, 1fr);
    gap: 6px;
  }

  .center-bottom-stack .donut-chart {
    width: 40px;
    height: 40px;
  }

  .center-bottom-stack .control-stat-list span,
  .center-bottom-stack .control-stat-list small {
    font-size: 9px;
  }

  .right-panel-main {
    grid-template-rows: 156px minmax(196px, 1fr) auto;
  }

  .right-panel .metric-tile {
    min-height: 42px;
  }

  .right-panel .metric-tile strong {
    font-size: 18px;
  }

  .right-panel .metric-tile span,
  .right-panel .metric-tile em,
  .right-panel .status-list li {
    font-size: 11px;
  }

  .right-panel .status-list li {
    min-height: 18px;
  }

  .right-panel .helipad-overview strong {
    font-size: 22px;
  }

  .right-panel .helipad-row {
    min-height: 38px;
  }

  .right-panel .route-archive {
    flex-basis: 122px;
    max-height: 122px;
  }
}

/* 右侧信息密度修正：监控更舒展，停机坪更紧凑，历史路径保留足够阅读空间。 */
.right-panel-main {
  flex: 0 0 auto;
  grid-template-rows: 260px 284px auto;
  align-content: start;
  gap: 8px;
}

.right-panel-main > .panel-section:first-child {
  padding: 9px;
}

.right-panel-main > .panel-section:first-child .section-title {
  height: 22px;
  margin-bottom: 8px;
}

.right-panel .metric-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.right-panel .metric-tile {
  min-height: 58px;
  padding: 8px;
}

.right-panel .metric-tile strong {
  margin: 5px 0 2px;
  font-size: 22px;
}

.right-panel .metric-tile span,
.right-panel .metric-tile em {
  font-size: 12px;
}

.right-panel .status-list {
  margin-top: 8px;
  gap: 6px 12px;
}

.right-panel .status-list li {
  min-height: 22px;
  font-size: 12px;
}

.right-panel .helipad-section {
  gap: 5px;
}

.right-panel .helipad-section .section-title {
  height: 20px;
  margin-bottom: 2px;
}

.right-panel .helipad-overview {
  grid-template-columns: minmax(0, 1fr) 32px;
  min-height: 30px;
  padding: 4px 7px;
}

.right-panel .helipad-overview strong {
  font-size: 18px;
}

.right-panel .helipad-overview span,
.right-panel .helipad-overview em {
  font-size: 10px;
}

.right-panel .helipad-toggle-row,
.right-panel .helipad-actions {
  margin-top: 0;
}

.right-panel .helipad-visibility-btn,
.right-panel .helipad-actions button {
  min-height: 24px;
  padding: 4px 7px;
  font-size: 11px;
}

.right-panel .helipad-hint {
  min-height: 22px;
  margin: 0;
  padding: 4px 7px;
  font-size: 10px;
  line-height: 1.28;
}

.right-panel .helipad-detail {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 8px;
  padding: 5px 7px;
  font-size: 10px;
}

.right-panel .helipad-detail div {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.right-panel .helipad-detail span,
.right-panel .helipad-detail small,
.right-panel .helipad-detail strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  line-height: 1.18;
}

.right-panel .helipad-list {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: 46px;
  gap: 4px;
  max-height: none;
  overflow: hidden;
  padding-right: 0;
}

.right-panel .helipad-row {
  min-height: 46px;
  padding: 7px 8px;
}

.right-panel .helipad-row span,
.right-panel .helipad-row small {
  font-size: 11px;
  line-height: 1.12;
}

.right-panel .helipad-row small {
  margin-top: 4px;
  font-size: 10px;
}

.right-panel .helipad-empty {
  padding: 4px 0 0;
  font-size: 11px;
}

.right-panel .route-archive {
  flex: 1 1 158px;
  min-height: 184px;
  max-height: none;
  margin-top: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.right-panel .archive-header {
  min-height: 26px;
  margin-bottom: 6px;
}

.right-panel .archive-row {
  min-height: 56px;
  padding: 10px 10px;
  margin-bottom: 7px;
}

.right-panel .archive-row span {
  font-size: 12px;
  line-height: 1.2;
}

.right-panel .archive-row small {
  margin-top: 5px;
  font-size: 10px;
  line-height: 1.18;
}

@media (max-height: 880px) {
  .right-panel-main {
    grid-template-rows: 254px 218px auto;
    gap: 6px;
  }

  .right-panel-main > .panel-section:first-child {
    padding: 8px;
  }

  .right-panel .metric-grid {
    gap: 7px;
  }

  .right-panel .metric-tile {
    min-height: 50px;
    padding: 7px;
  }

  .right-panel .metric-tile strong {
    font-size: 20px;
  }

  .right-panel .status-list {
    margin-top: 6px;
    gap: 4px 10px;
  }

  .right-panel .status-list li {
    min-height: 16px;
    font-size: 11px;
  }

  .right-panel .helipad-overview {
    min-height: 26px;
  }

  .right-panel .helipad-overview strong {
    font-size: 17px;
  }

  .right-panel .helipad-hint {
    display: none;
  }

  .right-panel .helipad-section {
    gap: 4px;
  }

  .right-panel .helipad-visibility-btn,
  .right-panel .helipad-actions button {
    min-height: 22px;
    padding: 3px 6px;
  }

  .right-panel .helipad-list {
    grid-auto-rows: 37px;
    gap: 3px;
  }

  .right-panel .helipad-row {
    min-height: 37px;
    padding: 5px 7px;
  }

  .right-panel .route-archive {
    min-height: 142px;
    padding: 6px 7px 5px;
  }

  .right-panel .archive-header {
    min-height: 19px;
    margin-bottom: 3px;
  }

  .right-panel .archive-row {
    min-height: 33px;
    padding: 5px 8px;
    margin-bottom: 2px;
  }

  .right-panel .archive-row span {
    font-size: 11px;
    line-height: 1.12;
  }

  .right-panel .archive-row small {
    margin-top: 3px;
    font-size: 9px;
    line-height: 1.12;
  }
}

/* 运行统计重新排布：增加中下部高度，避免图表重叠和文字溢出。 */
.center-bottom-stack {
  grid-template-rows: 32px 270px;
  bottom: 14px;
}

.center-bottom-stack .stats-section {
  position: relative;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  grid-template-rows: 24px 84px 120px;
  gap: 8px;
  padding: 9px;
  overflow: hidden;
}

.center-bottom-stack .stats-section > * {
  min-height: 0;
}

.center-bottom-stack .coordinate-panel {
  min-height: 32px;
  height: 32px;
  padding: 6px 12px;
  border: 1px solid rgba(103, 232, 249, 0.34);
  border-radius: 6px;
  background: rgba(5, 13, 18, 0.58);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.24);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: #dbeafe;
  font-size: 12px;
  overflow: hidden;
  white-space: nowrap;
}

.center-bottom-stack .coordinate-panel span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.center-bottom-stack .stats-section .section-title {
  height: 22px;
  font-size: 14px;
}

.center-bottom-stack .stats-summary {
  grid-column: 1 / 2;
  grid-row: 2;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: 1fr;
  gap: 5px;
  overflow: hidden;
}

.center-bottom-stack .stats-summary div {
  min-height: 0;
  padding: 4px 8px;
  overflow: hidden;
}

.center-bottom-stack .stats-summary span,
.center-bottom-stack .stats-summary em {
  font-size: 11px;
}

.center-bottom-stack .stats-summary strong {
  font-size: 16px;
}

.center-bottom-stack .flight-chart {
  grid-column: 2 / 3;
  grid-row: 2;
}

.center-bottom-stack .distance-chart {
  grid-column: 3 / 5;
  grid-row: 2;
}

.center-bottom-stack .grid-chart {
  grid-column: 1 / 3;
  grid-row: 3;
}

.center-bottom-stack .control-stat-card {
  grid-column: 3 / 5;
  grid-row: 3;
  grid-template-columns: 68px minmax(0, 1fr);
  gap: 10px;
  padding: 9px 10px;
}

.center-bottom-stack .mini-chart {
  padding: 8px 9px;
}

.center-bottom-stack .chart-head {
  height: 16px;
  margin-bottom: 4px;
}

.center-bottom-stack .chart-head span {
  font-size: 12px;
}

.center-bottom-stack .bar-chart,
.center-bottom-stack .bar-chart.compact {
  height: calc(100% - 20px);
  min-height: 34px;
}

.center-bottom-stack .line-chart {
  height: calc(100% - 20px);
  min-height: 34px;
}

.center-bottom-stack .donut-chart {
  width: 58px;
  height: 58px;
}

.center-bottom-stack .donut-chart span {
  font-size: 19px;
}

.center-bottom-stack .donut-chart em {
  margin-top: 18px;
  font-size: 9px;
}

.center-bottom-stack .control-stat-list {
  gap: 5px;
}

.center-bottom-stack .control-stat-list span,
.center-bottom-stack .control-stat-list small {
  font-size: 11px;
  line-height: 1.25;
}

@media (max-height: 880px) {
  .center-bottom-stack {
    grid-template-rows: 28px 226px;
    gap: 6px;
    bottom: 10px;
  }

  .center-bottom-stack .stats-section {
    grid-template-rows: 20px 70px 104px;
    gap: 6px;
    padding: 7px;
  }

  .center-bottom-stack .stats-summary div {
    padding: 3px 7px;
  }

  .center-bottom-stack .stats-summary strong {
    font-size: 16px;
  }

  .center-bottom-stack .bar-chart,
  .center-bottom-stack .bar-chart.compact {
    min-height: 28px;
  }

  .center-bottom-stack .line-chart {
    min-height: 28px;
  }

  .center-bottom-stack .control-stat-card {
    grid-template-columns: 52px minmax(0, 1fr);
    padding: 6px 8px;
  }

  .center-bottom-stack .donut-chart {
    width: 44px;
    height: 44px;
  }

  .center-bottom-stack .control-stat-list span,
  .center-bottom-stack .control-stat-list small {
    font-size: 9px;
    line-height: 1.18;
  }
}

@media (max-width: 1180px) {
  .map-wrapper {
    --frame-left: 292px;
    --frame-right: 340px;
  }

  .dashboard-header {
    left: 0;
    right: 0;
    min-width: 0;
    padding-right: calc(var(--frame-right) + 14px);
    padding-left: calc(var(--frame-left) + 14px);
  }

  .dashboard-panel {
    width: var(--frame-left);
  }

  .right-panel {
    width: var(--frame-right);
  }
}

@media (max-width: 760px) {
  .map-wrapper {
    --frame-top: 92px;
    --frame-bottom: 40px;
    --frame-left: calc(100vw - 32px);
    --frame-right: calc(100vw - 32px);
  }

  .dashboard-header {
    height: auto;
    min-height: var(--frame-top);
    padding: 10px 16px;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .header-status {
    position: static;
    transform: none;
    justify-content: center;
  }

  .system-title h1 {
    font-size: 17px;
  }

  .system-kicker {
    font-size: 13px;
  }

  .dashboard-panel {
    top: var(--frame-top);
    bottom: auto;
    max-height: 38vh;
    width: calc(100vw - 32px);
    border: 1px solid var(--ui-border);
    border-radius: 7px;
  }

  .left-panel {
    left: 16px;
  }

  .right-panel {
    top: auto;
    right: 16px;
    bottom: var(--frame-bottom);
  }

  .metric-grid {
    grid-template-columns: repeat(4, minmax(78px, 1fr));
    overflow-x: auto;
  }

  .metric-tile {
    min-height: 70px;
  }

  .metric-tile strong {
    font-size: 18px;
  }

  .coordinate-panel {
    width: auto;
    justify-content: flex-start;
    overflow-x: auto;
  }
}

@media (min-width: 761px) {
  .right-panel .route-archive {
    flex: 0 0 242px;
    min-height: 242px;
    max-height: 242px;
    padding: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .right-panel .archive-header {
    flex: 0 0 25px;
    min-height: 25px;
    margin-bottom: 6px;
  }

  .right-panel .archive-row {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 0 10px;
    margin-bottom: 6px;
  }

  .right-panel .archive-row:last-child {
    margin-bottom: 0;
  }

  .right-panel .archive-row span {
    font-size: 12px;
    line-height: 1.18;
  }

  .right-panel .archive-row small {
    margin-top: 4px;
    font-size: 10px;
    line-height: 1.18;
  }
}

@media (min-width: 761px) {
  .right-panel .route-archive.comparison-mode {
    flex-basis: 242px;
    min-height: 242px;
    max-height: 242px;
  }
}

@media (max-height: 880px) and (min-width: 761px) {
  .right-panel .route-archive.comparison-mode {
    flex-basis: 242px;
    min-height: 242px;
    max-height: 242px;
  }

  .right-panel .route-archive.comparison-mode .comparison-row {
    min-height: 0;
  }
}

.left-panel > .panel-section.weather-control-section:nth-of-type(3) {
  flex: 0 0 auto;
  min-height: 0;
}

/* Final typography pass: keep fixed dashboard panels bounded while normalizing type scale. */
.map-wrapper {
  --type-title: 13px;
  --type-body: 12px;
  --type-small: 11px;
  --type-mini: 10px;
  --type-button: 12px;
  --type-card-value: 20px;
  --type-route-value: 13px;
}

.dashboard-panel,
.panel-section,
.right-panel,
.center-bottom-stack {
  font-size: var(--type-body);
  line-height: 1.25;
}

.section-title,
.archive-header,
.center-bottom-stack .stats-section .section-title,
.right-panel .section-title,
.right-panel .archive-header {
  height: 22px;
  min-height: 22px;
  margin-bottom: 6px;
  font-size: var(--type-title);
  line-height: 1.15;
}

button,
.command-group button,
.right-panel button,
.right-panel input,
.right-panel select,
.grid-state-toggle button,
.grid-state-save,
.section-refresh,
.archive-header button,
.archive-tools button {
  font-size: var(--type-button);
  line-height: 1.18;
}

.command-group button {
  min-height: 34px;
  padding: 6px 8px;
}

.field-label,
.range-control,
.time-grid span,
.control-input,
.time-grid input,
.control-hint,
.weather-control-card span,
.weather-control-card strong,
.control-area-main span,
.control-area-main small,
.grid-history-summary strong,
.grid-history-meta span,
.grid-state-title span,
.grid-state-inputs input,
.grid-state-reason,
.spatiotemporal-index-card span,
.spatiotemporal-index-card strong,
.helipad-overview span,
.helipad-overview em,
.helipad-row span,
.helipad-row small,
.helipad-detail span,
.helipad-detail small,
.helipad-detail strong,
.status-list li,
.archive-row span,
.archive-row small,
.coordinate-panel,
.center-bottom-stack .coordinate-panel {
  font-size: var(--type-body);
}

.weather-control-card small,
.grid-history-summary small,
.grid-state-title small,
.grid-state-inputs span,
.grid-state-check span,
.spatiotemporal-index-card small,
.section-pager em,
.archive-tools em,
.level-option small,
.chart-head b,
.bar-column em,
.control-stat-list span,
.control-stat-list small,
.archive-header span small {
  font-size: var(--type-small);
}

.metric-tile span,
.metric-tile em,
.stats-summary span,
.stats-summary em,
.chart-head span,
.center-bottom-stack .stats-summary span,
.center-bottom-stack .stats-summary em,
.center-bottom-stack .chart-head span,
.right-panel .metric-tile span,
.right-panel .metric-tile em {
  font-size: var(--type-small);
}

.metric-tile strong,
.stats-summary strong,
.center-bottom-stack .stats-summary strong,
.right-panel .metric-tile strong,
.right-panel .helipad-overview strong {
  font-size: var(--type-card-value);
  line-height: 1;
}

.route-archive.comparison-mode .comparison-row > span,
.comparison-row span {
  font-size: var(--type-body);
  line-height: 1.12;
}

.route-archive.comparison-mode .comparison-row strong,
.comparison-row strong {
  font-size: var(--type-route-value);
  line-height: 1.1;
}

.route-archive.comparison-mode .comparison-row em,
.route-archive.comparison-mode .comparison-row small,
.comparison-row em,
.comparison-row small {
  font-size: var(--type-small);
  line-height: 1.12;
}

.route-archive.comparison-mode .comparison-row span b,
.comparison-row span b {
  font-size: var(--type-small);
}

.grid-state-detail,
.right-panel-main,
.center-bottom-stack .stats-section,
.comparison-results,
.route-archive,
.control-area-list {
  min-height: 0;
}

.grid-state-detail,
.right-panel-main {
  overflow-y: auto;
}

.route-archive,
.route-archive.comparison-mode,
.center-bottom-stack .stats-section,
.control-area-list {
  overflow: hidden;
}

.grid-state-editor {
  gap: 6px;
  padding: 7px;
}

.grid-state-toggle button,
.grid-state-save,
.grid-state-inputs input,
.grid-state-reason {
  min-height: 28px;
  height: 28px;
}

.grid-state-check {
  min-height: 28px;
  padding: 5px 6px;
}

.spatiotemporal-index-card {
  gap: 5px;
  padding: 7px;
}

.weather-control-actions button {
  min-height: 22px;
}

.right-panel .helipad-row,
.archive-row {
  overflow: hidden;
}

.right-panel-main {
  flex: 1 1 auto;
  min-height: 0;
}

.left-panel {
  overflow-y: auto;
}

@media (max-height: 880px) {
  .map-wrapper {
    --type-title: 12px;
    --type-body: 11px;
    --type-small: 10px;
    --type-mini: 9px;
    --type-button: 11px;
    --type-card-value: 18px;
    --type-route-value: 12px;
  }

  .section-title,
  .archive-header,
  .center-bottom-stack .stats-section .section-title,
  .right-panel .section-title,
  .right-panel .archive-header {
    height: 19px;
    min-height: 19px;
    margin-bottom: 4px;
  }

  .command-group button {
    min-height: 30px;
    padding: 4px 7px;
  }

  .grid-state-toggle button,
  .grid-state-save,
  .grid-state-inputs input,
  .grid-state-reason {
    min-height: 26px;
    height: 26px;
  }

  .top-command-bar {
    padding-top: 4px;
    padding-bottom: 4px;
  }

  .right-panel .route-archive,
  .right-panel .route-archive.comparison-mode {
    flex-basis: 205px;
    min-height: 205px;
    max-height: 205px;
  }

  .right-panel .route-archive .archive-row {
    min-height: 32px;
    padding: 4px 8px;
    margin-bottom: 4px;
  }

  .right-panel .route-archive .archive-row span {
    font-size: 12px;
    line-height: 1.15;
  }

  .right-panel .route-archive .archive-row small {
    margin-top: 2px;
    font-size: 10px;
    line-height: 1.12;
  }
}

@media (max-width: 760px) {
  .map-wrapper {
    --frame-top: calc(var(--header-h) + var(--command-h));
  }
}

/* Responsive layout guard: keep dashboard regions proportional across screens. */
.map-wrapper {
  --header-h: clamp(62px, 7.2vh, 72px);
  --command-h: clamp(42px, 5.2vh, 50px);
  --frame-top: calc(var(--header-h) + var(--command-h));
  --frame-bottom: clamp(8px, 1.2vh, 14px);
  --frame-left: clamp(272px, 20vw, 330px);
  --frame-right: clamp(318px, 24vw, 400px);
  --center-gap: clamp(10px, 1vw, 16px);
  --center-coord-h: clamp(28px, 3.5vh, 32px);
  --center-stats-h: clamp(190px, 26vh, 270px);
}

.dashboard-header {
  height: var(--header-h);
  padding: 7px calc(var(--frame-right) + 14px) 7px calc(var(--frame-left) + 14px);
}

.top-command-bar {
  top: var(--header-h);
  height: var(--command-h);
  padding: clamp(4px, 0.8vh, 6px) calc(var(--frame-right) + 14px) clamp(4px, 0.8vh, 6px)
    calc(var(--frame-left) + 14px);
}

.command-group {
  width: min(640px, 100%);
  grid-template-columns: repeat(5, minmax(86px, 1fr));
}

.dashboard-panel {
  top: var(--frame-top);
  bottom: var(--frame-bottom);
  width: var(--frame-left);
  max-width: calc(50vw - 18px);
}

.right-panel {
  width: var(--frame-right);
  max-width: calc(50vw - 18px);
}

.center-bottom-stack {
  left: calc(var(--frame-left) + var(--center-gap));
  right: calc(var(--frame-right) + var(--center-gap));
  bottom: calc(var(--frame-bottom) + 4px);
  grid-template-rows: var(--center-coord-h) var(--center-stats-h);
  max-height: calc(100vh - var(--frame-top) - var(--frame-bottom) - 24px);
  min-width: 0;
}

.center-bottom-stack .coordinate-panel {
  height: var(--center-coord-h);
  min-height: var(--center-coord-h);
}

.center-bottom-stack .stats-section {
  grid-template-rows: minmax(18px, 0.16fr) minmax(56px, 0.42fr) minmax(82px, 0.62fr);
}

.right-panel-main {
  grid-template-rows: minmax(210px, 0.92fr) minmax(190px, 1fr);
  align-content: stretch;
}

.right-panel .route-archive,
.right-panel .route-archive.comparison-mode {
  flex: 0 1 clamp(160px, 24vh, 242px);
  min-height: clamp(150px, 20vh, 205px);
  max-height: clamp(170px, 24vh, 242px);
}

@media (max-width: 1280px) and (min-width: 761px) {
  .map-wrapper {
    --frame-left: clamp(258px, 22vw, 292px);
    --frame-right: clamp(292px, 26vw, 340px);
    --center-gap: 10px;
    --center-coord-h: 28px;
    --center-stats-h: clamp(170px, 24vh, 226px);
  }

  .command-group {
    gap: 5px;
    grid-template-columns: repeat(5, minmax(60px, 1fr));
  }

  .command-group button {
    padding-inline: 5px;
    font-size: 11px;
  }

  .center-bottom-stack .stats-section {
    grid-template-columns: 1fr 1fr 1fr 1fr;
    grid-template-rows: 20px minmax(58px, 0.45fr) minmax(86px, 0.65fr);
  }

  .right-panel-main {
    grid-template-rows: minmax(198px, 0.92fr) minmax(170px, 1fr);
  }
}

@media (max-width: 1100px) and (min-width: 761px) {
  .map-wrapper {
    --frame-left: clamp(238px, 24vw, 258px);
    --frame-right: clamp(270px, 28vw, 292px);
    --center-stats-h: clamp(188px, 25vh, 220px);
  }

  .command-group {
    gap: 4px;
    grid-template-columns: repeat(5, minmax(52px, 1fr));
  }

  .command-group button {
    min-height: 28px;
    padding-inline: 3px;
    font-size: 10px;
  }

  .center-bottom-stack .stats-section {
    overflow-y: auto;
  }
}

@media (max-height: 820px) and (min-width: 761px) {
  .map-wrapper {
    --header-h: 62px;
    --command-h: 40px;
    --center-coord-h: 26px;
    --center-stats-h: clamp(150px, 22vh, 205px);
  }

  .dashboard-panel {
    padding: 7px;
  }

  .center-bottom-stack {
    bottom: calc(var(--frame-bottom) + 2px);
    gap: 5px;
  }

  .right-panel .route-archive,
  .right-panel .route-archive.comparison-mode {
    min-height: 150px;
    max-height: 190px;
  }
}

@media (max-width: 1100px) and (min-width: 761px) and (max-height: 820px) {
  .map-wrapper {
    --center-stats-h: clamp(188px, 25vh, 220px);
  }
}

@media (max-width: 760px) {
  .map-wrapper {
    --header-h: 92px;
    --command-h: auto;
    --mobile-command-h: 156px;
    --frame-top: 92px;
    --frame-bottom: 36px;
    --frame-left: calc(100vw - 32px);
    --frame-right: calc(100vw - 32px);
    --center-coord-h: 28px;
    --center-stats-h: minmax(150px, 26vh);
  }

  .top-command-bar {
    top: var(--frame-top);
    right: 16px;
    left: 16px;
    height: auto;
    padding: 6px 0;
    border: 1px solid var(--ui-border);
    border-radius: 7px;
    max-height: var(--mobile-command-h);
    overflow-y: auto;
  }

  .command-group {
    width: 100%;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dashboard-panel {
    width: calc(100vw - 32px);
    max-width: none;
  }

  .left-panel {
    top: calc(var(--frame-top) + var(--mobile-command-h) + 10px);
    max-height: 28vh;
  }

  .right-panel {
    max-height: 34vh;
  }

  .center-bottom-stack {
    right: 16px;
    bottom: calc(var(--frame-bottom) + 8px);
    left: 16px;
    grid-template-rows: 28px minmax(150px, 26vh);
  }

  .center-bottom-stack .stats-section {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-rows: 20px 60px 82px 82px;
    overflow-y: auto;
  }

  .center-bottom-stack .stats-summary {
    grid-row: 2;
    grid-column: 1 / -1;
  }

  .center-bottom-stack .flight-chart {
    grid-row: 3;
    grid-column: 1;
  }

  .center-bottom-stack .distance-chart {
    grid-row: 3;
    grid-column: 2;
  }

  .center-bottom-stack .grid-chart {
    grid-row: 4;
    grid-column: 1;
  }

  .center-bottom-stack .control-stat-card {
    grid-row: 4;
    grid-column: 2;
  }
}

/* Unified adaptive layout: one final layer for laptop, 1080p and 4K screens. */
.map-wrapper {
  --header-h: clamp(58px, 6.1vh, 74px);
  --command-h: clamp(38px, 4.5vh, 50px);
  --frame-top: calc(var(--header-h) + var(--command-h));
  --frame-bottom: clamp(8px, 1vh, 14px);
  --frame-left: clamp(258px, 18vw, 344px);
  --frame-right: clamp(300px, 22vw, 430px);
  --center-gap: clamp(8px, 0.85vw, 16px);
  --center-coord-h: clamp(26px, 3vh, 34px);
  --center-stats-h: clamp(160px, 23vh, 270px);
  --panel-gap: clamp(6px, 0.8vh, 10px);
  --right-monitor-h: clamp(198px, 26vh, 292px);
  --right-helipad-h: clamp(190px, 33vh, 420px);
  --right-archive-h: clamp(190px, 26vh, 250px);
  --panel-pad: clamp(7px, 0.75vh, 10px);
  --type-title: clamp(12px, 0.7vw, 16px);
  --type-body: clamp(11px, 0.58vw, 14px);
  --type-small: clamp(10px, 0.48vw, 12px);
  --type-button: clamp(10px, 0.56vw, 13px);
  --type-card-value: clamp(18px, 1.08vw, 26px);
  --type-route-value: clamp(12px, 0.66vw, 15px);
}

.dashboard-header {
  height: var(--header-h);
  padding: 7px calc(var(--frame-right) + 14px) 7px calc(var(--frame-left) + 14px);
}

.top-command-bar {
  top: var(--header-h);
  height: var(--command-h);
  padding: clamp(4px, 0.7vh, 6px) calc(var(--frame-right) + 14px) clamp(4px, 0.7vh, 6px)
    calc(var(--frame-left) + 14px);
}

.command-group {
  width: min(700px, calc(100vw - var(--frame-left) - var(--frame-right) - 40px));
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: clamp(5px, 0.55vw, 9px);
}

.command-group button {
  min-width: 0;
  min-height: clamp(28px, 3.7vh, 36px);
  padding: 5px 7px;
  font-size: var(--type-button);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dashboard-panel {
  top: var(--frame-top);
  bottom: var(--frame-bottom);
  width: var(--frame-left);
  max-width: calc(50vw - 18px);
  padding: var(--panel-pad);
}

.right-panel {
  width: var(--frame-right);
  max-width: calc(50vw - 18px);
  display: grid;
  grid-template-rows: minmax(0, 1fr) var(--right-archive-h);
  gap: var(--panel-gap);
  overflow: hidden;
}

.right-panel-main {
  min-height: 0;
  display: grid;
  grid-template-rows: var(--right-monitor-h) var(--right-helipad-h);
  align-content: start;
  gap: var(--panel-gap);
  overflow: hidden;
  padding-right: 0;
}

.right-panel-main > .panel-section,
.right-panel .route-archive {
  min-height: 0;
  margin: 0;
  overflow: hidden;
}

.right-panel-main > .panel-section:first-child,
.right-panel .helipad-section,
.right-panel .route-archive {
  padding: var(--panel-pad);
}

.right-panel .section-title,
.right-panel .archive-header {
  height: clamp(18px, 2.4vh, 24px);
  min-height: clamp(18px, 2.4vh, 24px);
  margin-bottom: clamp(4px, 0.65vh, 7px);
  font-size: var(--type-title);
}

.right-panel .metric-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: clamp(6px, 0.75vh, 9px);
}

.right-panel .metric-tile {
  min-height: clamp(46px, 6.2vh, 70px);
  padding: clamp(6px, 0.75vh, 9px);
}

.right-panel .metric-tile strong,
.right-panel .helipad-overview strong {
  font-size: var(--type-card-value);
}

.right-panel .metric-tile span,
.right-panel .metric-tile em,
.right-panel .status-list li,
.right-panel .helipad-overview span,
.right-panel .helipad-overview em,
.right-panel .helipad-row span,
.right-panel .helipad-row small,
.right-panel .archive-row span,
.right-panel .archive-row small {
  font-size: var(--type-body);
}

.right-panel .status-list {
  margin-top: clamp(5px, 0.75vh, 9px);
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: clamp(4px, 0.6vh, 7px) clamp(8px, 0.9vw, 12px);
}

.right-panel .status-list li {
  min-height: clamp(15px, 2.2vh, 22px);
  line-height: 1.15;
}

.right-panel .helipad-section {
  display: flex;
  flex-direction: column;
  gap: clamp(4px, 0.65vh, 7px);
}

.right-panel .helipad-overview {
  min-height: clamp(28px, 4.6vh, 44px);
  padding: clamp(4px, 0.7vh, 8px) clamp(7px, 0.75vw, 10px);
}

.right-panel .helipad-visibility-btn,
.right-panel .helipad-actions button {
  min-height: clamp(22px, 3.2vh, 30px);
  padding: 4px 7px;
  font-size: var(--type-button);
}

.right-panel .helipad-hint {
  min-height: 0;
  padding: clamp(3px, 0.6vh, 6px) 7px;
  font-size: var(--type-small);
  line-height: 1.18;
}

.right-panel .helipad-detail {
  max-height: clamp(54px, 8vh, 78px);
  overflow: hidden;
}

.right-panel .helipad-list {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: minmax(clamp(34px, 5vh, 48px), 1fr);
  gap: clamp(3px, 0.55vh, 6px);
  overflow: hidden;
}

.right-panel .helipad-row {
  min-height: 0;
  padding: clamp(4px, 0.7vh, 7px) clamp(7px, 0.75vw, 9px);
}

.right-panel .helipad-row span,
.right-panel .helipad-row small,
.right-panel .archive-row span,
.right-panel .archive-row small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.15;
}

.right-panel .route-archive,
.right-panel .route-archive.comparison-mode {
  height: auto;
  min-height: 0;
  max-height: none;
  flex: none;
  display: flex;
  flex-direction: column;
}

.right-panel .archive-header {
  flex: 0 0 auto;
}

.right-panel .comparison-results {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.right-panel .archive-row,
.right-panel .route-archive.comparison-mode .comparison-row {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 clamp(7px, 0.8vw, 10px);
  margin-bottom: clamp(3px, 0.55vh, 7px);
}

.right-panel .archive-row:last-child,
.right-panel .route-archive.comparison-mode .comparison-row:last-child {
  margin-bottom: 0;
}

.right-panel .archive-row span {
  font-size: var(--type-body);
}

.right-panel .archive-row small {
  margin-top: 3px;
  font-size: var(--type-small);
}

.route-archive.comparison-mode .comparison-row > span,
.route-archive.comparison-mode .comparison-row strong,
.route-archive.comparison-mode .comparison-row em,
.route-archive.comparison-mode .comparison-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.center-bottom-stack {
  left: calc(var(--frame-left) + var(--center-gap));
  right: calc(var(--frame-right) + var(--center-gap));
  bottom: calc(var(--frame-bottom) + 4px);
  grid-template-rows: var(--center-coord-h) var(--center-stats-h);
  max-height: calc(100vh - var(--frame-top) - var(--frame-bottom) - 20px);
  min-width: 0;
}

.center-bottom-stack .coordinate-panel {
  height: var(--center-coord-h);
  min-height: var(--center-coord-h);
}

.center-bottom-stack .stats-section {
  min-height: 0;
  overflow: hidden;
}

@media (max-height: 820px) and (min-width: 761px) {
  .map-wrapper {
    --header-h: 58px;
    --command-h: 38px;
    --frame-bottom: 8px;
    --center-coord-h: 26px;
    --center-stats-h: clamp(150px, 21vh, 188px);
    --right-monitor-h: clamp(188px, 26vh, 212px);
    --right-helipad-h: clamp(170px, 31vh, 238px);
    --right-archive-h: clamp(178px, 25vh, 202px);
    --panel-gap: 6px;
    --panel-pad: 7px;
    --type-title: 12px;
    --type-body: 11px;
    --type-small: 10px;
    --type-button: 10px;
    --type-card-value: 18px;
  }

  .right-panel .helipad-hint {
    display: none;
  }

  .right-panel .helipad-detail {
    display: none;
  }
}

@media (min-width: 1800px) and (min-height: 950px) {
  .map-wrapper {
    --frame-left: clamp(312px, 16.8vw, 340px);
    --frame-right: clamp(360px, 20vw, 396px);
    --center-stats-h: clamp(210px, 21vh, 260px);
    --right-archive-h: clamp(220px, 22vh, 250px);
  }
}

@media (min-width: 2560px) {
  .map-wrapper {
    --header-h: clamp(74px, 4vh, 88px);
    --command-h: clamp(50px, 2.8vh, 62px);
    --frame-left: clamp(330px, 9vw, 360px);
    --frame-right: clamp(370px, 10vw, 400px);
    --center-stats-h: clamp(230px, 11vh, 250px);
    --right-monitor-h: clamp(280px, 15vh, 340px);
    --right-helipad-h: clamp(320px, 19vh, 450px);
    --right-archive-h: clamp(250px, 13vh, 300px);
    --type-title: clamp(15px, 0.46vw, 18px);
    --type-body: clamp(13px, 0.38vw, 16px);
    --type-small: clamp(11px, 0.32vw, 14px);
    --type-button: clamp(13px, 0.36vw, 16px);
    --type-card-value: clamp(24px, 0.72vw, 32px);
  }
}

@media (max-width: 760px) {
  .command-group {
    width: 100%;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .right-panel {
    display: flex;
    max-height: 34vh;
  }

  .right-panel-main {
    display: block;
    overflow-y: auto;
  }
}

@media (min-width: 761px) {
  .left-panel,
  .right-panel,
  .center-bottom-stack {
    transition: transform 0.24s ease, opacity 0.24s ease;
    will-change: transform;
  }

  .left-panel.panel-collapsed {
    transform: translateX(calc(-100% - 10px));
    pointer-events: none;
  }

  .right-panel.panel-collapsed {
    transform: translateX(calc(100% + 10px));
    pointer-events: none;
  }

  .center-bottom-stack.panel-collapsed {
    grid-template-rows: var(--center-coord-h) 0;
    gap: 0;
    max-height: var(--center-coord-h);
  }

  .center-bottom-stack.panel-collapsed .stats-section {
    min-height: 0;
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
    border-width: 0;
    opacity: 0;
    transform: translateY(12px);
    pointer-events: none;
    overflow: hidden;
  }

  .panel-edge-toggle {
    position: absolute;
    z-index: 1004;
    width: 24px;
    height: 38px;
    min-height: 0;
    border: 1px solid rgba(103, 232, 249, 0.34);
    border-radius: 0;
    background: rgba(6, 18, 24, 0.72);
    color: #e0f2fe;
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.32);
    backdrop-filter: blur(8px) saturate(1.15);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    font-weight: 900;
    line-height: 1;
    cursor: pointer;
    transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease,
      left 0.24s ease, right 0.24s ease, bottom 0.24s ease;
    transform: none;
  }

  .panel-edge-toggle:hover {
    transform: none;
    background: rgba(14, 116, 144, 0.72);
    border-color: rgba(103, 232, 249, 0.7);
    color: #fff;
  }

  .panel-edge-toggle:focus-visible {
    outline: 2px solid #67e8f9;
    outline-offset: 2px;
  }

  .left-edge-toggle {
    left: var(--frame-left);
    top: calc(var(--frame-top) + (100vh - var(--frame-top) - var(--frame-bottom)) / 2 - 19px);
    border-left: 0;
    border-radius: 0 7px 7px 0;
  }

  .left-edge-toggle.collapsed {
    left: 0;
  }

  .right-edge-toggle {
    right: var(--frame-right);
    top: calc(var(--frame-top) + (100vh - var(--frame-top) - var(--frame-bottom)) / 2 - 19px);
    border-right: 0;
    border-radius: 7px 0 0 7px;
  }

  .right-edge-toggle.collapsed {
    right: 0;
  }

  .bottom-edge-toggle {
    left: 50%;
    bottom: calc(var(--frame-bottom) + var(--center-coord-h) + var(--center-stats-h) + 14px);
    width: 46px;
    height: 20px;
    min-height: 20px;
    margin-left: -23px;
    border-bottom: 0;
    border-radius: 7px 7px 0 0;
    font-size: 13px;
  }

  .bottom-edge-toggle.collapsed {
    bottom: calc(var(--frame-bottom) + var(--center-coord-h) + 8px);
    border-bottom: 0;
  }
}

@media (max-width: 760px) {
  .panel-edge-toggle {
    display: none;
  }
}

/* Occupancy layer adds a ninth layer button; reserve enough height so lower controls start below it. */
.left-panel > .panel-section:nth-of-type(1) {
  flex: 0 0 clamp(252px, 30vh, 282px);
}

.left-panel > .panel-section:nth-of-type(2) {
  flex: 0 0 96px;
}

@media (max-height: 880px) and (min-width: 761px) {
  .left-panel > .panel-section:nth-of-type(1) {
    flex-basis: 252px;
  }
}

@media (max-height: 820px) and (min-width: 761px) {
  .left-panel > .panel-section:nth-of-type(1) {
    flex-basis: 246px;
  }
}

/* 1920 desktop baseline: prioritize a clear map viewport and keep panels bounded without scrollbars. */
@media (min-width: 1360px) and (min-height: 820px) {
  .map-wrapper {
    --header-h: clamp(56px, 5.5vh, 64px);
    --command-h: clamp(36px, 3.9vh, 42px);
    --frame-bottom: 8px;
    --frame-left: clamp(282px, 15.2vw, 304px);
    --frame-right: clamp(330px, 18vw, 360px);
    --center-gap: 10px;
    --center-coord-h: 28px;
    --center-stats-h: clamp(168px, 18vh, 194px);
    --panel-gap: 6px;
    --panel-pad: 7px;
    --left-layer-h: clamp(232px, 24vh, 252px);
    --left-altitude-h: 84px;
    --right-monitor-h: clamp(198px, 21vh, 226px);
    --right-archive-h: clamp(176px, 19vh, 210px);
    --type-title: 12px;
    --type-body: 11px;
    --type-small: 10px;
    --type-button: 11px;
    --type-card-value: 18px;
    --type-route-value: 12px;
  }

  .dashboard-header {
    padding-block: 6px;
  }

  .top-command-bar {
    padding-block: 4px;
  }

  .dashboard-panel {
    display: grid;
    gap: var(--panel-gap);
    padding: var(--panel-pad);
    overflow: hidden;
  }

  .left-panel {
    grid-template-rows: var(--left-layer-h) var(--left-altitude-h) minmax(0, 1fr);
    overflow: hidden;
  }

  .left-panel > .panel-section,
  .left-panel > .panel-section:nth-of-type(1),
  .left-panel > .panel-section:nth-of-type(2),
  .left-panel > .panel-section:nth-of-type(3),
  .left-panel > .weather-control-section,
  .left-panel > .control-area-section {
    min-height: 0;
    margin: 0;
    overflow: hidden;
    flex: none;
  }

  .left-panel > .panel-section:nth-of-type(1) {
    height: var(--left-layer-h);
  }

  .left-panel > .panel-section:nth-of-type(2) {
    height: var(--left-altitude-h);
  }

  .left-panel > .control-area-section {
    display: flex;
    flex-direction: column;
  }

  .toggle-grid {
    gap: 4px;
  }

  .toggle-grid button {
    min-height: 26px;
    padding: 4px 6px;
  }

  .field-label {
    margin: 6px 0 3px;
  }

  .level-toggle {
    height: 28px;
  }

  .range-control {
    min-height: 24px;
    grid-template-columns: 70px 1fr 42px;
    gap: 5px;
  }

  .terrain-row {
    grid-template-columns: 56px 16px 1fr 42px;
  }

  .weather-control-card {
    min-height: 34px;
  }

  .control-input,
  .time-grid input {
    height: 26px;
  }

  .control-hint {
    min-height: 26px;
    padding: 5px 7px;
  }

  .control-area-list {
    flex: 1 1 auto;
    max-height: none;
    overflow: hidden;
  }

  .grid-state-detail,
  .right-panel-main {
    overflow: hidden;
  }

  .grid-history-summary {
    padding: 6px 7px;
  }

  .grid-history-meta span {
    min-height: 22px;
    padding: 4px 5px;
  }

  .grid-state-editor {
    gap: 5px;
    padding: 6px;
  }

  .grid-state-toggle button,
  .grid-state-save,
  .grid-state-inputs input,
  .grid-state-reason,
  .grid-state-check {
    min-height: 25px;
    height: 25px;
  }

  .spatiotemporal-index-card {
    padding: 6px;
  }

  .right-panel {
    grid-template-rows: minmax(0, 1fr) var(--right-archive-h);
    overflow: hidden;
  }

  .right-panel-main {
    display: grid;
    grid-template-rows: var(--right-monitor-h) minmax(0, 1fr);
    gap: var(--panel-gap);
  }

  .right-panel .metric-tile {
    min-height: 0;
    padding: 7px;
  }

  .right-panel .status-list {
    gap: 5px 8px;
  }

  .right-panel .helipad-section {
    min-height: 0;
  }

  .right-panel .helipad-overview {
    min-height: 34px;
  }

  .right-panel .helipad-hint,
  .right-panel .helipad-detail {
    display: none;
  }

  .right-panel .helipad-list {
    grid-auto-rows: minmax(38px, 1fr);
    overflow: hidden;
  }

  .right-panel .route-archive,
  .right-panel .route-archive.comparison-mode {
    flex: none;
    min-height: 0;
    max-height: none;
    height: auto;
    overflow: hidden;
  }

  .center-bottom-stack {
    grid-template-rows: var(--center-coord-h) var(--center-stats-h);
    bottom: calc(var(--frame-bottom) + 4px);
    max-height: none;
  }

  .center-bottom-stack .coordinate-panel {
    height: var(--center-coord-h);
    min-height: var(--center-coord-h);
    padding: 4px 10px;
  }

  .center-bottom-stack .stats-section {
    grid-template-columns: 1fr 1fr 1fr 1fr;
    grid-template-rows: 20px minmax(52px, 0.44fr) minmax(76px, 0.64fr);
    gap: 6px;
    padding: 7px;
    overflow: hidden;
  }

  .center-bottom-stack .mini-chart,
  .center-bottom-stack .control-stat-card,
  .center-bottom-stack .stats-summary div {
    padding: 6px 7px;
  }

  .center-bottom-stack .chart-head {
    height: 15px;
    margin-bottom: 3px;
  }
}

@media (min-width: 1800px) and (min-height: 950px) {
  .map-wrapper {
    --frame-left: 304px;
    --frame-right: 360px;
    --center-stats-h: 188px;
    --right-archive-h: 204px;
  }
}

@media (min-width: 2560px) {
  .map-wrapper {
    --frame-left: 340px;
    --frame-right: 388px;
    --center-stats-h: 218px;
    --right-monitor-h: 260px;
    --right-archive-h: 236px;
    --type-title: 15px;
    --type-body: 13px;
    --type-small: 11px;
    --type-button: 13px;
    --type-card-value: 24px;
    --type-route-value: 14px;
  }
}
</style>

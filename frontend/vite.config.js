/*
 * @file vite.config.js
 * @author changbai
 * @project 基于GeoSOT空域剖分单元状态管控的低空无人机飞行线路规划系统
 * @date 2026-05-08
 * @description Vite前端构建配置文件，负责Vue与Cesium插件配置。
 */

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  // Keep frontend and backend environment variables in the repository-root .env file.
  envDir: '..',
  plugins: [
    vue(),
    // 确保这里启用了 cesium 插件，它会自动处理静态资源路径
    cesium()
  ],
  server: {
    // 增加这一行，防止因为请求频率过高被 Vite 拦截
    hmr: true
  }
});

import { defineConfig } from 'wxt';
import vue from '@wxt-dev/module-vue';

/**
 * WXT 工程配置：MV3、权限最小化、入口与产出目录
 */
export default defineConfig({
  srcDir: 'src',
  outDir: '.output',
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'EchoTik 妙手采集助手',
    version: '0.1.0',
    description: 'EchoTik 榜单采集并联动 TikTok/妙手 ERP 的浏览器端工具',
    minimum_chrome_version: '120',
    permissions: ['storage', 'tabs', 'scripting', 'sidePanel', 'alarms', 'notifications'],
    host_permissions: [
      'https://echotik.live/*',
      'https://*.echotik.live/*',
      'https://www.tiktok.com/*',
      'https://shop.tiktok.com/*',
      'http://localhost:8000/*',
      'http://localhost:8001/*',
    ],
    icons: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: 'EchoTik 妙手采集助手',
      default_icon: {
        16: 'icons/icon-16.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});

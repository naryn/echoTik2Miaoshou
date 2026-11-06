/**
 * 管理台 Vue 应用入口（独立扩展页面 manager.html）：挂载路由与全局状态 store
 */
import { createApp } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
import App from './App.vue';
import Dashboard from './pages/Dashboard.vue';
import RankingCollector from './pages/RankingCollector.vue';
import RankingHistory from './pages/RankingHistory.vue';
import ProductList from './pages/ProductList.vue';
import BatchTasks from './pages/BatchTasks.vue';
import AttemptLog from './pages/AttemptLog.vue';
import Settings from './pages/Settings.vue';
import { initStore } from './store';
import './style.css';

/** 路由表（六个占位页面，完整实现由后续迭代完成） */
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard, meta: { title: '概览' } },
    { path: '/ranking', name: 'ranking', component: RankingCollector, meta: { title: '榜单采集' } },
    { path: '/ranking-history', name: 'ranking-history', component: RankingHistory, meta: { title: '历史榜单' } },
    { path: '/products', name: 'products', component: ProductList, meta: { title: '商品列表' } },
    { path: '/tasks', name: 'tasks', component: BatchTasks, meta: { title: '任务' } },
    { path: '/logs', name: 'logs', component: AttemptLog, meta: { title: '日志' } },
    { path: '/settings', name: 'settings', component: Settings, meta: { title: '设置' } },
  ],
});

void initStore().then(() => {
  createApp(App).use(router).mount('#app');
});

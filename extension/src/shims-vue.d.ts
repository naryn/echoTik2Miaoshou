/**
 * Vue SFC 模块声明（使 tsc 可解析 *.vue 导入）
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

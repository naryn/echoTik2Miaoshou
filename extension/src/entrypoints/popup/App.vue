<script setup lang="ts">
/**
 * Popup：连接状态 + 当前批次进度 + 打开 Side Panel 按钮
 */
import { onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import { sendMsg } from '@/shared/messaging';
import type { RuntimePublicState } from '@/shared/types';

const state = ref<RuntimePublicState | null>(null);

onMounted(async () => {
  state.value = await sendMsg('client.getState', undefined).catch(() => null);
});

/**
 * 打开 Side Panel 并关闭 popup
 */
async function openPanel(): Promise<void> {
  const win = await browser.windows.getCurrent();
  if (win.id != null) {
    await browser.sidePanel.open({ windowId: win.id }).catch(() => undefined);
  }
  window.close();
}
</script>

<template>
  <div class="wrap">
    <h1>EchoTik 采集助手</h1>
    <div class="row">
      <span class="dot" :class="state?.connected ? 'on' : 'off'"></span>
      {{ state?.connected ? '远程已连接' : '远程未连接' }}
    </div>
    <div class="row">
      批次：{{ state?.active_batch_id ? state.active_batch_id.slice(0, 8) : '无' }}
      <template v-if="state?.progress"> · {{ state.progress.done }}/{{ state.progress.total }}</template>
    </div>
    <div class="row" v-if="state?.waiting_verification" style="color: #f59e0b">等待人工验证</div>
    <button @click="openPanel">打开管理台</button>
  </div>
</template>

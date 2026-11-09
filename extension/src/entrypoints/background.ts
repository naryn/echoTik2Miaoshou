/**
 * MV3 Service Worker 入口：事件注册、客户端注册、调度协调、outbox 同步
 *
 * 核心原则（规范 §1/§8）：
 * - 所有监听器顶层同步注册；状态持久化到 chrome.storage.local
 * - 任务生命周期采用"阶段 checkpoint + 消息事件推进"：每个阶段完成时持久化并触发下一阶段，
 *   SW 被终止后由 alarm/onStartup/tabs 事件触发 reconcile() 续接
 * - 不把任务生命周期放在一次未受控 async 调用里
 */
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import {
  loadClientIdentity,
  outboxAck,
  outboxEnqueue,
  outboxPending,
  saveClientIdentity,
  FIXED_SERVER_URL,
  storageGet,
  storageGetMany,
  storageSet,
  type OutboxEvent,
} from '@/modules/storage';
import { createApiClient, ApiError, type ApiClient } from '@/modules/api/client';
import { createEchoTikAdapter, type EchoTikTransport } from '@/modules/echotik/adapter';
import { createFastMossAdapter, type FastMossTransport, type CapturedApiCall } from '@/modules/fastmoss/adapter';
import { createRankingAdapter, resolveSource, type RankingTransports } from '@/modules/ranking/registry';
import { RANKING_SOURCE_META, sourceMeta } from '@/modules/ranking/sources';
import { ensureSingleTikTokTab, clearWorkerTabIfMatches, resolveDetailUrl } from '@/modules/tiktok/tab-manager';
import { dlog, clearDebugLogs, readDebugLogs } from '@/modules/debug/log';
import {
  createTaskStateMachine,
  isTerminal,
  recoveryTargetStage,
  transition,
  type TaskStateMachine,
} from '@/modules/runner/state-machine';
import { sendMsg, wrapHandler } from '@/shared/messaging';
import type { MessageMap } from '@/shared/types/messages';
import {
  ERROR_CODES,
  type AuthMe,
  type CategoryNode,
  type ProductItem,
  type ProductRankingEntry,
  type RankingQuery,
  type RankingSource,
  type RunnerCheckpoint,
  type RuntimePublicState,
  type TaskStatus,
} from '@/shared/types';

const EXT_VERSION = '0.1.2';
const ALARM_TICK = 'echotik-tick';

/** 按运行浏览器的本地日历获取昨日，日榜只请求已完整结算的日期。 */
function yesterdayDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 仅比较数字语义版本；发布版本均使用 major.minor.patch。 */
function isVersionNewer(candidate: string, current: string): boolean {
  const c = candidate.split('.').map((part) => Number(part) || 0);
  const v = current.split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(c.length, v.length); index += 1) {
    if ((c[index] ?? 0) !== (v[index] ?? 0)) return (c[index] ?? 0) > (v[index] ?? 0);
  }
  return false;
}

/**
 * 批量执行预设时，日榜日期始终滚动到昨日。
 * 预设保存的是筛选配置而非历史日期，避免旧预设在每天运行时仍请求保存当日的未结算榜单。
 */
function withYesterdayForDailyPreset(query: RankingQuery): RankingQuery {
  const periodType = query.period?.type ?? query.rankingType;
  if (periodType !== 'daily') return query;
  const date = yesterdayDate();
  return {
    ...query,
    period: { ...query.period, type: 'daily', startDate: date },
    // 兼容仍读取旧字段的适配器与历史预设。
    periodStart: date.replaceAll('-', ''),
    periodEnd: date.replaceAll('-', ''),
  };
}

export default defineBackground(() => {
  // ---------------- 顶层同步注册所有监听器（MV3 硬性要求） ----------------
  browser.runtime.onInstalled.addListener((details) => {
    void handleInstalled(details.reason);
  });
  browser.runtime.onStartup.addListener(() => {
    void reconcile('onStartup');
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_TICK) void handleTick();
    if (alarm.name === 'runner-next') void handleRunnerNextAlarm();
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    void clearWorkerTabIfMatches(tabId).then(() => reconcile('tabs.onRemoved'));
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete') void reconcile('tabs.onUpdated');
  });
  browser.runtime.onMessage.addListener((msg: { type?: string; payload?: unknown }, sender, sendResponse) => {
    void routeMessage(msg, sender).then(sendResponse);
    return true; // 异步响应
  });
  // 注意：manifest 中 action 绑定 popup（Chrome 不允许 default_popup 与
  // openPanelOnActionClick 并存），管理台经 popup 内"打开管理台"按钮以独立窗口打开

  // 周期 alarm：reconcile + outbox 同步（周期 1 分钟，≥ 0.5 分钟约束）
  void browser.alarms.create(ALARM_TICK, { periodInMinutes: 1 });

  // ---------------- 认证 Token ----------------

  /**
   * 安装/更新处理：生成 install_id，并尝试用已填写的 auth token 绑定账号身份
   * @param reason onInstalled 原因
   */
  async function handleInstalled(reason: string): Promise<void> {
    await storageSet('extension_version', EXT_VERSION);
    let installId = await storageGet('install_id');
    if (!installId) {
      installId = crypto.randomUUID();
      await storageSet('install_id', installId);
    }
    await refreshAuthIdentity().catch(() => null);
    if (reason === 'install') {
      await browser.tabs.create({ url: 'https://echotik.live/' }).catch(() => undefined);
    }
  }

  /**
   * 用当前 auth token 请求 /v1/auth/me，并把账号共享的 client_id/角色写入本地
   * @throws ApiError token 无效或网络失败时抛出
   */
  async function fetchAuthIdentity(): Promise<AuthMe> {
    const me = await getApi().authMe();
    await saveClientIdentity({
      client_id: me.client_id,
      client_token: null,
      registered_at: me.registered_at ?? new Date().toISOString(),
    });
    await storageSet('identity_role', me.role === 'ADMIN' ? 'ADMIN' : 'USER');
    await storageSet('identity_display_name', me.display_name ?? null);
    return me;
  }

  /**
   * 刷新认证身份：未填写 token 或 token 无效时清空身份绑定（保留 token 供设置页修正）
   */
  async function refreshAuthIdentity(): Promise<AuthMe | null> {
    const token = await storageGet('auth_token');
    if (!token) {
      await clearClientBinding();
      return null;
    }
    try {
      return await fetchAuthIdentity();
    } catch {
      await clearClientBinding();
      return null;
    }
  }

  /**
   * 清空本地身份绑定（client_id/token/角色/显示名），不删除 auth token 本身
   */
  async function clearClientBinding(): Promise<void> {
    await saveClientIdentity({ client_id: null, client_token: null, registered_at: null });
    await storageSet('identity_role', null);
    await storageSet('identity_display_name', null);
  }

  // ---------------- API 客户端 ----------------

  let cachedApi: ApiClient | null = null;

  /**
   * 获取远程 API 客户端（base URL 与鉴权均在请求时惰性读取，配置变更即时生效）
   */
  function getApi(): ApiClient {
    return (cachedApi ??= createApiClient({
      // 服务地址内置，避免旧版本地存储或界面输入把请求发往错误环境。
      getBaseUrl: async () => FIXED_SERVER_URL,
      getAuth: async () => {
        const s = await storageGetMany(['client_id', 'client_token']);
        return { client_id: s.client_id, client_token: s.client_token };
      },
      // 插件设置填写的认证 Token：所有请求以 Bearer 发送
      getAuthToken: () => storageGet('auth_token'),
    }));
  }

  // ---------------- reconcile（防抖锁） ----------------

  let reconcileRunning = false;
  let reconcileQueued = false;

  /**
   * 状态协调：读服务端 active-task、比对本地 checkpoint，决定恢复/等待/终止
   * 带去重锁，避免并发执行（规范 §8.3）
   * @param trigger 触发来源（日志用）
   */
  async function reconcile(trigger: string): Promise<void> {
    if (reconcileRunning) {
      reconcileQueued = true;
      return;
    }
    reconcileRunning = true;
    try {
      do {
        reconcileQueued = false;
        await reconcileOnce(trigger);
      } while (reconcileQueued);
    } finally {
      reconcileRunning = false;
    }
  }

  /**
   * reconcile 单次执行体
   * @param trigger 触发来源
   */
  async function reconcileOnce(trigger: string): Promise<void> {
    const identity = await loadClientIdentity();
    if (!identity.client_id) return; // 未注册态：等待注册
    const checkpoint = await loadCheckpoint();
    if (!checkpoint.active_batch_id || !checkpoint.runner_stage) {
      return; // 无活动批次
    }
    if (checkpoint.paused) return; // 用户暂停：不自动推进

    if (checkpoint.runner_stage === 'IDLE') {
      // 空闲检查点仍绑定批次时，主动领取下一件；若批次已终态，claimAndStart
      // 会清理 active_batch_id，顶部“当前批次”随之消失。
      await scheduleClaimNext(checkpoint.active_batch_id);
      return;
    }

    let active: Awaited<ReturnType<ApiClient['activeTask']>> = null;
    try {
      active = await getApi().activeTask();
    } catch {
      return; // 远端不可达：等下个 tick
    }

    if (!active) {
      // 服务端无活动任务：本地 checkpoint 停留在非终态则清理并尝试 claim 下一件
      await saveCheckpoint({ ...checkpoint, runner_stage: 'IDLE', active_task_id: null, attempt_id: null, lease_token: null });
      await scheduleClaimNext(checkpoint.active_batch_id);
      return;
    }

    // 服务端有活动任务：比对本地阶段决定是否续接
    const serverStage = active.status as TaskStatus;
    if (isTerminal(serverStage)) {
      await saveCheckpoint({ ...checkpoint, runner_stage: 'IDLE', active_task_id: null });
      await scheduleClaimNext(checkpoint.active_batch_id);
      return;
    }
    // 本地任务与服务端不一致：以服务端为准重建 checkpoint
    if (checkpoint.active_task_id !== active.task_id) {
      await saveCheckpoint({
        ...checkpoint,
        active_task_id: active.task_id,
        attempt_id: active.attempt_id ?? null,
        lease_token: active.lease_token ?? null,
        runner_stage: serverStage,
        product: active.product ?? null,
        updated_at: new Date().toISOString(),
      });
    }
    // 验证等待中：不推进，由 content script 的 challengeResolved 事件驱动
    if (serverStage === 'WAITING_VERIFICATION') return;
    // 其余非终态：按阶段续接（幂等，重复推进由服务端 attempt/lease 防护）
    await advanceRunner('reconcile:' + trigger);
  }

  // ---------------- Runner 调度（阶段 checkpoint + 消息推进） ----------------

  /**
   * 读取运行检查点
   */
  async function loadCheckpoint(): Promise<RunnerCheckpoint> {
    const cp = await storageGet('runner_checkpoint');
    return (
      cp ?? {
        active_batch_id: null,
        active_task_id: null,
        attempt_id: null,
        lease_token: null,
        runner_stage: 'IDLE',
        worker_tab_id: null,
        product: null,
        next_run_at: null,
        paused: false,
        updated_at: new Date().toISOString(),
      }
    );
  }

  /**
   * 持久化运行检查点（每次阶段迁移必须调用）
   * @param cp 检查点
   */
  async function saveCheckpoint(cp: RunnerCheckpoint): Promise<void> {
    cp.updated_at = new Date().toISOString();
    await storageSet('runner_checkpoint', cp);
    await storageSet('active_batch_id', cp.active_batch_id);
    await storageSet('active_task_id', cp.active_task_id);
    await storageSet('worker_tab_id', cp.worker_tab_id);
    await broadcastState();
  }

  /** 当前任务状态机实例（SW 内存态，恢复时由 checkpoint 重建） */
  let currentSm: TaskStateMachine | null = null;

  /** 运行器串行锁：避免 tabs.onUpdated / pageReady / reconcile 重入导致状态机非法跳变 */
  let runnerBusy = false;
  let runnerQueued = false;

  /**
   * 推进 Runner 一个阶段（串行执行；重入时排队再跑一次）
   * @param why 推进原因（日志用）
   */
  async function advanceRunner(why: string): Promise<void> {
    if (runnerBusy) {
      runnerQueued = true;
      return;
    }
    runnerBusy = true;
    try {
      await runStage(why);
    } finally {
      runnerBusy = false;
      if (runnerQueued) {
        runnerQueued = false;
        void runStage('queued');
      }
    }
  }

  /**
   * 按 checkpoint 执行一次阶段推进（仅由串行锁内部调用）
   * @param why 推进原因（日志用）
   */
  async function runStage(why: string): Promise<void> {
    const cp = await loadCheckpoint();
    if (!cp.active_batch_id || cp.paused) return;
    const stage = cp.runner_stage;
    // 调试日志：记录每次推进的触发原因与当前阶段，便于排查“任务卡住/没动作”
    await dlog('background', 'runStage', {
      why,
      stage,
      task: cp.active_task_id?.slice(0, 12),
      tab: cp.worker_tab_id,
      product: cp.product?.external_product_id,
    });
    if (!stage || stage === 'IDLE') {
      await scheduleClaimNext(cp.active_batch_id);
      return;
    }
    if (!cp.active_task_id || !cp.attempt_id || !cp.lease_token || !cp.product) return;

    // 重建/校正内存状态机
    if (!currentSm || currentSm.taskId !== cp.active_task_id) {
      currentSm = createTaskStateMachine(cp.active_task_id, cp.attempt_id, stage as TaskStatus);
    }

    try {
      switch (stage as TaskStatus) {
        case 'LEASED':
        case 'NAVIGATING': {
          // 导航到商品页（checkpoint 先行）；已在 NAVIGATING 时不重复转换
          if (currentSm.status === 'LEASED') transition(currentSm, 'NAVIGATING', why);
          await saveCheckpoint({ ...cp, runner_stage: 'NAVIGATING' });
          const tabId = await ensureSingleTikTokTab(
            resolveDetailUrl(cp.product.external_product_id, cp.product.detail_url),
          );
          await saveCheckpoint({ ...(await loadCheckpoint()), worker_tab_id: tabId });
          // 页面就绪由 content script 'tiktok.pageReady' 消息推进；超时兜底
          await probeAndAdvance(tabId, cp.product.external_product_id);
          break;
        }
        case 'PAGE_READY': {
          const cp2 = await loadCheckpoint();
          if (!cp2.worker_tab_id) {
            await dlog('background', 'PAGE_READY：未找到工作 Tab', { task: cp2.active_task_id });
            return;
          }
          await dlog('background', 'PAGE_READY：开始检测妙手按钮', {
            productId: cp2.product?.external_product_id,
            tabId: cp2.worker_tab_id,
          });
          const miaoshou = await sendMsg('tiktok.detectMiaoshou', undefined, cp2.worker_tab_id);
          await dlog('background', 'PAGE_READY：妙手按钮检测结果', miaoshou);
          if (!miaoshou.available) {
            await finishTask('FAILED', { evidence: miaoshou.evidence, error_code: ERROR_CODES.MIAOSHOU_UNAVAILABLE });
            return;
          }
          // 已在 PAGE_READY 之外（例如重入时已进入后续阶段）则不再重复提交
          if (currentSm.status === 'PAGE_READY') {
            transition(currentSm, 'SUBMITTING', miaoshou.evidence);
            // 提交前写 SUBMITTING 检查点（规范 §5.3）
            await saveCheckpoint({ ...(await loadCheckpoint()), runner_stage: 'SUBMITTING' });
            await dlog('background', 'PAGE_READY：进入 SUBMITTING，准备点击采集按钮');
            await advanceRunner('submitting');
          } else {
            await dlog('background', 'PAGE_READY：状态机不同步，未进入提交', { currentState: currentSm.status });
          }
          break;
        }
        case 'SUBMITTING': {
          const cp2 = await loadCheckpoint();
          if (!cp2.worker_tab_id) {
            await dlog('background', 'SUBMITTING：未找到工作 Tab', { task: cp2.active_task_id });
            return;
          }
          await dlog('background', 'SUBMITTING：调用妙手按钮点击', {
            productId: cp2.product?.external_product_id,
            tabId: cp2.worker_tab_id,
          });
          const submission = await sendMsg('tiktok.submitCollect', undefined, cp2.worker_tab_id);
          await dlog('background', 'SUBMITTING：妙手点击结果', submission);
          if (!submission.submitted) {
            // 无提交证据：先核对 ERP（当前无授权途径 → UNKNOWN）
            const verify = await sendMsg(
              'tiktok.verifyCollect',
              { productId: cp2.product!.external_product_id },
              cp2.worker_tab_id,
            );
            await finishTask(
              verify.state === 'CONFIRMED' ? 'SUCCESS' : 'UNKNOWN',
              { evidence: `${submission.evidence ?? ''} | ${verify.evidence ?? ''}`, error_code: submission.errorCode },
            );
            return;
          }
          if (currentSm.status === 'SUBMITTING') transition(currentSm, 'SUBMITTED', submission.evidence);
          await saveCheckpoint({ ...(await loadCheckpoint()), runner_stage: 'SUBMITTED' });
          await advanceRunner('submitted');
          break;
        }
        case 'SUBMITTED': {
          const cp2 = await loadCheckpoint();
          const verify = await sendMsg(
            'tiktok.verifyCollect',
            { productId: cp2.product!.external_product_id },
            cp2.worker_tab_id ?? undefined,
          ).catch(() => ({ state: 'UNKNOWN' as const, evidence: 'verify 消息失败' }));
          // SUBMITTED ≠ SUCCESS：无 ERP 侧确认时记 UNKNOWN（规范 §5.3/T14）
          const result = verify.state === 'CONFIRMED' ? 'SUCCESS' : verify.state === 'NOT_CONFIRMED' ? 'FAILED' : 'UNKNOWN';
          await finishTask(result, { evidence: verify.evidence });
          break;
        }
        case 'WAITING_VERIFICATION':
          // 等待人工验证：由 tiktok.challengeResolved 事件推进，不轮询
          return;
        case 'RECOVERING': {
          const cp2 = await loadCheckpoint();
          if (!cp2.worker_tab_id || !cp2.product) return;
          const probe = await sendMsg(
            'tiktok.probe',
            { expectedProductId: cp2.product.external_product_id },
            cp2.worker_tab_id,
          );
          if (probe.state === 'READY') {
            const target = recoveryTargetStage(stage as TaskStatus);
            if (target === 'UNKNOWN') {
              await finishTask('UNKNOWN', { evidence: '验证恢复时处于提交阶段，无法判定是否已提交' });
            } else {
              await saveCheckpoint({ ...(await loadCheckpoint()), runner_stage: target });
              await advanceRunner('recovered');
            }
          } else if (probe.state === 'CHALLENGE' || probe.state === 'ACCESS_RESTRICTED') {
            // 持续受限：保持等待，不循环强刷（规范 T12）
            await saveCheckpoint({ ...(await loadCheckpoint()), runner_stage: 'WAITING_VERIFICATION' });
          }
          break;
        }
        default:
          return;
      }
    } catch (e) {
      const err = e as Error;
      // 阶段推进失败：记录失败事件并终结当前任务（幂等）
      await finishTask('FAILED', { evidence: err.message?.slice(0, 200), error_code: 'RUNNER_STAGE_ERROR' }).catch(() => undefined);
    }
  }

  /**
   * 导航后探测页面就绪/验证状态并推进
   * @param tabId worker tab
   * @param expectedProductId 期望商品 ID
   */
  async function probeAndAdvance(tabId: number, expectedProductId: string): Promise<void> {
    try {
      const probe = await sendMsg('tiktok.probe', { expectedProductId }, tabId);
      const cp = await loadCheckpoint();
      if (probe.state === 'READY') {
        if (currentSm && currentSm.status === 'NAVIGATING') {
          transition(currentSm, 'PAGE_READY', probe.evidence);
        }
        await saveCheckpoint({ ...cp, runner_stage: 'PAGE_READY', last_probe_evidence: probe.evidence });
        await advanceRunner('page-ready');
      } else if (probe.state === 'CHALLENGE' || probe.state === 'ACCESS_RESTRICTED') {
        if (currentSm && currentSm.status === 'NAVIGATING') {
          transition(currentSm, 'WAITING_VERIFICATION', probe.evidence);
        }
        await saveCheckpoint({
          ...cp,
          runner_stage: 'WAITING_VERIFICATION',
          // 记录命中规则，便于从本地存储直接诊断误判
          last_probe_evidence: `${probe.state}: ${probe.evidence ?? ''}`,
        });
        await notifyUser('TikTok 验证/访问限制', '请在 TikTok 工作页完成人工验证，扩展将自动恢复。');
        await broadcastState();
      } else if (probe.state === 'MISMATCH') {
        await finishTask('FAILED', { evidence: probe.reason ?? '商品 ID 不匹配', error_code: ERROR_CODES.TIKTOK_PRODUCT_MISMATCH });
      } else if (probe.state === 'REGION_UNAVAILABLE') {
        await stopForRegionUnavailable(probe.evidence);
      }
      // LOADING：等待 content script 的 pageReady/challenge 事件推进
    } catch (e) {
      // content script 尚未注入：等 tabs.onUpdated/reconcile 兜底
      await dlog('background', 'TikTok 页面探测失败', {
        productId: expectedProductId,
        tabId,
        error: (e as Error)?.message ?? String(e),
      });
    }
  }

  /**
   * 完成任务：上报结果（幂等 attempt_id）→ 清理 checkpoint → 计划下一件
   * @param result 终态结果
   * @param extra 证据与错误码
   */
  async function finishTask(
    result: 'SUCCESS' | 'FAILED' | 'UNKNOWN' | 'SKIPPED',
    extra: { evidence?: string; error_code?: string },
  ): Promise<void> {
    const cp = await loadCheckpoint();
    if (!cp.active_task_id || !cp.attempt_id) return;
    const payload = {
      attempt_id: cp.attempt_id,
      lease_token: cp.lease_token ?? '',
      result,
      // 服务端字段名为 evidence（此前误用 evidence_json，导致证据被忽略、库里只剩 {}）
      evidence: {
        message: extra.evidence ?? '',
        stage: cp.runner_stage ?? '',
      },
      error_code: extra.error_code,
      elapsed_ms: 0,
    };
    // 结果上报失败时写入 outbox，绝不丢弃（规范 §9：结果未送达不领取下一件）
    try {
      await getApi().taskResult(cp.active_task_id, payload);
    } catch (e) {
      await outboxEnqueue({
        event_id: crypto.randomUUID(),
        kind: 'task_result',
        priority: 0,
        payload: { task_id: cp.active_task_id, ...payload },
        created_at: new Date().toISOString(),
        retries: 0,
        status: 'pending',
      });
      if (e instanceof ApiError && e.retryable) {
        // 网络类失败：不领取下一件，等待 outbox 补传成功
        await saveCheckpoint({ ...cp, runner_stage: 'IDLE', active_task_id: null, paused: true });
        await notifyUser('远程同步中断', '结果上报失败已缓存，恢复后自动补传；批次已暂停。');
        return;
      }
    }
    currentSm = null;
    await saveCheckpoint({ ...cp, runner_stage: 'IDLE', active_task_id: null, attempt_id: null, lease_token: null, product: null });
    // 任务间隔从下一件开始前计时（规范 §5.4）；读取设置页执行参数
    const ec = await storageGet('exec_config');
    const minMs = Math.max(1, ec.interval_min_sec) * 1000;
    const maxMs = Math.max(minMs, ec.interval_max_sec * 1000);
    const interval = minMs + Math.random() * (maxMs - minMs);
    const nextRunAt = new Date(Date.now() + interval).toISOString();
    await saveCheckpoint({ ...(await loadCheckpoint()), next_run_at: nextRunAt });
    await browser.alarms.create('runner-next', { when: Date.now() + interval });
  }

  /**
   * 商品在当前国家/地区不可用：暂停批次并终结当前任务
   * 之所以暂停而不是直接取消，是为了让用户确认站点/地区后可继续或手动停止
   * @param evidence 页面提示证据
   */
  async function stopForRegionUnavailable(evidence?: string): Promise<void> {
    const cp = await loadCheckpoint();
    if (!cp.active_batch_id) return;
    if (cp.paused && !cp.active_task_id) return;
    // 先本地暂停，确保后续 tick 不会再领取任务
    await saveCheckpoint({ ...(await loadCheckpoint()), paused: true });
    await getApi().batchAction(cp.active_batch_id, 'pause', {}).catch(() => undefined);
    const cur = await loadCheckpoint();
    if (cur.active_task_id && cur.attempt_id) {
      await finishTask('FAILED', {
        evidence: (evidence ?? '商品在当前国家/地区不可用').slice(0, 200),
        error_code: ERROR_CODES.PRODUCT_REGION_UNAVAILABLE,
      }).catch(() => undefined);
    }
    await notifyUser(
      '商品在当前地区不可用',
      'TikTok 提示该商品未在此国家/地区提供，已自动暂停批次；请确认榜单站点后继续或停止。',
    );
    await broadcastState();
  }

  /**
   * 计划领取下一件任务（由 alarm/checkpoint 到期触发）
   * @param batchId 批次 ID
   */
  async function scheduleClaimNext(batchId: string): Promise<void> {
    await saveCheckpoint({ ...(await loadCheckpoint()), next_run_at: null });
    await claimAndStart(batchId);
  }

  /**
   * runner-next alarm 触发：到达任务间隔后领取下一件
   */
  async function handleRunnerNextAlarm(): Promise<void> {
    const cp = await loadCheckpoint();
    if (!cp.active_batch_id || cp.paused) return;
    if (cp.active_task_id) return; // 有进行中任务，由 reconcile 处理
    await claimAndStart(cp.active_batch_id);
  }

  /**
   * 领取下一件任务并进入导航阶段；无任务则检查批次终态
   * @param batchId 批次 ID
   */
  async function claimAndStart(batchId: string): Promise<void> {
    const identity = await loadClientIdentity();
    if (!identity.client_id) return;
    const cp = await loadCheckpoint();
    if (cp.paused) return;
    // 先确认 outbox 无未送达结果（规范 §9）
    const pending = await outboxPending();
    if (pending.some((e) => e.kind === 'task_result')) return;

    const task = await getApi().claimTask(batchId, identity.client_id, crypto.randomUUID());
    if (!task) {
      // 无可领取任务：查询批次是否到达终态
      const batch = await getApi().getBatch(batchId).catch(() => null);
      if (batch && ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED'].includes(batch.status)) {
        await saveCheckpoint({
          ...(await loadCheckpoint()),
          active_batch_id: null,
          runner_stage: 'IDLE',
          paused: false,
        });
        await notifyUser('批次完成', `批次 ${batchId.slice(0, 8)} 已到达终态 ${batch.status}`);
      }
      return;
    }
    await saveCheckpoint({
      ...cp,
      active_task_id: task.task_id,
      attempt_id: task.attempt_id,
      lease_token: task.lease_token,
      runner_stage: 'LEASED',
      product: {
        external_product_id: task.product.external_product_id,
        region: task.product.region,
        detail_url: task.product.detail_url,
      },
    });
    currentSm = createTaskStateMachine(task.task_id, task.attempt_id, 'LEASED');
    await advanceRunner('claimed');
  }

  // ---------------- 周期 tick：reconcile + outbox 同步 + 心跳 ----------------

  /**
   * 周期任务：outbox 补传（优先级：结果>进度>榜单）→ reconcile → 心跳
   */
  async function handleTick(): Promise<void> {
    const authToken = await storageGet('auth_token');
    if (!authToken) return; // 未授权：不轮询、不执行任何远程操作
    const identity = await loadClientIdentity();
    if (!identity.client_id) {
      await refreshAuthIdentity().catch(() => null);
      if (!(await storageGet('client_id'))) return; // token 无效：等待设置页修正
    }
    await syncOutbox();
    await reconcile('alarm');
    await getApi()
      .heartbeat({
        browser_state: 'alive',
        active_batch_id: (await loadCheckpoint()).active_batch_id,
        active_task_id: (await loadCheckpoint()).active_task_id,
        extension_version: EXT_VERSION,
      })
      .catch(() => undefined);
  }

  /**
   * outbox 幂等补传：成功（服务端幂等接受）后删除
   */
  async function syncOutbox(): Promise<void> {
    const pending = await outboxPending();
    for (const ev of pending.slice(0, 20)) {
      try {
        if (ev.kind === 'task_result') {
          const { task_id, ...payload } = ev.payload as { task_id: string } & Record<string, unknown>;
          await getApi().taskResult(task_id, payload as never);
        } else if (ev.kind === 'task_event') {
          const { task_id, ...payload } = ev.payload as { task_id: string } & Record<string, unknown>;
          await getApi().taskEvent(task_id, payload as never);
        }
        await outboxAck(ev.event_id);
      } catch (e) {
        if (e instanceof ApiError && !e.retryable) {
          // 非重试错误（如幂等冲突说明服务端已收到）：确认删除
          await outboxAck(ev.event_id);
        }
        // retryable 错误保留下个 tick
      }
    }
  }

  // ---------------- 榜单抓取 ----------------

  let rankingProgress = { running: false, fetched: 0, limit: 0, page: 0, done: false, reason: '' };
  let rankingCancelled = false;
  let presetBatchProgress = { running: false, current: 0, total: 0, completed: 0, failed: 0 };

  /**
   * 执行榜单抓取：EchoTik 分页 → 远程快照（部分上传失败保留 PARTIAL）
   * @param query 查询条件
   */
  async function runRankingCollect(query: RankingQuery): Promise<void> {
    rankingCancelled = false;
    rankingProgress = { running: true, fetched: 0, limit: query.limit, page: 0, done: false, reason: '' };
    const source = resolveSource(query);
    const adapter = createRankingAdapter(source, createRankingTransports());
    const identity = await loadClientIdentity();
    if (!identity.client_id) throw new Error(ERROR_CODES.NOT_REGISTERED);
    const pageSelection = await adapter.readCurrentPageSelection(0);
    if (!pageSelection.region) {
      throw Object.assign(
        new Error('未能从当前页面顶部国家/站点选择器读取站点，请先在来源页面选择国家后重试'),
        { code: ERROR_CODES.RANKING_SOURCE_BAD_RESPONSE },
      );
    }
    // 平台页面顶部的国家选择器是唯一真值，不允许面板或预设的旧站点覆盖它。
    query = { ...query, region: pageSelection.region };

    // FastMoss 容易在密集接口调用前触发滑块。每次采集先刷新榜单页并等待
    // 人工验证完成，再创建快照、请求 API，避免产生 0 条 FAILED 快照。
    if (source === 'FASTMOSS') {
      const ready = await refreshFastMossAndAwaitVerification();
      if (!ready) return;
    }

    const snapshot = await getApi().createSnapshot({
      query,
      filter_json: query as unknown as Record<string, unknown>,
      request_id: crypto.randomUUID(),
    });
    let entries: ProductRankingEntry[] = [];
    let reason = 'UNKNOWN';
    let total: number | undefined;
    let uploaded = 0;
    let uploadFailed = false;
    try {
      const result = await adapter.fetchAllRankings(
        query,
        (fetched, page) => {
          rankingProgress = { ...rankingProgress, fetched, page };
          void broadcastState();
        },
        () => rankingCancelled,
      );
      entries = result.entries;
      reason = result.reason;
      total = result.total;
      // 分批上传（每批 50 条）；必须先转换为服务端 EntryItem 结构
      for (let i = 0; i < entries.length; i += 50) {
        const chunk = entries.slice(i, i + 50).map(toRemoteEntry);
        try {
          await getApi().upsertSnapshotEntries(snapshot.snapshot_id, chunk, crypto.randomUUID());
          uploaded += chunk.length;
        } catch {
          uploadFailed = true;
          break;
        }
      }
    } catch (e) {
      // 快照已创建：后续抓取/上传异常时标记 FAILED，避免历史快照长期停留在 CAPTURING
      await getApi().finishSnapshot(snapshot.snapshot_id, 'FAILED', 0).catch(() => undefined);
      throw e;
    }
    const finalStatus = reason.startsWith('FAILED_')
      ? 'FAILED'
      : uploadFailed || reason === 'CANCELLED' || reason === 'PERMISSION_LIMIT' || reason === 'WAITING_VERIFICATION'
        ? 'PARTIAL'
        : 'COMPLETED';
    await getApi().finishSnapshot(snapshot.snapshot_id, finalStatus, uploaded).catch(() => undefined);
    rankingProgress = { ...rankingProgress, running: false, done: true, reason: uploadFailed ? 'UPLOAD_PARTIAL' : reason, fetched: entries.length };
    await broadcastState();
    void total;
  }

  /**
   * 将归一化榜单条目转换为服务端 entries:upsert 的 EntryItem 结构
   * 服务端 sales/gmv 是数值字段（int/float），而本地归一化结构为 { value, raw }；
   * 直接上传对象会被服务端 422 拒绝，导致快照无明细、批次无法创建。
   * @param e 归一化条目
   */
  function toRemoteEntry(e: ProductRankingEntry): Record<string, unknown> {
    const salesValue = e.sales?.value;
    return {
      external_product_id: e.external_product_id,
      // 不传 platform，使用服务端默认值 tiktok（避免大小写不一致产生重复商品）
      region: e.region,
      title: e.title || null,
      shop_id: e.shop?.id ?? null,
      shop_name: e.shop?.name ?? null,
      image_url: e.image_url ?? null,
      // 非 US 站点可能没有可用的详情模板，留空由服务端保留历史值
      detail_url: e.detail_url ?? null,
      rank_position: e.rank_position,
      // 销量字段服务端要求整数
      sales: typeof salesValue === 'number' ? Math.round(salesValue) : null,
      gmv: e.gmv?.value ?? null,
      metrics_json: e.metrics ?? null,
      raw_excerpt: {
        category: e.category ?? null,
        sales_raw: e.sales?.raw ?? null,
        gmv_raw: e.gmv?.raw ?? null,
      },
    };
  }

  /**
   * 判断缓存的类目树是否为英文（老版本缓存需刷新为中文）
   * @param items 类目树
   */
  function isEnglishCategoryTree(items: CategoryNode[]): boolean {
    const sample = (items.find((i) => i.value)?.label ?? '').trim();
    return /[A-Za-z]/.test(sample);
  }

  /**
   * 单件商品直接采集：解析服务端商品 → 创建单商品批次（强制重抓）→ 启动并领取首件
   * 用于在「商品列表」页快速验证 TikTok 详情页 + 妙手 ERP 采集链路
   * @param externalProductId TikTok 商品 ID
   * @param region 站点（配合外部 ID 精确定位服务端商品）
   */
  async function collectSingleProduct(
    externalProductId: string,
    region: string,
  ): Promise<{ batch_id: string; closed_batch_ids?: string[] }> {
    const cp = await loadCheckpoint();
    if (cp.active_task_id) {
      throw new Error('当前有任务正在执行，请先完成或暂停后再采集');
    }
    const api = getApi();
    // 单客户端只允许一个活跃批次：上次异常退出（SW 重启/页面停滞）会留下僵尸 RUNNING 批次，
    // 直接阻塞新批次创建，这里先结束它再继续，并把被结束的批次回传给界面；
    // PAUSED 属于用户主动暂停，不自动结束，改为明确提示
    const closed: string[] = [];
    const running = await api.listBatches({ status: 'RUNNING', per_page: 100 });
    for (const b of running.items) {
      await api.batchAction(b.batch_id, 'cancel', { client_id: await storageGet('client_id') });
      closed.push(b.batch_id);
    }
    const paused = await api.listBatches({ status: 'PAUSED', per_page: 100 });
    if (paused.items.length > 0) {
      throw new Error(
        `存在已暂停的批次 ${paused.items[0]!.batch_id}，请先在「任务」页停止后再采集`,
      );
    }
    if (closed.length > 0) {
      // 清掉旧检查点，避免残留的 task/lease 让新批次无法推进
      await saveCheckpoint({
        ...(await loadCheckpoint()),
        active_batch_id: null,
        active_task_id: null,
        runner_stage: 'IDLE',
        paused: false,
      });
    }
    // 本地商品记录只有外部 ID，需先从服务端商品表解析内部 product_id
    const found = await api.listProducts({ keyword: externalProductId, region, per_page: 20 });
    const hit = found.items.find((p) => p.external_product_id === externalProductId);
    if (!hit) {
      throw new Error('该商品尚未同步到服务端（榜单明细未上传），请先重新采集榜单后再试');
    }
    const ec = await storageGet('exec_config');
    const batch = await api.createBatch({
      product_ids: [hit.id],
      interval_seconds: { min: ec.interval_min_sec, max: ec.interval_max_sec },
      idempotency_key: crypto.randomUUID(),
      // 手动测试需要真正执行一次，跳过去重
      recollect: true,
    });
    await dlog('background', '单商品采集：已创建 ERP 批次', {
      batchId: batch.batch_id,
      productId: externalProductId,
    });
    await api.batchAction(batch.batch_id, 'start', { client_id: await storageGet('client_id') });
    await saveCheckpoint({
      ...(await loadCheckpoint()),
      active_batch_id: batch.batch_id,
      paused: false,
      runner_stage: 'IDLE',
    });
    await dlog('background', '单商品采集：开始领取任务', { batchId: batch.batch_id, productId: externalProductId });
    await claimAndStart(batch.batch_id);
    await broadcastState();
    return { batch_id: batch.batch_id, closed_batch_ids: closed.length ? closed : undefined };
  }

  /**
   * 判断错误是否为「content script 失联」（扩展重载或页面未注入脚本时出现）
   * @param e 异常
   */
  function isMissingReceiver(e: unknown): boolean {
    const msg = String((e as Error)?.message ?? e);
    return msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection');
  }

  /**
   * 等待标签页加载完成（轮询 status）
   * @param tabId 标签页 ID
   * @param timeoutMs 超时（毫秒）
   */
  async function waitTabLoaded(tabId: number, timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const t = await browser.tabs.get(tabId);
      if (t.status === 'complete') {
        // 页面 complete 后给 content script 一点注册时间
        await new Promise((r) => setTimeout(r, 400));
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /**
   * 向 EchoTik 标签页发送请求；content script 失联时自动刷新页面后重试一次
   * @param tabId 标签页 ID
   * @param payload 请求负载
   */
  async function sendToEchoTikTab(
    tabId: number,
    payload: { path: string; params: Record<string, string | number>; lang?: 'zh-CN' | 'en' },
  ): Promise<unknown> {
    try {
      return await sendMsg('echotik.fetchApi', payload, tabId);
    } catch (e) {
      if (!isMissingReceiver(e)) throw e;
      // 扩展刚重载时旧页面的 content script 已失效：刷新后轮询等待脚本就绪再重试
      await browser.tabs.reload(tabId);
      await waitTabLoaded(tabId);
      let lastError: unknown = e;
      for (let i = 0; i < 6; i++) {
        try {
          return await sendMsg('echotik.fetchApi', payload, tabId);
        } catch (err) {
          lastError = err;
          if (!isMissingReceiver(err)) throw err;
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      throw lastError;
    }
  }

  /**
   * 查找可用的 EchoTik 标签页
   * 登录 Cookie（echotik_session/token）是 host-only，仅挂在 echotik.live 主域；
   * www 等子域不携带登录态，命中后接口会按 Visitor 权限返回 HTML 拦截页，
   * 因此优先选主域页面，其次优先榜单页（/board、/products）。
   */
  async function findEchoTikTab(): Promise<{ id?: number; url?: string } | null> {
    const tabs = await browser.tabs.query({
      url: ['https://echotik.live/*', 'https://*.echotik.live/*'],
    });
    const candidates = tabs.filter((t) => t.id != null);
    /** 打分：主域 +10；榜单/商品页 +5 */
    const score = (t: { url?: string }): number => {
      const u = t.url ?? '';
      let s = 0;
      if (/^https:\/\/echotik\.live(\/|$)/.test(u)) s += 10;
      if (/\/(board|products)([/?#]|$)/.test(u)) s += 5;
      return s;
    };
    candidates.sort((a, b) => score(b) - score(a));
    return candidates[0] ?? null;
  }

  /**
   * 创建 EchoTik 传输层：定位 echotik.live Tab 并桥接 content script 发同源请求
   */
  function createEchoTikTransport(): EchoTikTransport {
    return {
      async request(path, params, lang) {
        const tab = await findEchoTikTab();
        if (!tab?.id) {
          throw Object.assign(new Error('未找到 EchoTik 页面，请先打开 https://echotik.live/board'), {
            code: ERROR_CODES.ECHOTIK_NETWORK,
          });
        }
        if (!/^https:\/\/echotik\.live(\/|$)/.test(tab.url ?? '')) {
          throw Object.assign(
            new Error('当前 EchoTik 页面在 www 等子域，没有登录态；请打开 https://echotik.live/board 后重试'),
            { code: ERROR_CODES.ECHOTIK_NETWORK },
          );
        }
        return sendToEchoTikTab(tab.id, { path, params, lang });
      },
      async readPageSelection() {
        return readRankingPageSelection('ECHOTIK').catch(() => ({}) as Partial<RankingQuery>);
      },
    };
  }

  /**
   * 创建 FastMoss 传输层：定位 fastmoss.com Tab 并桥接 content script
   */
  function createFastMossTransport(): FastMossTransport {
    return {
      async request(payload) {
        const tab = await findRankingTab('FASTMOSS');
        if (!tab?.id) {
          throw Object.assign(new Error('未找到 FastMoss 页面，请先打开 https://www.fastmoss.com/e-commerce/saleslist'), {
            code: ERROR_CODES.RANKING_SOURCE_OFFLINE,
          });
        }
        return sendToFastMossTab(tab.id, payload);
      },
      async readCapturedCalls() {
        const tab = await findRankingTab('FASTMOSS');
        if (!tab?.id) return [] as CapturedApiCall[];
        return sendMsg('fastmoss.readCapturedCalls', undefined, tab.id)
          .then((r) => r.calls as CapturedApiCall[])
          .catch(() => [] as CapturedApiCall[]);
      },
      async readPageSelection() {
        return readRankingPageSelection('FASTMOSS').catch(() => ({}) as Partial<RankingQuery>);
      },
      async checkChallenge() {
        const tab = await findRankingTab('FASTMOSS');
        if (!tab?.id) {
          throw Object.assign(new Error('未找到 FastMoss 页面，无法检查滑块验证'), {
            code: ERROR_CODES.RANKING_SOURCE_OFFLINE,
          });
        }
        return sendMsg('fastmoss.checkChallenge', undefined, tab.id);
      },
    };
  }

  /**
   * 组装各来源平台传输层（注册表按 source 取用）
   */
  function createRankingTransports(): RankingTransports {
    return { echotik: createEchoTikTransport(), fastmoss: createFastMossTransport() };
  }

  const FASTMOSS_SETTLE_MS = 2_000;
  const FASTMOSS_VERIFICATION_WAIT_MS = 5 * 60_000;

  /**
   * 刷新 FastMoss 榜单页，等待可能出现的滑块验证被用户完成。
   * 仅轮询页面状态，不模拟或绕过验证；超时后保留“等待验证”状态供用户重试。
   */
  async function refreshFastMossAndAwaitVerification(): Promise<boolean> {
    const tab = await findRankingTab('FASTMOSS');
    if (!tab?.id) {
      throw Object.assign(new Error('未找到 FastMoss 榜单页，请先打开后再采集'), {
        code: ERROR_CODES.RANKING_SOURCE_OFFLINE,
      });
    }
    rankingProgress = { ...rankingProgress, reason: 'REFRESHING_FASTMOSS' };
    await broadcastState();
    await browser.tabs.reload(tab.id);
    await waitTabLoaded(tab.id, 30_000);

    const startedAt = Date.now();
    let clearSince: number | null = null;
    while (Date.now() - startedAt < FASTMOSS_VERIFICATION_WAIT_MS) {
      let state: 'CLEAR' | 'CHALLENGE' | 'ACCESS_RESTRICTED';
      try {
        state = (await sendMsg('fastmoss.checkChallenge', undefined, tab.id)).state;
      } catch (e) {
        if (!isMissingReceiver(e)) throw e;
        await new Promise((resolve) => setTimeout(resolve, 600));
        continue;
      }
      if (state === 'CLEAR') {
        // 要连续保持一段时间无验证，避免刷新或刚通过滑块后立即发 API 又触发挑战。
        clearSince ??= Date.now();
        if (Date.now() - clearSince < FASTMOSS_SETTLE_MS) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        rankingProgress = { ...rankingProgress, reason: '' };
        await broadcastState();
        return true;
      }
      clearSince = null;
      rankingProgress = { ...rankingProgress, reason: 'WAITING_VERIFICATION' };
      await broadcastState();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    rankingProgress = {
      ...rankingProgress,
      running: false,
      done: true,
      reason: 'WAITING_VERIFICATION',
    };
    await broadcastState();
    return false;
  }

  /**
   * 向 FastMoss 页面发送消息；content script 未就绪时刷新页面后重试
   * @param tabId 标签页
   * @param payload 请求体
   */
  async function sendToFastMossTab(
    tabId: number,
    payload: { path: string; params?: Record<string, string | number>; method?: 'GET' | 'POST'; body?: unknown },
  ): Promise<unknown> {
    try {
      return await sendMsg('fastmoss.fetchApi', payload, tabId);
    } catch (e) {
      if (!isMissingReceiver(e)) throw e;
      await browser.tabs.reload(tabId);
      await waitTabLoaded(tabId);
      let lastError: unknown = e;
      for (let i = 0; i < 6; i++) {
        try {
          return await sendMsg('fastmoss.fetchApi', payload, tabId);
        } catch (err) {
          lastError = err;
          if (!isMissingReceiver(err)) throw err;
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      throw lastError;
    }
  }

  /**
   * 读取来源页面筛选。扩展重载后，已打开标签页可能尚未注入 content script；
   * 此处统一刷新、等待并重试，避免面板直连标签页时暴露“Receiving end”错误。
   */
  async function readRankingPageSelection(source: RankingSource): Promise<Partial<RankingQuery>> {
    const tab = source === 'ECHOTIK' ? await findEchoTikTab() : await findRankingTab(source);
    if (!tab?.id) {
      const meta = sourceMeta(source);
      throw Object.assign(new Error(`未找到 ${meta.label} 页面，请先打开 ${meta.boardUrl}`), {
        code: ERROR_CODES.RANKING_SOURCE_OFFLINE,
      });
    }
    const read = () => source === 'ECHOTIK'
      ? sendMsg('echotik.readPageSelection', undefined, tab.id!)
      : sendMsg('fastmoss.readPageSelection', undefined, tab.id!);
    try {
      return await read();
    } catch (e) {
      if (!isMissingReceiver(e)) throw e;
      await browser.tabs.reload(tab.id);
      await waitTabLoaded(tab.id);
      let lastError: unknown = e;
      for (let i = 0; i < 6; i++) {
        try {
          return await read();
        } catch (err) {
          lastError = err;
          if (!isMissingReceiver(err)) throw err;
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
      }
      throw lastError;
    }
  }

  /**
   * 查找指定来源平台的标签页（元信息来自 modules/ranking/sources.ts）
   * 打分：主域 +10，榜单页 +5，保证优先选到带登录态、且已经加载榜单数据的页面
   * @param source 来源平台
   */
  async function findRankingTab(source: RankingSource): Promise<{ id?: number; url?: string } | null> {
    const meta = sourceMeta(source);
    const tabs = await browser.tabs.query({ url: meta.tabUrlPatterns });
    const candidates = tabs.filter((t) => t.id != null);
    const score = (t: { url?: string }): number => {
      const u = t.url ?? '';
      let s = 0;
      if (u.startsWith(meta.origin)) s += 10;
      // 榜单/商品列表路径（EchoTik: board/products；FastMoss: saleslist/hotlist/newProducts/search）
      if (/\/(board|rank|ranking|products|saleslist|hotlist|newProducts|search)([/?#]|$)/i.test(u)) s += 5;
      return s;
    };
    candidates.sort((a, b) => score(b) - score(a));
    return candidates[0] ?? null;
  }

  // ---------------- 消息路由 ----------------

  /**
   * 路由 runtime.onMessage 消息到对应处理器
   * @param msg 消息信封
   * @param sender 发送者
   */
  async function routeMessage(
    msg: { type?: string; payload?: unknown },
    sender: unknown,
  ): Promise<unknown> {
    const type = msg.type as keyof MessageMap | undefined;
    if (!type) return { ok: false, error: { code: 'BAD_MESSAGE', message: '缺少消息类型' } };
    // 各 handler 由 wrapHandler<'消息类型'> 提供类型化 payload；路由表统一为弱类型签名
    const handlers: Partial<
      Record<keyof MessageMap, (payload: never, sender: unknown) => Promise<unknown>>
    > = {
      ping: wrapHandler<'ping'>(async () => ({ pong: true as const, ts: new Date().toISOString() })),
      'client.getState': wrapHandler<'client.getState'>(async () => buildPublicState()),
      // ---- 认证 Token（插件设置填写，Bearer 认证）----
      'auth.me': wrapHandler<'auth.me'>(async () => {
        const token = await storageGet('auth_token');
        if (!token) throw new ApiError(ERROR_CODES.SERVER_UNAUTHORIZED, '请先完成激活认证');
        return fetchAuthIdentity();
      }),
      'auth.setToken': wrapHandler<'auth.setToken'>(async (payload) => {
        const token = (payload?.token ?? '').trim();
        if (!token) throw new Error('认证 Token 不能为空');
        await storageSet('auth_token', token);
        await clearClientBinding();
        try {
          const me = await fetchAuthIdentity();
          await broadcastState();
          return me;
        } catch (e) {
          // 无效 token 不保留，避免界面处于无法自证的授权态
          await storageSet('auth_token', null);
          await broadcastState();
          throw e;
        }
      }),
      'auth.clear': wrapHandler<'auth.clear'>(async () => {
        await storageSet('auth_token', null);
        await clearClientBinding();
        await broadcastState();
        return { ok: true as const };
      }),
      'client.testConnection': wrapHandler<'client.testConnection'>(async () => {
        const t0 = Date.now();
        await getApi().me();
        return { connected: true, latency_ms: Date.now() - t0 };
      }),
      'client.updateServerUrl': wrapHandler<'client.updateServerUrl'>(async (payload) => {
        // 兼容旧消息调用，但不允许覆写内置的生产服务地址。
        void payload;
        await storageSet('server_url', FIXED_SERVER_URL);
        return { saved: true as const };
      }),
      'plugin.checkUpdate': wrapHandler<'plugin.checkUpdate'>(async () => {
        const update = await getApi().pluginUpdate();
        return { ...update, update_available: isVersionNewer(update.version, EXT_VERSION) };
      }),
      'runner.start': wrapHandler<'runner.start'>(async (payload) => {
        await getApi().batchAction(payload.batchId, 'start', { client_id: await storageGet('client_id') });
        await saveCheckpoint({ ...(await loadCheckpoint()), active_batch_id: payload.batchId, paused: false, runner_stage: 'IDLE' });
        await claimAndStart(payload.batchId);
        return { started: true as const };
      }),
      'runner.pause': wrapHandler<'runner.pause'>(async () => {
        const cp = await loadCheckpoint();
        if (cp.active_batch_id) await getApi().batchAction(cp.active_batch_id, 'pause', {}).catch(() => undefined);
        await saveCheckpoint({ ...cp, paused: true });
        return { paused: true as const };
      }),
      'runner.resume': wrapHandler<'runner.resume'>(async () => {
        const cp = await loadCheckpoint();
        if (cp.active_batch_id) await getApi().batchAction(cp.active_batch_id, 'resume', {}).catch(() => undefined);
        await saveCheckpoint({ ...cp, paused: false });
        await reconcile('resume');
        return { resumed: true as const };
      }),
      'runner.cancel': wrapHandler<'runner.cancel'>(async () => {
        const cp = await loadCheckpoint();
        if (cp.active_batch_id) await getApi().batchAction(cp.active_batch_id, 'cancel', {}).catch(() => undefined);
        await saveCheckpoint({ ...cp, active_batch_id: null, active_task_id: null, runner_stage: 'IDLE', paused: false });
        currentSm = null;
        return { cancelled: true as const };
      }),
      'runner.getCheckpoint': wrapHandler<'runner.getCheckpoint'>(async () => loadCheckpoint()),
      'ranking.startCollect': wrapHandler<'ranking.startCollect'>(async (payload) => {
        void runRankingCollect(payload.query).catch((e) => {
          rankingProgress = { ...rankingProgress, running: false, done: true, reason: (e as Error).message };
        });
        return { snapshot_local_id: crypto.randomUUID() };
      }),
      'ranking.runPresetBatch': wrapHandler<'ranking.runPresetBatch'>(async (payload) => {
        if (presetBatchProgress.running || rankingProgress.running) throw new Error('已有榜单采集正在执行');
        if (!payload.queries.length) throw new Error('请至少选择一个筛选预设');
        presetBatchProgress = { running: true, current: 0, total: payload.queries.length, completed: 0, failed: 0 };
        void (async () => {
          for (let i = 0; i < payload.queries.length; i++) {
            presetBatchProgress = { ...presetBatchProgress, current: i + 1 };
            try {
              await runRankingCollect(withYesterdayForDailyPreset(payload.queries[i]!));
              presetBatchProgress = { ...presetBatchProgress, completed: presetBatchProgress.completed + 1 };
            } catch {
              presetBatchProgress = { ...presetBatchProgress, failed: presetBatchProgress.failed + 1 };
            }
          }
          presetBatchProgress = { ...presetBatchProgress, running: false };
        })();
        return { started: payload.queries.length };
      }),
      'ranking.presetBatchProgress': wrapHandler<'ranking.presetBatchProgress'>(async () => presetBatchProgress),
      'rankingPreset.list': wrapHandler<'rankingPreset.list'>(async (payload) => getApi().listRankingPresets(payload.source)),
      'rankingPreset.save': wrapHandler<'rankingPreset.save'>(async (payload) => getApi().saveRankingPreset(payload.name, payload.source, payload.query as unknown as Record<string, unknown>)),
      'rankingPreset.delete': wrapHandler<'rankingPreset.delete'>(async (payload) => getApi().deleteRankingPreset(payload.preset_id)),
      'ranking.getProgress': wrapHandler<'ranking.getProgress'>(async () => rankingProgress),
      'ranking.cancelCollect': wrapHandler<'ranking.cancelCollect'>(async () => {
        rankingCancelled = true;
        return { cancelled: true as const };
      }),
      'ranking.readPageSelection': wrapHandler<'ranking.readPageSelection'>(async (payload) =>
        readRankingPageSelection(payload.source)),
      'ranking.preview': wrapHandler<'ranking.preview'>(async (payload) => {
        // 预览：只抓首页并归一化，不创建远程快照（规范 §3.3 预览不持久化）
        const source = resolveSource(payload.query);
        const adapter = createRankingAdapter(source, createRankingTransports());
        const pageSelection = await adapter.readCurrentPageSelection(0);
        if (!pageSelection.region) {
          throw Object.assign(
            new Error('未能从当前页面顶部国家/站点选择器读取站点，请先在来源页面选择国家后重试'),
            { code: ERROR_CODES.RANKING_SOURCE_BAD_RESPONSE },
          );
        }
        const query = { ...payload.query, region: pageSelection.region };
        const page = await adapter.fetchRankingPage(query, undefined, 1);
        const startRank = Math.max(1, query.startRank || 1);
        const items = page.records
          .map((raw, i) => {
            try {
              return adapter.normalize(raw, query, startRank + i);
            } catch {
              return null; // 非法条目跳过（规范 §4.3）
            }
          })
          .filter((e): e is NonNullable<typeof e> => e != null);
        return { items, total: page.total, hasMore: page.hasMore };
      }),
      // ---- 数据查询类：薄透传远程 REST（类型与错误由 api client 包装） ----
      'snapshot.list': wrapHandler<'snapshot.list'>(async (payload) => getApi().listSnapshots(payload ?? {})),
      'snapshot.createFromCurrent': wrapHandler<'snapshot.createFromCurrent'>(async (payload) => {
        // 按来源平台定位页面 → 读取页面筛选 → 合并覆盖项 → 复用榜单抓取流程
        const source: RankingSource = payload?.source ?? payload?.overrides?.source ?? 'ECHOTIK';
        const tab = await findRankingTab(source);
        if (!tab?.id) {
          const meta = sourceMeta(source);
          throw Object.assign(new Error(`未找到 ${meta.label} 页面，请先打开 ${meta.boardUrl}`), {
            code: ERROR_CODES.RANKING_SOURCE_OFFLINE,
          });
        }
        const selection =
          source === 'FASTMOSS'
            ? await sendMsg('fastmoss.readPageSelection', undefined, tab.id).catch(() => ({}) as Partial<RankingQuery>)
            : await sendMsg('echotik.readPageSelection', undefined, tab.id).catch(() => ({}) as Partial<RankingQuery>);
        if (!selection.region) {
          throw Object.assign(
            new Error('未能从当前页面顶部国家/站点选择器读取站点，请先在来源页面选择国家后重试'),
            { code: ERROR_CODES.RANKING_SOURCE_BAD_RESPONSE },
          );
        }
        const query: RankingQuery = {
          source,
          region: 'MX',
          rankingType: 'daily',
          rankingVariant: 'top-sold',
          startRank: 1,
          limit: 100,
          // 渠道默认分页：EchoTik 20 条/页 × 最多 5 页；FastMoss 10 条/页 × 最多 10 页
          perPage: source === 'FASTMOSS' ? 10 : 20,
          maxPages: source === 'FASTMOSS' ? 10 : 5,
          ...selection,
          ...(payload?.overrides ?? {}),
        } as RankingQuery;
        // 覆盖项不得改写页面顶部当前站点。
        query.region = selection.region;
        void runRankingCollect(query).catch((e) => {
          rankingProgress = { ...rankingProgress, running: false, done: true, reason: (e as Error).message };
        });
        return { started: true as const };
      }),
      'ranking.sources': wrapHandler<'ranking.sources'>(async () => ({
        items: Object.values(RANKING_SOURCE_META).map((m) => ({
          id: m.id,
          label: m.label,
          origin: m.origin,
          boardUrl: m.boardUrl,
          available: m.available,
          unavailableReason: m.unavailableReason,
        })),
      })),
      'echotik.getCategories': wrapHandler<'echotik.getCategories'>(async (payload) => {
        // 策略：缓存长期有效（命中即用，避免每次请求大体积类目树）；force 才强制刷新
        // 英文旧缓存会自动尝试刷新为中文；刷新失败时回退到旧缓存，保证分类始终可用
        const cache = await storageGet('category_cache');
        if (cache && !payload?.force && !isEnglishCategoryTree(cache.items)) {
          return { items: cache.items, cached: true, fetched_at: cache.fetched_at };
        }
        try {
          const adapter = createEchoTikAdapter(createEchoTikTransport());
          const items = await adapter.fetchCategories();
          const fetched_at = new Date().toISOString();
          await storageSet('category_cache', { items, fetched_at });
          return { items, cached: false, fetched_at };
        } catch (e) {
          if (cache?.items?.length) {
            return { items: cache.items, cached: true, fetched_at: cache.fetched_at };
          }
          throw e;
        }
      }),
      'ranking.getCategories': wrapHandler<'ranking.getCategories'>(async (payload) => {
        const source = payload.source;
        const cacheKey = source === 'FASTMOSS' ? 'fastmoss_category_cache' : 'category_cache';
        const cache = await storageGet(cacheKey);
        if (cache && !payload.force && (source !== 'ECHOTIK' || !isEnglishCategoryTree(cache.items))) {
          return { items: cache.items, cached: true, fetched_at: cache.fetched_at };
        }
        try {
          const adapter = createRankingAdapter(source, createRankingTransports());
          const items = await adapter.fetchCategories();
          const fetched_at = new Date().toISOString();
          await storageSet(cacheKey, { items, fetched_at });
          return { items, cached: false, fetched_at };
        } catch (e) {
          if (cache?.items?.length) return { items: cache.items, cached: true, fetched_at: cache.fetched_at };
          throw e;
        }
      }),
      'product.list': wrapHandler<'product.list'>(async (payload) => getApi().listProducts(payload ?? {})),
      'product.collectSingle': wrapHandler<'product.collectSingle'>(async (payload) =>
        collectSingleProduct(payload.external_product_id, payload.region),
      ),
      'product.rankHistory': wrapHandler<'product.rankHistory'>(async (payload) =>
        getApi().productRankHistory(payload.product_id),
      ),
      'batch.list': wrapHandler<'batch.list'>(async (payload) => getApi().listBatches(payload ?? {})),
      'batch.get': wrapHandler<'batch.get'>(async (payload) => getApi().getBatchDetail(payload.batch_id)),
      'batch.create': wrapHandler<'batch.create'>(async (payload) => {
        const ec = await storageGet('exec_config');
        return getApi().createBatch({
          snapshot_id: payload.snapshot_id,
          product_ids: payload.product_ids,
          exclude_already_successful: payload.exclude_already_successful,
          interval_seconds: payload.interval_seconds ?? { min: ec.interval_min_sec, max: ec.interval_max_sec },
          idempotency_key: payload.idempotency_key,
        });
      }),
      'batch.start': wrapHandler<'batch.start'>(async (payload) => {
        const res = await getApi().batchAction(payload.batch_id, 'start', { client_id: await storageGet('client_id') });
        // 本客户端发起开始：同步本地检查点并领取首件（与 runner.start 一致）
        await saveCheckpoint({ ...(await loadCheckpoint()), active_batch_id: payload.batch_id, paused: false, runner_stage: 'IDLE' });
        await claimAndStart(payload.batch_id);
        return res;
      }),
      'batch.recollectTask': wrapHandler<'batch.recollectTask'>(async (payload) => {
        const cp = await loadCheckpoint();
        if (cp.active_task_id) {
          throw new Error('当前有任务正在执行，请先完成或暂停后再重新抓取');
        }
        const task = await getApi().recollectTask(payload.task_id);
        // 服务端已把批次置为 RUNNING；同步本地检查点并领取该强制重抓任务
        await saveCheckpoint({ ...(await loadCheckpoint()), active_batch_id: task.batch_id, paused: false, runner_stage: 'IDLE' });
        await claimAndStart(task.batch_id);
        await broadcastState();
        return task;
      }),
      'batch.pause': wrapHandler<'batch.pause'>(async (payload) => {
        const res = await getApi().batchAction(payload.batch_id, 'pause', {});
        const cp = await loadCheckpoint();
        if (cp.active_batch_id === payload.batch_id) await saveCheckpoint({ ...cp, paused: true });
        return res;
      }),
      'batch.resume': wrapHandler<'batch.resume'>(async (payload) => {
        const res = await getApi().batchAction(payload.batch_id, 'resume', {});
        const cp = await loadCheckpoint();
        if (cp.active_batch_id === payload.batch_id) {
          await saveCheckpoint({ ...cp, paused: false });
          await reconcile('batch.resume');
        }
        return res;
      }),
      'batch.cancel': wrapHandler<'batch.cancel'>(async (payload) => {
        const res = await getApi().batchAction(payload.batch_id, 'cancel', {});
        const cp = await loadCheckpoint();
        if (cp.active_batch_id === payload.batch_id) {
          await saveCheckpoint({ ...cp, active_batch_id: null, active_task_id: null, runner_stage: 'IDLE', paused: false });
          currentSm = null;
        }
        return res;
      }),
      'batch.retryFailed': wrapHandler<'batch.retryFailed'>(async (payload) =>
        getApi().retryFailedBatch(payload.batch_id, {
          idempotency_key: payload.idempotency_key,
          statuses: payload.statuses,
          force: payload.force,
        }),
      ),
      'batch.tasks': wrapHandler<'batch.tasks'>(async (payload) => {
        const { batch_id, ...params } = payload;
        return getApi().listBatchTasks(batch_id, params);
      }),
      'attempt.list': wrapHandler<'attempt.list'>(async (payload) => getApi().listAttempts(payload ?? {})),
      'client.me': wrapHandler<'client.me'>(async () => getApi().me()),
      // ---- 超级管理员（隐藏设置，只读）----
      'admin.listClients': wrapHandler<'admin.listClients'>(async () => getApi().adminListClients()),
      'admin.listBatches': wrapHandler<'admin.listBatches'>(async (payload) =>
        getApi().adminListBatches(payload ?? {}),
      ),
      'admin.getBatch': wrapHandler<'admin.getBatch'>(async (payload) =>
        getApi().adminGetBatch(payload.batch_id),
      ),
      'admin.batchTasks': wrapHandler<'admin.batchTasks'>(async (payload) => {
        const { batch_id, ...params } = payload;
        return getApi().adminListBatchTasks(batch_id, params);
      }),
      'admin.listProducts': wrapHandler<'admin.listProducts'>(async (payload) =>
        getApi().adminListProducts(payload ?? {}),
      ),
      'admin.listSnapshots': wrapHandler<'admin.listSnapshots'>(async (payload) =>
        getApi().adminListSnapshots(payload ?? {}),
      ),
      'outbox.flush': wrapHandler<'outbox.flush'>(async () => {
        // 手动触发 outbox 补传（复用恢复流程的幂等补传逻辑）
        const before = (await outboxPending()).length;
        await syncOutbox();
        const remaining = (await outboxPending()).length;
        return { synced: Math.max(0, before - remaining), remaining };
      }),
      'env.check': wrapHandler<'env.check'>(async () => envCheck()),
      'debug.readLogs': wrapHandler<'debug.readLogs'>(async (payload) => ({
        items: await readDebugLogs(payload?.limit ?? 100),
      })),
      'debug.clearLogs': wrapHandler<'debug.clearLogs'>(async () => {
        await clearDebugLogs();
        return { ok: true as const };
      }),
      'widget.openDashboard': wrapHandler<'widget.openDashboard'>(async () => {
        await openManagerPage();
        return { opened: true as const };
      }),
      'widget.locateWorkerTab': wrapHandler<'widget.locateWorkerTab'>(async () => {
        const tabId = await storageGet('worker_tab_id');
        if (tabId == null) return { focused: false };
        const tab = await browser.tabs.get(tabId).catch(() => null);
        if (!tab) return { focused: false };
        await browser.tabs.update(tabId, { active: true });
        if (tab.windowId != null) await browser.windows.update(tab.windowId, { focused: true });
        return { focused: true };
      }),
      // content script 事件
      'cs.contentReady': wrapHandler<'cs.contentReady'>(async (payload, sender) => {
        // 新建/跳转 TikTok Tab 时，content script 可能早于 ensureSingleTikTokTab
        // 写入 checkpoint 完成注入。此处立刻补探测，避免“页面已打开但一直不点击”。
        const cp = await loadCheckpoint();
        const tabId = (sender as { tab?: { id?: number } }).tab?.id;
        await dlog('background', '内容脚本已就绪', {
          site: payload.site,
          tabId,
          stage: cp.runner_stage,
          productId: cp.product?.external_product_id,
        });
        if (
          payload.site === 'tiktok' &&
          tabId != null &&
          cp.runner_stage === 'NAVIGATING' &&
          cp.product &&
          (cp.worker_tab_id == null || cp.worker_tab_id === tabId)
        ) {
          await saveCheckpoint({ ...cp, worker_tab_id: tabId });
          await probeAndAdvance(tabId, cp.product.external_product_id);
        }
        return { ack: true as const };
      }),
      'tiktok.pageReady': wrapHandler<'tiktok.pageReady'>(async (payload) => {
        const cp = await loadCheckpoint();
        await dlog('background', '收到 TikTok 页面就绪事件', {
          reportedProductId: payload.productId,
          expectedProductId: cp.product?.external_product_id,
          stage: cp.runner_stage,
        });
        if (cp.runner_stage === 'NAVIGATING' && cp.product?.external_product_id === payload.productId) {
          // content script 的就绪通知可能先于 probeAndAdvance 返回。
          // 检查点与内存状态机必须同步推进，否则 PAGE_READY 阶段会因
          // currentSm 仍停在 NAVIGATING 而跳过“检测并点击采集此商品”。
          if (currentSm?.status === 'NAVIGATING') {
            transition(currentSm, 'PAGE_READY', 'content-script pageReady');
          }
          await dlog('background', 'TikTok 页面就绪，准备检测妙手按钮', {
            productId: payload.productId,
            tab: cp.worker_tab_id,
          });
          await saveCheckpoint({ ...cp, runner_stage: 'PAGE_READY' });
          await advanceRunner('cs-pageReady');
        } else {
          await dlog('background', '页面就绪事件未推进任务', {
            reason: cp.runner_stage !== 'NAVIGATING' ? '当前阶段不是 NAVIGATING' : '商品 ID 不匹配',
          });
        }
        return { ack: true as const };
      }),
      'tiktok.challenge': wrapHandler<'tiktok.challenge'>(async (payload) => {
        const cp = await loadCheckpoint();
        if (cp.active_task_id) {
          await saveCheckpoint({ ...cp, runner_stage: 'WAITING_VERIFICATION' });
          await notifyUser('TikTok 验证/访问限制', `检测到 ${payload.kind}，请人工完成验证。`);
        }
        return { ack: true as const };
      }),
      'tiktok.challengeResolved': wrapHandler<'tiktok.challengeResolved'>(async () => {
        const cp = await loadCheckpoint();
        if (cp.runner_stage === 'WAITING_VERIFICATION') {
          await saveCheckpoint({ ...cp, runner_stage: 'RECOVERING' });
          await advanceRunner('challenge-resolved');
        }
        return { ack: true as const };
      }),
      'tiktok.regionUnavailable': wrapHandler<'tiktok.regionUnavailable'>(async (payload, sender) => {
        const cp = await loadCheckpoint();
        const s = sender as { tab?: { id?: number } };
        // 只接受当前 worker tab 上报，避免其他 TikTok 标签页误暂停批次
        if (!cp.active_task_id || s.tab?.id !== cp.worker_tab_id) return { ack: true as const };
        if (payload.productId && cp.product?.external_product_id !== payload.productId) return { ack: true as const };
        // 仅导航/页面就绪阶段生效；已提交的不要误判
        if (!['LEASED', 'NAVIGATING', 'PAGE_READY'].includes(cp.runner_stage ?? '')) {
          return { ack: true as const };
        }
        await stopForRegionUnavailable(payload.evidence);
        return { ack: true as const };
      }),
      // background → content script 的消息不会在 background 收到；占位返回错误
      'echotik.checkLogin': notHere(),
      'echotik.readPageSelection': notHere(),
      'echotik.fetchApi': notHere(),
      'tiktok.probe': notHere(),
      'tiktok.detectMiaoshou': notHere(),
      'tiktok.submitCollect': notHere(),
      'tiktok.verifyCollect': notHere(),
      'runtime.state.push': wrapHandler<'runtime.state.push'>(async () => undefined),
    };
    const handler = handlers[type];
    if (!handler) return { ok: false, error: { code: 'UNKNOWN_MESSAGE', message: String(type) } };
    return handler(msg.payload as never, sender);
  }

  /**
   * 占位处理器：该消息类型不由 background 处理
   */
  function notHere<K extends keyof MessageMap>(): ReturnType<typeof wrapHandler<K>> {
    return wrapHandler(async () => {
      throw new Error('该消息不由 background 处理');
    }) as ReturnType<typeof wrapHandler<K>>;
  }

  /**
   * 打开管理台：独立扩展页面（独立窗口），不叠加在任何网页上
   * 若已存在管理台窗口则聚焦复用，避免重复打开
   */
  async function openManagerPage(): Promise<void> {
    const url = browser.runtime.getURL('/manager.html');
    const tabs = await browser.tabs.query({ url: `${url}*` }).catch(() => []);
    const existing = tabs[0];
    if (existing?.id != null) {
      await browser.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) {
        await browser.windows.update(existing.windowId, { focused: true });
      }
      return;
    }
    // 管理台包含筛选器、快照/批次表格与日志；使用桌面工作区宽度，避免 520px 窗口挤压表格。
    await browser.windows.create({ url, type: 'popup', width: 1080, height: 860 });
  }

  // ---------------- 状态广播与通知 ----------------

  /**
   * 页面环境探测（Dashboard 环境卡）：EchoTik 登录态 / TikTok 工作 Tab / 妙手检测 / 服务器连通
   * 全部为 best-effort 探测，单项失败不影响其他项
   */
  async function envCheck(): Promise<MessageMap['env.check']['res']> {
    // EchoTik Tab 与登录态（优先主域，登录 Cookie 不在 www 等子域）
    const echotikTab = await findEchoTikTab().catch(() => null);
    let echotik: MessageMap['env.check']['res']['echotik'] = {
      tab_found: !!echotikTab,
      logged_in: null,
      evidence: echotikTab ? '' : '未找到 EchoTik 页面',
    };
    if (echotikTab?.id != null) {
      const login = await sendMsg('echotik.checkLogin', undefined, echotikTab.id).catch((e) => null);
      echotik = login
        ? { tab_found: true, logged_in: login.loggedIn, evidence: login.evidence }
        : { tab_found: true, logged_in: null, evidence: '页面探测失败（Content Script 未就绪）' };
    }
    // TikTok 工作 Tab
    const workerTabId = await storageGet('worker_tab_id');
    let tiktok: MessageMap['env.check']['res']['tiktok'] = { worker_tab_found: false, tab_id: null };
    if (workerTabId != null) {
      const tab = await browser.tabs.get(workerTabId).catch(() => null);
      tiktok = { worker_tab_found: !!tab, tab_id: tab?.id ?? null };
    }
    // 妙手检测（仅在 TikTok 工作 Tab 存在时探测）
    let miaoshou: MessageMap['env.check']['res']['miaoshou'] = {
      checked: false,
      available: null,
      evidence: tiktok.worker_tab_found ? '' : '无 TikTok 工作 Tab，未检测',
    };
    if (tiktok.tab_id != null) {
      const det = await sendMsg('tiktok.detectMiaoshou', undefined, tiktok.tab_id).catch(() => null);
      if (det) miaoshou = { checked: true, available: det.available, evidence: det.evidence || det.reason || '' };
      else miaoshou = { checked: true, available: null, evidence: '探测消息失败（页面可能未就绪）' };
    }
    // 服务器连通
    let server: MessageMap['env.check']['res']['server'] = { connected: false, latency_ms: null };
    const t0 = Date.now();
    const ok = await getApi().me().then(() => true).catch(() => false);
    server = { connected: ok, latency_ms: ok ? Date.now() - t0 : null };
    return { echotik, tiktok, miaoshou, server };
  }

  /**
   * 构建对外广播的运行时状态
   */
  async function buildPublicState(): Promise<RuntimePublicState> {
    const identity = await loadClientIdentity();
    const authToken = await storageGet('auth_token');
    const roleRaw = await storageGet('identity_role');
    const displayName = await storageGet('identity_display_name');
    const authorized = !!authToken && !!identity.client_id;
    const role = authorized && roleRaw ? (roleRaw === 'ADMIN' ? 'ADMIN' : 'USER') : null;
    const cp = await loadCheckpoint();
    let connected = false;
    let progress: RuntimePublicState['progress'] = null;
    let activeBatchId = cp.active_batch_id;
    let runnerStage = cp.runner_stage;
    let paused = cp.paused;
    let currentProductTitle = cp.product?.external_product_id ?? null;
    if (authorized && cp.active_batch_id) {
      const batch = await getApi().getBatch(cp.active_batch_id).catch(() => null);
      if (batch) {
        connected = true;
        if (['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED'].includes(batch.status)) {
          // 服务器已终态时不再把残留 checkpoint 渲染成“当前批次”；
          // reconcile 会在下一轮彻底清理存储中的 active_batch_id。
          activeBatchId = null;
          runnerStage = 'IDLE';
          paused = false;
          currentProductTitle = null;
        }
        const s = batch.summary ?? {};
        const done = (s.success ?? 0) + (s.failed ?? 0) + (s.skipped ?? 0) + (s.unknown ?? 0);
        progress = batch.total != null ? { done, total: batch.total } : null;
      }
    } else if (authorized) {
      connected = await getApi().me().then(() => true).catch(() => false);
    }
    return {
      connected,
      registered: authorized,
      authorized,
      role,
      display_name: displayName ?? null,
      client_id: identity.client_id,
      active_batch_id: activeBatchId,
      runner_stage: runnerStage,
      paused,
      waiting_verification: runnerStage === 'WAITING_VERIFICATION',
      progress: rankingProgress.running
        ? { done: rankingProgress.fetched, total: rankingProgress.limit }
        : progress,
      current_product_title: currentProductTitle,
      last_error: null,
    };
  }

  /**
   * 向所有订阅方（sidepanel/popup/widget）广播运行时状态
   */
  async function broadcastState(): Promise<void> {
    const state = await buildPublicState().catch(() => null);
    if (!state) return;
    const msg = { type: 'runtime.state.push', payload: state };
    await browser.runtime.sendMessage(msg).catch(() => undefined);
    const tabs = await browser.tabs.query({}).catch(() => []);
    for (const tab of tabs) {
      if (tab.id != null && /echotik\.live|tiktok\.com/.test(tab.url ?? '')) {
        await browser.tabs.sendMessage(tab.id, msg).catch(() => undefined);
      }
    }
  }

  /**
   * 系统通知（验证等待/批次完成等）
   * @param title 标题
   * @param message 内容
   */
  async function notifyUser(title: string, message: string): Promise<void> {
    const behavior = await storageGet('behavior_config').catch(() => null);
    if (behavior && !behavior.notify_on_exception) return;
    await browser.notifications
      .create({
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title,
        message,
      })
      .catch(() => undefined);
  }
});

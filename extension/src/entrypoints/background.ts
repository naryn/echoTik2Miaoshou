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
  idbGetAll,
  idbPut,
  loadClientIdentity,
  outboxAck,
  outboxEnqueue,
  outboxPending,
  saveClientIdentity,
  storageGet,
  storageGetMany,
  storageSet,
  type LocalProductRecord,
  type OutboxEvent,
} from '@/modules/storage';
import { createApiClient, ApiError, type ApiClient } from '@/modules/api/client';
import { createEchoTikAdapter, type EchoTikTransport } from '@/modules/echotik/adapter';
import { ensureSingleTikTokTab, clearWorkerTabIfMatches, resolveDetailUrl } from '@/modules/tiktok/tab-manager';
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
  type CategoryNode,
  type ProductItem,
  type ProductRankingEntry,
  type RankingQuery,
  type RunnerCheckpoint,
  type RuntimePublicState,
  type TaskStatus,
} from '@/shared/types';

const EXT_VERSION = '0.1.0';
const ALARM_TICK = 'echotik-tick';

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
  // openPanelOnActionClick 并存），Side Panel 经 popup 内"打开管理台"按钮打开

  // 周期 alarm：reconcile + outbox 同步（周期 1 分钟，≥ 0.5 分钟约束）
  void browser.alarms.create(ALARM_TICK, { periodInMinutes: 1 });

  // ---------------- 客户端注册 ----------------

  /**
   * 安装/更新处理：生成 install_id、注册远程客户端
   * @param reason onInstalled 原因
   */
  async function handleInstalled(reason: string): Promise<void> {
    await storageSet('extension_version', EXT_VERSION);
    let installId = await storageGet('install_id');
    if (!installId) {
      installId = crypto.randomUUID();
      await storageSet('install_id', installId);
    }
    const identity = await loadClientIdentity();
    if (!identity.client_id || !identity.client_token) {
      await registerClient().catch(() => {
        // 注册失败进入未注册态，等待 alarm/UI 触发重试
      });
    }
    if (reason === 'install') {
      await browser.tabs.create({ url: 'https://echotik.live/' }).catch(() => undefined);
    }
  }

  /**
   * 调用远程 register 换取 client_id/token 并持久化
   */
  async function registerClient(): Promise<void> {
    const identity = await loadClientIdentity();
    if (!identity.install_id) throw new Error('install_id 缺失');
    const api = getApi();
    const res = await api.register(identity.install_id, `Chrome 客户端 ${identity.install_id.slice(0, 8)}`, EXT_VERSION);
    await saveClientIdentity({
      client_id: res.client_id,
      client_token: res.client_token,
      registered_at: new Date().toISOString(),
    });
    await broadcastState();
  }

  // ---------------- API 客户端 ----------------

  let cachedApi: ApiClient | null = null;

  /**
   * 获取远程 API 客户端（base URL 与鉴权均在请求时惰性读取，配置变更即时生效）
   */
  function getApi(): ApiClient {
    return (cachedApi ??= createApiClient({
      getBaseUrl: () => storageGet('server_url'),
      getAuth: async () => {
        const s = await storageGetMany(['client_id', 'client_token']);
        return { client_id: s.client_id, client_token: s.client_token };
      },
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
    if (!checkpoint.active_batch_id || !checkpoint.runner_stage || checkpoint.runner_stage === 'IDLE') {
      return; // 无活动批次
    }
    if (checkpoint.paused) return; // 用户暂停：不自动推进

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
          if (!cp2.worker_tab_id) return;
          const miaoshou = await sendMsg('tiktok.detectMiaoshou', undefined, cp2.worker_tab_id);
          if (!miaoshou.available) {
            await finishTask('FAILED', { evidence: miaoshou.evidence, error_code: ERROR_CODES.MIAOSHOU_UNAVAILABLE });
            return;
          }
          // 已在 PAGE_READY 之外（例如重入时已进入后续阶段）则不再重复提交
          if (currentSm.status === 'PAGE_READY') {
            transition(currentSm, 'SUBMITTING', miaoshou.evidence);
            // 提交前写 SUBMITTING 检查点（规范 §5.3）
            await saveCheckpoint({ ...(await loadCheckpoint()), runner_stage: 'SUBMITTING' });
            await advanceRunner('submitting');
          }
          break;
        }
        case 'SUBMITTING': {
          const cp2 = await loadCheckpoint();
          if (!cp2.worker_tab_id) return;
          const submission = await sendMsg('tiktok.submitCollect', undefined, cp2.worker_tab_id);
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
    } catch {
      // content script 尚未注入：等 tabs.onUpdated/reconcile 兜底
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
    const identity = await loadClientIdentity();
    if (!identity.client_id) {
      await registerClient().catch(() => undefined);
      return;
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

  /**
   * 执行榜单抓取：EchoTik 分页 → 远程快照（部分上传失败保留 PARTIAL）
   * @param query 查询条件
   */
  async function runRankingCollect(query: RankingQuery): Promise<void> {
    rankingCancelled = false;
    rankingProgress = { running: true, fetched: 0, limit: query.limit, page: 0, done: false, reason: '' };
    const transport = createEchoTikTransport();
    const adapter = createEchoTikAdapter(transport);
    const identity = await loadClientIdentity();
    if (!identity.client_id) throw new Error(ERROR_CODES.NOT_REGISTERED);

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
      await persistLocalProducts(entries, query, snapshot.snapshot_id);
    } catch (e) {
      // 快照已创建：后续抓取/上传异常时标记 FAILED，避免历史快照长期停留在 CAPTURING
      await getApi().finishSnapshot(snapshot.snapshot_id, 'FAILED', 0).catch(() => undefined);
      throw e;
    }
    const finalStatus =
      uploadFailed || reason === 'CANCELLED' || reason === 'PERMISSION_LIMIT' ? 'PARTIAL' : 'COMPLETED';
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
   * 将本次采集结果写入本地 IndexedDB（商品列表页的唯一数据源）
   * 以 `region:external_product_id` 为键，重复采集时更新为最新一次观测
   * @param entries 归一化后的采集条目
   * @param query 本次采集条件
   * @param snapshotId 远端快照 ID（仅用于溯源展示）
   */
  async function persistLocalProducts(
    entries: ProductRankingEntry[],
    query: RankingQuery,
    snapshotId: string,
  ): Promise<void> {
    if (!entries.length) return;
    const collectedAt = new Date().toISOString();
    const records: LocalProductRecord[] = entries.map((e) => ({
      id: `${e.region}:${e.external_product_id}`,
      platform: 'TIKTOK',
      region: e.region,
      external_product_id: e.external_product_id,
      title: e.title ?? null,
      shop_id: e.shop?.id ?? null,
      shop_name: e.shop?.name ?? null,
      rank_position: e.rank_position ?? null,
      sales_value: e.sales?.value ?? null,
      gmv_value: e.gmv?.value ?? null,
      image_url: e.image_url ?? null,
      category: e.category ?? null,
      detail_url: e.detail_url ?? `https://www.tiktok.com/shop/pdp/${e.external_product_id}`,
      snapshot_id: snapshotId,
      ranking_variant: String(query.rankingVariant ?? 'top-sold'),
      ranking_type: String(query.rankingType),
      period_start: query.periodStart ?? null,
      collected_at: collectedAt,
    }));
    await Promise.all(records.map((r) => idbPut('local_products', r)));
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
   * 构建「类目英文名 / slug / ID → 中文 label」映射，用于把远端英文类目显示为中文
   * 同时返回「类目 label → 后代类目 label 集合」，用于选中一级/二级分类时匹配其下商品
   * 数据来自本地缓存的 EchoTik 类目树（product-category 接口）
   */
  async function buildCategoryIndex(): Promise<{
    labelMap: Map<string, string>;
    descendants: Map<string, Set<string>>;
  }> {
    const cache = await storageGet('category_cache');
    const labelMap = new Map<string, string>();
    const descendants = new Map<string, Set<string>>();

    /** 收集节点及其所有后代的 label（小写） */
    const collectLabels = (nodes: CategoryNode[], into: Set<string>): void => {
      for (const n of nodes) {
        const l = (n.label ?? '').trim().toLowerCase();
        if (l) into.add(l);
        if (n.children?.length) collectLabels(n.children, into);
      }
    };

    const walk = (nodes: CategoryNode[]): void => {
      for (const n of nodes) {
        const label = (n.label ?? '').trim();
        if (label) {
          labelMap.set(label.toLowerCase(), label);
          if (n.name_slug) labelMap.set(n.name_slug.toLowerCase(), label);
          if (n.value) labelMap.set(String(n.value).toLowerCase(), label);
          if (n.children?.length) {
            const set = new Set<string>();
            collectLabels(n.children, set);
            descendants.set(label.toLowerCase(), set);
          }
        }
        if (n.children?.length) walk(n.children);
      }
    };
    walk(cache?.items ?? []);

    // 英文类目树：把旧记录中的英文类目名映射为中文（失败时忽略）
    const enCache = await storageGet('category_cache_en');
    let enItems: CategoryNode[] | null = enCache?.items ?? null;
    if (!enItems && cache?.items?.length) {
      try {
        const adapter = createEchoTikAdapter(createEchoTikTransport());
        enItems = await adapter.fetchCategories('en');
        await storageSet('category_cache_en', { items: enItems, fetched_at: new Date().toISOString() });
      } catch {
        enItems = null;
      }
    }
    if (enItems?.length) {
      /** value → 中文 label */
      const byValue = new Map<string, string>();
      const collectValue = (nodes: CategoryNode[]): void => {
        for (const n of nodes) {
          const label = (n.label ?? '').trim();
          if (label && n.value) byValue.set(String(n.value), label);
          if (n.children?.length) collectValue(n.children);
        }
      };
      collectValue(cache?.items ?? []);
      /** 英文 label（小写）→ 中文 label */
      const collectEn = (nodes: CategoryNode[]): void => {
        for (const n of nodes) {
          const zh = n.value ? byValue.get(String(n.value)) : undefined;
          const en = (n.label ?? '').trim().toLowerCase();
          if (zh && en) labelMap.set(en, zh);
          if (n.children?.length) collectEn(n.children);
        }
      };
      collectEn(enItems);
    }
    return { labelMap, descendants };
  }

  /**
   * 查询批次内所有任务涉及的商品外部 ID（商品列表按批次过滤用）
   * 注意：只读取批次任务，不读取远端商品列表
   * @param batchId 批次 ID
   */
  async function batchExternalProductIds(batchId: string): Promise<Set<string>> {
    const api = getApi();
    const out = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const r = await api.listBatchTasks(batchId, { page, per_page: 100 });
      for (const t of r.items) {
        const ext = t.product?.external_product_id;
        if (ext) out.add(ext);
      }
      if (page * r.per_page >= r.total) break;
    }
    return out;
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
    await api.batchAction(batch.batch_id, 'start', { client_id: await storageGet('client_id') });
    await saveCheckpoint({
      ...(await loadCheckpoint()),
      active_batch_id: batch.batch_id,
      paused: false,
      runner_stage: 'IDLE',
    });
    await claimAndStart(batch.batch_id);
    await broadcastState();
    return { batch_id: batch.batch_id, closed_batch_ids: closed.length ? closed : undefined };
  }

  /**
   * 本地商品分页查询（筛选/排序全部在本地完成，不访问远端商品列表）
   * @param payload 查询条件（batch_id 时先取该批次任务商品外部 ID 做交集）
   */
  async function listLocalProducts(payload: {
    keyword?: string;
    region?: string;
    category?: string;
    ranking_variant?: string;
    date_from?: string;
    date_to?: string;
    rank_min?: number;
    rank_max?: number;
    batch_id?: string;
    sort?: string;
    order?: 'asc' | 'desc';
    page?: number;
    per_page?: number;
  }): Promise<{ items: ProductItem[]; total: number; page: number; per_page: number }> {
    const all = await idbGetAll<LocalProductRecord>('local_products');
    const { labelMap, descendants } = await buildCategoryIndex();
    const kw = (payload.keyword ?? '').trim().toLowerCase();
    const from = payload.date_from ? new Date(payload.date_from).getTime() : null;
    const to = payload.date_to ? new Date(payload.date_to).getTime() : null;
    // 批次过滤：仅保留该批次任务涉及的商品（远端任务列表，非商品列表）
    const batchExtIds = payload.batch_id ? await batchExternalProductIds(payload.batch_id) : null;

    /** 分类值统一转为中文 label（已是中文则原样保留） */
    const toZh = (raw: string | null): string | null =>
      raw ? (labelMap.get(raw.toLowerCase()) ?? raw) : null;

    const filtered = all.filter((r) => {
      if (kw) {
        const hay = `${r.title ?? ''} ${r.external_product_id} ${r.shop_name ?? ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      if (payload.region && r.region !== payload.region) return false;
      if (batchExtIds && !batchExtIds.has(r.external_product_id)) return false;
      if (payload.category) {
        const sel = payload.category.toLowerCase();
        const cat = (r.category ?? '').toLowerCase();
        const sub = descendants.get(sel);
        // 选中一级/二级分类时匹配其下所有后代；选中叶子或未知分类时精确匹配
        if (sub && sub.size) {
          if (!sub.has(cat)) return false;
        } else if (cat !== sel) return false;
      }
      if (payload.ranking_variant && r.ranking_variant !== payload.ranking_variant) return false;
      if (payload.rank_min != null && (r.rank_position ?? 0) < payload.rank_min) return false;
      if (payload.rank_max != null && (r.rank_position ?? 0) > payload.rank_max) return false;
      const t = new Date(r.collected_at).getTime();
      if (from != null && t < from) return false;
      if (to != null && t > to) return false;
      return true;
    });

    const dir = payload.order === 'asc' ? 1 : -1;
    const sort = payload.sort ?? 'collected_at';
    filtered.sort((a, b) => {
      if (sort === 'rank_position') return ((a.rank_position ?? 0) - (b.rank_position ?? 0)) * dir;
      if (sort === 'title') return (a.title ?? '').localeCompare(b.title ?? '') * dir;
      return (new Date(a.collected_at).getTime() - new Date(b.collected_at).getTime()) * dir;
    });

    const page = Math.max(1, payload.page ?? 1);
    const perPage = Math.min(100, Math.max(1, payload.per_page ?? 20));
    const start = (page - 1) * perPage;
    const items = filtered.slice(start, start + perPage).map((r) => ({
      id: r.id,
      platform: r.platform,
      region: r.region,
      external_product_id: r.external_product_id,
      title: r.title,
      shop_id: r.shop_id,
      shop_name: r.shop_name,
      image_url: r.image_url,
      detail_url: r.detail_url,
      first_seen_at: r.collected_at,
      last_seen_at: r.collected_at,
      raw_excerpt: { category: toZh(r.category), rank_position: r.rank_position },
      erp_status: 'NEVER',
    }));
    return { items, total: filtered.length, page, per_page: perPage };
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
    };
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
      'client.register': wrapHandler<'client.register'>(async (payload) => {
        if (payload?.server_url) {
          await storageSet('server_url', payload.server_url);
        }
        await registerClient();
        return { client_id: (await storageGet('client_id')) ?? '' };
      }),
      'client.testConnection': wrapHandler<'client.testConnection'>(async () => {
        const t0 = Date.now();
        await getApi().me();
        return { connected: true, latency_ms: Date.now() - t0 };
      }),
      'client.updateServerUrl': wrapHandler<'client.updateServerUrl'>(async (payload) => {
        await storageSet('server_url', payload.server_url);
        return { saved: true as const };
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
      'ranking.getProgress': wrapHandler<'ranking.getProgress'>(async () => rankingProgress),
      'ranking.cancelCollect': wrapHandler<'ranking.cancelCollect'>(async () => {
        rankingCancelled = true;
        return { cancelled: true as const };
      }),
      'ranking.preview': wrapHandler<'ranking.preview'>(async (payload) => {
        // 预览：只抓首页并归一化，不创建远程快照（规范 §3.3 预览不持久化）
        const adapter = createEchoTikAdapter(createEchoTikTransport());
        const page = await adapter.fetchRankingPage(payload.query, undefined, 1);
        const startRank = Math.max(1, payload.query.startRank || 1);
        const items = page.records
          .map((raw, i) => {
            try {
              return adapter.normalize(raw, payload.query, startRank + i);
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
        // 定位 EchoTik Tab → 读取页面筛选 → 合并覆盖项 → 复用榜单抓取流程
        const tab = await findEchoTikTab();
        if (!tab?.id) {
          throw Object.assign(new Error('未找到 EchoTik 页面，请先打开 echotik.live 榜单页'), {
            code: ERROR_CODES.ECHOTIK_NETWORK,
          });
        }
        const selection = await sendMsg('echotik.readPageSelection', undefined, tab.id).catch(() => ({}) as Partial<RankingQuery>);
        const query: RankingQuery = {
          region: 'US',
          rankingType: 'daily',
          rankingVariant: 'top-sold',
          startRank: 1,
          limit: 200,
          ...selection,
          ...(payload?.overrides ?? {}),
        } as RankingQuery;
        void runRankingCollect(query).catch((e) => {
          rankingProgress = { ...rankingProgress, running: false, done: true, reason: (e as Error).message };
        });
        return { started: true as const };
      }),
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
      'product.list': wrapHandler<'product.list'>(async (payload) => getApi().listProducts(payload ?? {})),
      'product.listLocal': wrapHandler<'product.listLocal'>(async (payload) => listLocalProducts(payload ?? {})),
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
      'outbox.flush': wrapHandler<'outbox.flush'>(async () => {
        // 手动触发 outbox 补传（复用恢复流程的幂等补传逻辑）
        const before = (await outboxPending()).length;
        await syncOutbox();
        const remaining = (await outboxPending()).length;
        return { synced: Math.max(0, before - remaining), remaining };
      }),
      'env.check': wrapHandler<'env.check'>(async () => envCheck()),
      'widget.openDashboard': wrapHandler<'widget.openDashboard'>(async () => {
        await openSidePanel(sender);
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
      'cs.contentReady': wrapHandler<'cs.contentReady'>(async () => ({ ack: true as const })),
      'tiktok.pageReady': wrapHandler<'tiktok.pageReady'>(async (payload) => {
        const cp = await loadCheckpoint();
        if (cp.runner_stage === 'NAVIGATING' && cp.product?.external_product_id === payload.productId) {
          await saveCheckpoint({ ...cp, runner_stage: 'PAGE_READY' });
          await advanceRunner('cs-pageReady');
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
   * 打开 Side Panel（widget/ popup 触发）
   * @param sender 消息发送者
   */
  async function openSidePanel(sender: unknown): Promise<void> {
    const s = sender as { tab?: { windowId?: number } };
    const windowId = s?.tab?.windowId ?? (await browser.windows.getCurrent()).id;
    if (windowId != null) {
      await browser.sidePanel.open({ windowId }).catch(() => undefined);
    }
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
    const cp = await loadCheckpoint();
    let connected = false;
    let progress: RuntimePublicState['progress'] = null;
    if (cp.active_batch_id) {
      const batch = await getApi().getBatch(cp.active_batch_id).catch(() => null);
      if (batch) {
        connected = true;
        const s = batch.summary ?? {};
        const done = (s.success ?? 0) + (s.failed ?? 0) + (s.skipped ?? 0) + (s.unknown ?? 0);
        progress = batch.total != null ? { done, total: batch.total } : null;
      }
    } else {
      connected = await getApi().me().then(() => true).catch(() => false);
    }
    return {
      connected,
      registered: !!identity.client_id,
      client_id: identity.client_id,
      active_batch_id: cp.active_batch_id,
      runner_stage: cp.runner_stage,
      paused: cp.paused,
      waiting_verification: cp.runner_stage === 'WAITING_VERIFICATION',
      progress: rankingProgress.running
        ? { done: rankingProgress.fetched, total: rankingProgress.limit }
        : progress,
      current_product_title: cp.product?.external_product_id ?? null,
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

/**
 * 任务状态机（规范 §5.3）：
 * PENDING→LEASED→NAVIGATING→PAGE_READY→SUBMITTING→SUBMITTED→SUCCESS/FAILED/UNKNOWN/SKIPPED
 * 异常→WAITING_VERIFICATION→RECOVERING→回到合适阶段
 * 每次迁移记录时间+证据；迁移合法性校验；幂等 key（attempt_id/event_id UUID）
 * 本模块为纯逻辑，不依赖 chrome.* API，便于单测。
 */
import type { TaskStatus } from '@/shared/types/domain';

/** 合法迁移表：key 为源状态，value 为可达目标状态 */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ['LEASED', 'SKIPPED', 'FAILED'],
  LEASED: ['NAVIGATING', 'FAILED', 'SKIPPED'],
  NAVIGATING: ['PAGE_READY', 'WAITING_VERIFICATION', 'FAILED'],
  PAGE_READY: ['SUBMITTING', 'WAITING_VERIFICATION', 'FAILED', 'SKIPPED'],
  SUBMITTING: ['SUBMITTED', 'WAITING_VERIFICATION', 'FAILED', 'UNKNOWN'],
  SUBMITTED: ['SUCCESS', 'FAILED', 'UNKNOWN', 'WAITING_VERIFICATION'],
  WAITING_VERIFICATION: ['RECOVERING', 'FAILED'],
  RECOVERING: ['NAVIGATING', 'PAGE_READY', 'SUBMITTING', 'FAILED', 'UNKNOWN'],
  SUCCESS: [],
  FAILED: [],
  SKIPPED: [],
  UNKNOWN: [],
};

/** 终态集合 */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'SUCCESS',
  'FAILED',
  'SKIPPED',
  'UNKNOWN',
]);

/** 非法迁移错误 */
export class IllegalTransitionError extends Error {
  constructor(
    public from: TaskStatus,
    public to: TaskStatus,
  ) {
    super(`非法任务状态迁移: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** 一次状态迁移记录（时间 + 证据） */
export interface StateTransitionRecord {
  from: TaskStatus;
  to: TaskStatus;
  at: string;
  evidence?: string;
}

/** 任务运行时状态（内存态，checkpoint 由调用方持久化） */
export interface TaskStateMachine {
  taskId: string;
  attemptId: string;
  status: TaskStatus;
  history: StateTransitionRecord[];
}

/**
 * 判断迁移是否合法
 * @param from 源状态
 * @param to 目标状态
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/**
 * 判断是否为终态
 * @param status 状态
 */
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * 创建任务状态机实例
 * @param taskId 任务 ID
 * @param attemptId 尝试 ID（幂等 key）
 * @param initial 初始状态（默认 PENDING；恢复场景可传入持久化状态）
 * @param history 已有迁移历史（恢复场景）
 */
export function createTaskStateMachine(
  taskId: string,
  attemptId: string,
  initial: TaskStatus = 'PENDING',
  history: StateTransitionRecord[] = [],
): TaskStateMachine {
  return { taskId, attemptId, status: initial, history: [...history] };
}

/**
 * 执行状态迁移（非法迁移抛 IllegalTransitionError）
 * @param sm 状态机
 * @param to 目标状态
 * @param evidence 证据（DOM 探针/接口响应摘要等）
 */
export function transition(
  sm: TaskStateMachine,
  to: TaskStatus,
  evidence?: string,
): TaskStateMachine {
  if (!canTransition(sm.status, to)) {
    throw new IllegalTransitionError(sm.status, to);
  }
  sm.history.push({ from: sm.status, to, at: new Date().toISOString(), evidence });
  sm.status = to;
  return sm;
}

/**
 * 验证场景恢复时的安全回退阶段（规范 §5.5）：
 * 可明确判断未提交则从安全阶段继续；无法判断则转 UNKNOWN
 * @param stageAtInterruption 中断时阶段
 */
export function recoveryTargetStage(
  stageAtInterruption: TaskStatus,
): TaskStatus | 'UNKNOWN' {
  switch (stageAtInterruption) {
    case 'LEASED':
    case 'NAVIGATING':
      return 'NAVIGATING';
    case 'PAGE_READY':
      return 'PAGE_READY';
    case 'SUBMITTING':
    case 'SUBMITTED':
      // 提交中断无法判断是否已点击成功，必须先核对 ERP；无法核对则 UNKNOWN
      return 'UNKNOWN';
    default:
      return 'NAVIGATING';
  }
}

/**
 * 生成幂等 key（attempt_id / event_id）
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

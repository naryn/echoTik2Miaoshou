/**
 * 任务状态机迁移合法性单测（规范 §5.3）
 */
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  createTaskStateMachine,
  IllegalTransitionError,
  isTerminal,
  recoveryTargetStage,
  transition,
} from '../src/modules/runner/state-machine';

describe('状态机迁移合法性', () => {
  it('正常路径 PENDING→LEASED→NAVIGATING→PAGE_READY→SUBMITTING→SUBMITTED→SUCCESS', () => {
    const sm = createTaskStateMachine('task_1', 'attempt_1');
    transition(sm, 'LEASED');
    transition(sm, 'NAVIGATING');
    transition(sm, 'PAGE_READY');
    transition(sm, 'SUBMITTING');
    transition(sm, 'SUBMITTED');
    transition(sm, 'SUCCESS');
    expect(sm.status).toBe('SUCCESS');
    expect(sm.history).toHaveLength(6);
    expect(sm.history[0]?.from).toBe('PENDING');
    expect(sm.history[5]?.to).toBe('SUCCESS');
  });

  it('非法迁移抛 IllegalTransitionError（PENDING→SUCCESS 跳跃）', () => {
    const sm = createTaskStateMachine('task_1', 'attempt_1');
    expect(() => transition(sm, 'SUCCESS')).toThrow(IllegalTransitionError);
    expect(canTransition('PENDING', 'SUBMITTING')).toBe(false);
  });

  it('终态不可再迁移', () => {
    const sm = createTaskStateMachine('task_1', 'attempt_1', 'SUCCESS');
    expect(isTerminal('SUCCESS')).toBe(true);
    expect(() => transition(sm, 'NAVIGATING')).toThrow(IllegalTransitionError);
  });

  it('验证路径：NAVIGATING→WAITING_VERIFICATION→RECOVERING→NAVIGATING', () => {
    const sm = createTaskStateMachine('task_1', 'attempt_1', 'NAVIGATING');
    transition(sm, 'WAITING_VERIFICATION', 'challenge iframe');
    transition(sm, 'RECOVERING', '验证消失');
    transition(sm, 'NAVIGATING');
    expect(sm.status).toBe('NAVIGATING');
  });

  it('SUBMITTED 不能直接进入 SUCCESS 以外的非法状态（允许 SUCCESS/FAILED/UNKNOWN/WAITING_VERIFICATION）', () => {
    expect(canTransition('SUBMITTED', 'SUCCESS')).toBe(true);
    expect(canTransition('SUBMITTED', 'UNKNOWN')).toBe(true);
    expect(canTransition('SUBMITTED', 'PAGE_READY')).toBe(false);
  });

  it('恢复目标阶段：提交中断无法判定 → UNKNOWN', () => {
    expect(recoveryTargetStage('SUBMITTING')).toBe('UNKNOWN');
    expect(recoveryTargetStage('SUBMITTED')).toBe('UNKNOWN');
    expect(recoveryTargetStage('NAVIGATING')).toBe('NAVIGATING');
    expect(recoveryTargetStage('PAGE_READY')).toBe('PAGE_READY');
  });

  it('迁移历史记录时间与证据', () => {
    const sm = createTaskStateMachine('task_1', 'attempt_1');
    transition(sm, 'LEASED', 'claim ok');
    expect(sm.history[0]?.evidence).toBe('claim ok');
    expect(sm.history[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

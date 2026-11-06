/**
 * 本地存储层：
 * 1. chrome.storage.local 类型化封装（客户端身份、运行检查点、Widget 偏好等少量持久状态）
 * 2. IndexedDB 轻量封装（recent_products / snapshot_previews / outbox_events / recent_task_checks / ui_cached_queries）
 */
import { browser } from 'wxt/browser';
import type {
  BehaviorConfig,
  CategoryNode,
  ClientIdentity,
  ExecConfig,
  FilterPreset,
  RunnerCheckpoint,
} from '@/shared/types';
import { DEFAULT_BEHAVIOR_CONFIG, DEFAULT_EXEC_CONFIG } from '@/shared/types';

/** chrome.storage.local 键名与默认值表（类型化 schema） */
export const STORAGE_DEFAULTS = {
  install_id: null as string | null,
  client_id: null as string | null,
  client_token: null as string | null,
  server_url: 'http://localhost:8001' as string,
  registered_at: null as string | null,
  worker_tab_id: null as number | null,
  active_batch_id: null as string | null,
  active_task_id: null as string | null,
  runner_checkpoint: null as RunnerCheckpoint | null,
  widget_preferences_by_origin: {} as Record<
    string,
    { x?: number; y?: number; collapsed?: boolean; hidden?: boolean }
  >,
  last_filters: {} as Record<string, unknown>,
  recovery_check_at: null as string | null,
  extension_version: null as string | null,
  /** EchoTik 类目树缓存（background 抓取，减少页面请求） */
  category_cache: null as { items: CategoryNode[]; fetched_at: string } | null,
  /** 英文类目树缓存（仅用于把旧记录里的英文类目名映射为中文） */
  category_cache_en: null as { items: CategoryNode[]; fetched_at: string } | null,
  /** FastMoss 一级类目缓存，与 EchoTik 类目树严格分离。 */
  fastmoss_category_cache: null as { items: CategoryNode[]; fetched_at: string } | null,
  /** 榜单筛选预设 */
  filter_presets: [] as FilterPreset[],
  /** 执行参数（规范 §3.7） */
  exec_config: DEFAULT_EXEC_CONFIG as ExecConfig,
  /** 行为配置（规范 §3.7） */
  behavior_config: DEFAULT_BEHAVIOR_CONFIG as BehaviorConfig,
  /** 插件设置填写的认证 Token（Bearer；为空表示未授权，不能使用插件） */
  auth_token: null as string | null,
  /** 认证账号角色（由 /v1/auth/me 返回，USER/ADMIN） */
  identity_role: null as string | null,
  /** 认证账号显示名 */
  identity_display_name: null as string | null,
};

export type StorageKey = keyof typeof STORAGE_DEFAULTS;
export type StorageSchema = typeof STORAGE_DEFAULTS;

/**
 * 读取单个存储键（带默认值）
 * @param key 键名
 */
export async function storageGet<K extends StorageKey>(key: K): Promise<StorageSchema[K]> {
  const res = await browser.storage.local.get(key);
  return (res[key] as StorageSchema[K]) ?? STORAGE_DEFAULTS[key];
}

/**
 * 写入单个存储键
 * @param key 键名
 * @param value 值
 */
export async function storageSet<K extends StorageKey>(
  key: K,
  value: StorageSchema[K],
): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

/**
 * 批量读取存储键
 * @param keys 键名列表
 */
export async function storageGetMany<K extends StorageKey>(
  keys: K[],
): Promise<Pick<StorageSchema, K>> {
  const res = await browser.storage.local.get(keys);
  const out = {} as Pick<StorageSchema, K>;
  for (const k of keys) {
    out[k] = (res[k] as StorageSchema[K]) ?? STORAGE_DEFAULTS[k];
  }
  return out;
}

/**
 * 读取客户端身份（聚合多个键）
 */
export async function loadClientIdentity(): Promise<ClientIdentity> {
  const s = await storageGetMany([
    'install_id',
    'client_id',
    'client_token',
    'server_url',
    'registered_at',
  ]);
  return { ...s };
}

/**
 * 保存客户端身份
 * @param id 身份信息
 */
export async function saveClientIdentity(id: Partial<ClientIdentity>): Promise<void> {
  await browser.storage.local.set(id);
}

// ---------------- IndexedDB ----------------

const DB_NAME = 'echotik_miaoshou_collector';
/** v3：移除本地商品库（商品列表统一改读服务端） */
const DB_VERSION = 3;

/** IndexedDB store 名称枚举 */
export const IDB_STORES = [
  'recent_products',
  'snapshot_previews',
  'outbox_events',
  'recent_task_checks',
  'ui_cached_queries',
] as const;
export type IdbStore = (typeof IDB_STORES)[number];

/** outbox 事件记录 */
export interface OutboxEvent {
  event_id: string;
  kind: 'task_event' | 'task_result' | 'snapshot_entries' | 'heartbeat';
  priority: number; // 数值越小优先级越高：结果 0 > 进度 1 > 榜单 2
  payload: Record<string, unknown>;
  created_at: string;
  retries: number;
  status: 'pending' | 'sending' | 'failed';
}

/**
 * 打开（并按需初始化）IndexedDB
 */
export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // 迁移：商品数据统一改为读取服务端，清理历史版本遗留的本地商品库
      if (db.objectStoreNames.contains('local_products')) {
        db.deleteObjectStore('local_products');
      }
      for (const store of IDB_STORES) {
        if (!db.objectStoreNames.contains(store)) {
          if (store === 'outbox_events') {
            const os = db.createObjectStore(store, { keyPath: 'event_id' });
            os.createIndex('by_priority', ['status', 'priority', 'created_at']);
          } else {
            db.createObjectStore(store, { keyPath: 'id' });
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 在指定 store 执行事务操作
 * @param store store 名
 * @param mode 事务模式
 * @param fn 操作函数
 */
async function withStore<T>(
  store: IdbStore,
  mode: IDBTransactionMode,
  fn: (os: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * 写入/更新一条记录（upsert）
 * @param store store 名
 * @param value 记录
 */
export function idbPut<T>(store: IdbStore, value: T): Promise<IDBValidKey> {
  return withStore(store, 'readwrite', (os) => os.put(value as never));
}

/**
 * 按键读取记录
 * @param store store 名
 * @param key 主键
 */
export function idbGet<T>(store: IdbStore, key: IDBValidKey): Promise<T | undefined> {
  return withStore(store, 'readonly', (os) => os.get(key)) as Promise<T | undefined>;
}

/**
 * 删除记录
 * @param store store 名
 * @param key 主键
 */
export function idbDelete(store: IdbStore, key: IDBValidKey): Promise<undefined> {
  return withStore(store, 'readwrite', (os) => os.delete(key));
}

/**
 * 读取 store 全部记录
 * @param store store 名
 */
export function idbGetAll<T>(store: IdbStore): Promise<T[]> {
  return withStore(store, 'readonly', (os) => os.getAll()) as Promise<T[]>;
}

/**
 * outbox 入队（幂等：同 event_id 覆盖）
 * @param ev 事件
 */
export function outboxEnqueue(ev: OutboxEvent): Promise<IDBValidKey> {
  return idbPut('outbox_events', ev);
}

/**
 * 读取待发送 outbox 事件并按优先级排序（结果 > 进度 > 榜单）
 */
export async function outboxPending(): Promise<OutboxEvent[]> {
  const all = await idbGetAll<OutboxEvent>('outbox_events');
  return all
    .filter((e) => e.status === 'pending' || e.status === 'failed')
    .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
}

/**
 * 上报成功后删除 outbox 事件
 * @param eventId 事件 ID
 */
export function outboxAck(eventId: string): Promise<undefined> {
  return idbDelete('outbox_events', eventId);
}

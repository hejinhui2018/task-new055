import type { ConsoleState, PersistedConsole } from './types'

/**
 * 刷新恢复：把状态快照序列化到浏览器存储。
 *
 * 设计约束：
 *  - 只持久化“事实层”（片段 / 去重记录 / 冲突 / 日志 / 术语表 / 术语版本）；
 *  - 扫描缓存 scans 是派生数据，不持久化，hydrate 时按当前文本与术语表重建；
 *  - 撤销 / 重做栈属于本会话操作历史，不跨刷新保留；
 *  - Storage 可注入（测试用内存 Map，生产用 localStorage），任何解析失败都安全回退。
 */

export const STORAGE_KEY = 'subtitle-qc-console:snapshot:v1'
const STORAGE_VERSION = 1

interface PersistedEnvelope {
  v: number
  snapshot: PersistedConsole
}

export interface PersistResult {
  ok: boolean
  reason?: string
}

function toSnapshot(state: ConsoleState): PersistedConsole {
  const { past: _past, future: _future, scans: _scans, ...core } = state
  return core
}

export function persistState(
  state: ConsoleState,
  storage: Storage = window.localStorage,
  key: string = STORAGE_KEY,
): PersistResult {
  try {
    const envelope: PersistedEnvelope = { v: STORAGE_VERSION, snapshot: toSnapshot(state) }
    storage.setItem(key, JSON.stringify(envelope))
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export function loadSnapshot(
  storage: Storage = window.localStorage,
  key: string = STORAGE_KEY,
): PersistedConsole | null {
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const envelope = JSON.parse(raw) as Partial<PersistedEnvelope>
    if (envelope.v !== STORAGE_VERSION || !envelope.snapshot) return null
    const snap = envelope.snapshot as PersistedConsole
    // 形态校验：至少要像一个控制台快照，避免脏数据把状态层带坏
    if (
      typeof snap !== 'object' ||
      snap === null ||
      typeof snap.segments !== 'object' ||
      typeof snap.terms !== 'object' ||
      typeof snap.termVersion !== 'number'
    ) {
      return null
    }
    return snap
  } catch {
    return null
  }
}

export function clearPersisted(
  storage: Storage = window.localStorage,
  key: string = STORAGE_KEY,
): void {
  try {
    storage.removeItem(key)
  } catch {
    // 存储不可用时无需处理
  }
}

/** 测试用内存 Storage，行为对齐 localStorage 的最小子集 */
export function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => {
      map.delete(k)
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v))
    },
  }
}

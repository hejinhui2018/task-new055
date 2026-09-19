import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storage } from '../storage'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

describe('刷新恢复（localStorage 持久化与迁移）', () => {
  let memory: MemoryStorage
  beforeEach(() => {
    memory = new MemoryStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: memory, configurable: true })
  })
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
  })

  it('控制台状态存取往返一致', () => {
    expect(storage.loadConsole()).toBeNull()
    const state = {
      segments: {
        1: {
          seq: 1,
          text: '《晚间新闻》',
          version: 1,
          origin: 'manual' as const,
          locked: false,
          glossaryApplied: ['t@1'],
          appliedTargets: { t: ['《晚间新闻》'] },
        },
      },
      seenEventIds: { e1: true as const },
      conflicts: [],
      log: [],
      nextLogId: 2,
      past: [],
      future: [],
    }
    storage.saveConsole(state)
    expect(storage.loadConsole()).toEqual(state)
  })

  it('旧版本持久化（缺少 past/future/glossaryApplied/appliedTargets）迁移后字段补齐', () => {
    memory.setItem(
      'subtitle-qc:console:v1',
      JSON.stringify({
        segments: { 7: { seq: 7, text: '旧稿', version: 1, origin: 'machine', locked: true } },
        seenEventIds: {},
        conflicts: [],
        log: [],
        nextLogId: 1,
      }),
    )
    const migrated = storage.loadConsole()
    expect(migrated).not.toBeNull()
    expect(migrated!.past).toEqual([])
    expect(migrated!.future).toEqual([])
    expect(migrated!.segments[7].glossaryApplied).toEqual([])
    expect(migrated!.segments[7].appliedTargets).toEqual({})
    expect(migrated!.segments[7].locked).toBe(true)
  })

  it('损坏 JSON / 非法结构安全回退为 null，不抛异常', () => {
    memory.setItem('subtitle-qc:console:v1', '{不是 json')
    expect(storage.loadConsole()).toBeNull()
    memory.setItem('subtitle-qc:console:v1', JSON.stringify({ segments: null }))
    expect(storage.loadConsole()).toBeNull()
    memory.setItem('subtitle-qc:glossary:v1', JSON.stringify({ terms: {} })) // 缺 order
    expect(storage.loadGlossary()).toBeNull()
  })
})

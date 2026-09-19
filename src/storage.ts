/**
 * 极简本地持久化：刷新页面后恢复控制台与术语表状态。
 * 纯 JSON 读写，任何损坏/版本不符都安全回退到初始状态；
 * 旧版本持久化的状态经过迁移补齐新字段，避免 undefined 访问。
 */

import type { ConsoleState, GlossaryHistoryEntry, SubtitleSegment } from './types'
import type { GlossaryState } from './glossaryReducer'

const CONSOLE_KEY = 'subtitle-qc:console:v1'
const GLOSSARY_KEY = 'subtitle-qc:glossary:v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function migrateHistoryChange(
  change: Record<string, unknown>,
): GlossaryHistoryEntry['changes'][number] {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return {
    seq: typeof change.seq === 'number' ? change.seq : -1,
    before: str(change.before),
    after: str(change.after),
    beforeApplied: strArr(change.beforeApplied),
    afterApplied: strArr(change.afterApplied),
    beforeTargets: isRecord(change.beforeTargets) ? (change.beforeTargets as Record<string, string[]>) : {},
    afterTargets: isRecord(change.afterTargets) ? (change.afterTargets as Record<string, string[]>) : {},
  }
}

function migrateConsole(raw: unknown): ConsoleState | null {
  if (!isRecord(raw) || !isRecord(raw.segments)) return null
  const segments: Record<number, SubtitleSegment> = {}
  for (const [key, value] of Object.entries(raw.segments)) {
    if (!isRecord(value) || typeof value.text !== 'string') continue
    const seq = Number(key)
    if (!Number.isFinite(seq)) continue
    segments[seq] = {
      seq: typeof value.seq === 'number' ? value.seq : seq,
      text: value.text,
      version: typeof value.version === 'number' ? value.version : 1,
      origin: value.origin === 'manual' ? 'manual' : 'machine',
      locked: value.locked === true,
      speaker: typeof value.speaker === 'string' ? value.speaker : undefined,
      glossaryApplied: Array.isArray(value.glossaryApplied) ? (value.glossaryApplied as string[]) : [],
      appliedTargets: isRecord(value.appliedTargets)
        ? (value.appliedTargets as Record<string, string[]>)
        : {},
    }
  }
  const migrateStack = (stack: unknown): GlossaryHistoryEntry[] => {
    if (!Array.isArray(stack)) return []
    return stack
      .filter(isRecord)
      .map((entry) => ({
        changes: Array.isArray(entry.changes)
          ? entry.changes
              .filter(isRecord)
              .map(migrateHistoryChange)
              .filter((change) => change.seq >= 0)
          : [],
        termRefs: Array.isArray(entry.termRefs) ? (entry.termRefs as string[]) : [],
        count: typeof entry.count === 'number' ? entry.count : 0,
      }))
      .filter((entry) => entry.changes.length > 0)
  }
  return {
    segments,
    seenEventIds: isRecord(raw.seenEventIds) ? (raw.seenEventIds as Record<string, true>) : {},
    conflicts: Array.isArray(raw.conflicts) ? (raw.conflicts as ConsoleState['conflicts']) : [],
    log: Array.isArray(raw.log) ? (raw.log as ConsoleState['log']) : [],
    nextLogId: typeof raw.nextLogId === 'number' ? raw.nextLogId : 1,
    past: migrateStack(raw.past),
    future: migrateStack(raw.future),
  }
}

function migrateGlossary(raw: unknown): GlossaryState | null {
  if (!isRecord(raw) || !isRecord(raw.terms) || !Array.isArray(raw.order)) return null
  const terms = raw.terms as GlossaryState['terms']
  for (const id of raw.order as unknown[]) {
    const entry = terms[String(id)]
    if (!entry || !isRecord(entry.term) || typeof entry.version !== 'number') return null
  }
  return {
    terms,
    order: raw.order as string[],
    nextTermSeq: typeof raw.nextTermSeq === 'number' ? raw.nextTermSeq : raw.order.length + 1,
    past: Array.isArray(raw.past) ? (raw.past as GlossaryState['past']) : [],
    future: Array.isArray(raw.future) ? (raw.future as GlossaryState['future']) : [],
  }
}

function load<T>(key: string, migrate: (raw: unknown) => T | null): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return migrate(JSON.parse(raw))
  } catch {
    return null
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 隐私模式/配额不足：静默放弃持久化，不影响内存中的校对流程
  }
}

export const storage = {
  loadConsole: () => load(CONSOLE_KEY, migrateConsole),
  saveConsole: (state: ConsoleState) => save(CONSOLE_KEY, state),
  loadGlossary: () => load(GLOSSARY_KEY, migrateGlossary),
  saveGlossary: (state: GlossaryState) => save(GLOSSARY_KEY, state),
}

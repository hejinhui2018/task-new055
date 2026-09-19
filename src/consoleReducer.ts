import { scanSegment } from './termScan'
import type {
  Conflict,
  ConsoleSnapshot,
  ConsoleState,
  LogKind,
  PersistedConsole,
  SubtitleEvent,
  SubtitleSegment,
  Term,
  TermDraft,
  TermMatch,
} from './types'

/**
 * 控制台状态机：纯函数，不读时钟、不含随机性。
 * 相同的初始状态 + 相同的动作序列 => 完全相同的结果（可稳定重放）。
 */

export type ConsoleAction =
  | { type: 'ingest'; event: SubtitleEvent; receivedAt: number | null }
  | { type: 'edit'; seq: number; text: string }
  | { type: 'toggle-lock'; seq: number }
  | { type: 'resolve-conflict'; seq: number; choice: 'keep' | 'accept' }
  | { type: 'term-upsert'; draft: TermDraft }
  | { type: 'term-delete'; id: string }
  | { type: 'term-toggle'; id: string }
  | { type: 'terms-apply'; keys: string[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'hydrate'; snapshot: PersistedConsole }
  | { type: 'reset' }

/** 撤销历史最多保留的人工操作步数 */
const MAX_PAST = 50

/** 可选预置术语表（App 启动时注入节目默认术语 / 持久化恢复的数据由 hydrate 注入） */
export interface InitialPreset {
  terms: Term[]
  termVersion: number
}

export function createInitialState(preset?: InitialPreset): ConsoleState {
  const terms: Record<string, Term> = {}
  for (const term of preset?.terms ?? []) terms[term.id] = term
  return {
    segments: {},
    seenEventIds: {},
    conflicts: [],
    log: [],
    nextLogId: 1,
    terms,
    termVersion: preset?.termVersion ?? 0,
    scans: {},
    past: [],
    future: [],
  }
}

/** 事件流最多保留的条数，防止长时间运行无限增长 */
const MAX_LOG_ENTRIES = 200

function withLog(
  state: ConsoleState,
  kind: LogKind,
  seq: number | null,
  at: number | null,
  message: string,
): ConsoleState {
  const entry = { id: state.nextLogId, kind, seq, at, message }
  return {
    ...state,
    log: [...state.log, entry].slice(-MAX_LOG_ENTRIES),
    nextLogId: state.nextLogId + 1,
  }
}

/** 去掉撤销/重做栈，得到可压栈 / 可持久化的纯快照 */
function snapshot(state: ConsoleState): ConsoleSnapshot {
  const { past: _past, future: _future, ...core } = state
  return core
}

/** 进入撤销历史的人工操作：字幕编辑、锁定、冲突裁决、术语维护、接受建议 */
const HISTORICAL_ACTIONS = new Set<ConsoleAction['type']>([
  'edit',
  'toggle-lock',
  'resolve-conflict',
  'term-upsert',
  'term-delete',
  'term-toggle',
  'terms-apply',
])

export function consoleReducer(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case 'undo': {
      const prev = state.past[state.past.length - 1]
      if (!prev) return state
      return {
        ...prev,
        past: state.past.slice(0, -1),
        future: [snapshot(state), ...state.future].slice(0, MAX_PAST),
      }
    }
    case 'redo': {
      const next = state.future[0]
      if (!next) return state
      return {
        ...next,
        past: [...state.past, snapshot(state)].slice(-MAX_PAST),
        future: state.future.slice(1),
      }
    }
    case 'hydrate': {
      // 刷新恢复：载入事实层快照后重建全部扫描缓存（派生数据不信任缓存值），
      // 撤销/重做属于本会话操作，不跨刷新保留。
      const restored: ConsoleState = { ...action.snapshot, scans: {}, past: [], future: [] }
      return rescanAll(restored)
    }
    case 'reset': {
      // 重放必须清空字幕侧的一切痕迹；术语表是节目配置（运营资产），跨重放保留。
      // 无术语时结果与 createInitialState() 逐位相等（原有“无残留重放”保证不变）。
      return {
        ...createInitialState(),
        terms: state.terms,
        termVersion: state.termVersion,
      }
    }
  }

  const next = reduceWithTerms(state, action)
  if (next !== state && HISTORICAL_ACTIONS.has(action.type)) {
    // 人工操作生效：把操作前状态压入撤销栈，重做栈失效
    return { ...next, past: [...state.past, snapshot(state)].slice(-MAX_PAST), future: [] }
  }
  return next
}

function activeTerms(state: ConsoleState): Term[] {
  return Object.values(state.terms)
    .filter((t) => t.enabled)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** 重算单条片段的扫描缓存 */
function rescanOne(state: ConsoleState, seq: number): ConsoleState {
  const seg = state.segments[seq]
  if (!seg) return state
  const scan = scanSegment(seg, activeTerms(state), state.termVersion)
  return { ...state, scans: { ...state.scans, [seq]: scan } }
}

/** 术语表变化后全量重算：旧建议（旧 termVersion 的缓存）整体失效 */
function rescanAll(state: ConsoleState): ConsoleState {
  const terms = activeTerms(state)
  const scans: ConsoleState['scans'] = {}
  for (const seg of Object.values(state.segments)) {
    scans[seg.seq] = scanSegment(seg, terms, state.termVersion)
  }
  return { ...state, scans }
}

interface MatchStats {
  auto: number
  locked: number
  homophone: number
  notApplicable: number
}

function matchStats(state: ConsoleState): MatchStats {
  const stats: MatchStats = { auto: 0, locked: 0, homophone: 0, notApplicable: 0 }
  for (const scan of Object.values(state.scans)) {
    for (const m of scan.matches) {
      if (m.kind === 'auto') stats.auto += 1
      else if (m.kind === 'locked-conflict') stats.locked += 1
      else if (m.kind === 'homophone') stats.homophone += 1
      else stats.notApplicable += 1
    }
  }
  return stats
}

/** 按完整 key（`${seq}::${termId}@${termVersion}`）查找建议；
 * 术语版本变化后旧 key 在任何缓存中都找不到，天然失效。 */
export function findMatch(state: ConsoleState, key: string): TermMatch | undefined {
  for (const scan of Object.values(state.scans)) {
    const hit = scan.matches.find((m) => m.key === key)
    if (hit) return hit
  }
  return undefined
}

function reduceWithTerms(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case 'ingest':
      return ingest(state, action.event, action.receivedAt)

    case 'edit': {
      const seg = state.segments[action.seq]
      if (!seg || seg.locked) return state // 锁定片段不可直接编辑，需先解锁
      const text = action.text.trim()
      if (!text || text === seg.text) return state
      const next: SubtitleSegment = { ...seg, text, origin: 'manual' }
      let s: ConsoleState = { ...state, segments: { ...state.segments, [action.seq]: next } }
      s = rescanOne(s, action.seq)
      return withLog(s, 'manual', action.seq, null, `人工修改 #${action.seq}：「${text}」`)
    }

    case 'toggle-lock': {
      const seg = state.segments[action.seq]
      if (!seg) return state
      const locked = !seg.locked
      let s: ConsoleState = {
        ...state,
        segments: { ...state.segments, [action.seq]: { ...seg, locked } },
      }
      // 锁定态直接改变建议分类（auto ↔ 人工锁定冲突），必须重算
      s = rescanOne(s, action.seq)
      return withLog(
        s,
        'lock',
        action.seq,
        null,
        locked
          ? `已锁定 #${action.seq}，后续机器修订将转入人工裁决`
          : `已解锁 #${action.seq}，机器修订将直接应用`,
      )
    }

    case 'resolve-conflict': {
      const conflict = state.conflicts.find((c) => c.seq === action.seq)
      if (!conflict) return state
      const seg = state.segments[action.seq]
      const conflicts = state.conflicts.filter((c) => c.seq !== action.seq)
      if (action.choice === 'keep') {
        // 保留人工版本：片段原样不动，仅丢弃这条机器修订
        const s = { ...state, conflicts }
        return withLog(
          s,
          'resolved',
          action.seq,
          null,
          `保留人工版本，忽略机器修订 v${conflict.incomingVersion}（#${action.seq}）`,
        )
      }
      // 接受机器版本：应用新内容并解除锁定，片段交还给机器流
      if (!seg) return { ...state, conflicts }
      const next: SubtitleSegment = {
        ...seg,
        text: conflict.incomingText,
        version: conflict.incomingVersion,
        origin: 'machine',
        locked: false,
        // 机器新稿是一份全新文本：旧的术语应用记录不再抑制对新稿的建议
        appliedTerms: {},
      }
      let s: ConsoleState = {
        ...state,
        conflicts,
        segments: { ...state.segments, [action.seq]: next },
      }
      s = rescanOne(s, action.seq)
      return withLog(
        s,
        'resolved',
        action.seq,
        null,
        `接受机器修订 v${conflict.incomingVersion}（#${action.seq}），片段解除锁定`,
      )
    }

    case 'term-upsert':
      return upsertTerm(state, action.draft)

    case 'term-delete':
      return deleteTerm(state, action.id)

    case 'term-toggle':
      return toggleTerm(state, action.id)

    case 'terms-apply':
      return applyTerms(state, action.keys)

    // undo / redo / hydrate / reset 已在外层处理
    default:
      return state
  }
}

function normBound(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  return Number.isFinite(value) ? value : undefined
}

function normList(values: string[] | undefined): string[] | undefined {
  const out = (values ?? []).map((v) => v.trim()).filter(Boolean)
  return out.length > 0 ? Array.from(new Set(out)) : undefined
}

function upsertTerm(state: ConsoleState, draft: TermDraft): ConsoleState {
  const source = draft.source.trim()
  const target = draft.target.trim()
  if (!source || !target) return state

  const exists = draft.id !== undefined && !!state.terms[draft.id]
  const version = state.termVersion + 1
  const id = exists ? draft.id! : `term-${version}`
  const term: Term = {
    id,
    version,
    source,
    target,
    lang: draft.lang?.trim() || undefined,
    speakers: normList(draft.speakers),
    validFromMs: normBound(draft.validFromMs),
    validToMs: normBound(draft.validToMs),
    homophones: normList(draft.homophones),
    enabled: draft.enabled ?? true,
  }

  let s: ConsoleState = {
    ...state,
    terms: { ...state.terms, [id]: term },
    termVersion: version,
  }
  // 术语版本变化：旧建议全部失效，按新版本全量重新计算
  s = rescanAll(s)
  const stats = matchStats(s)
  return withLog(
    s,
    'term',
    null,
    null,
    `${exists ? '更新' : '新增'}术语「${source}→${target}」v${version}，旧建议已失效并全量重扫：` +
      `可自动建议 ${stats.auto} 条、锁定冲突 ${stats.locked} 条、同音歧义 ${stats.homophone} 条、不适用 ${stats.notApplicable} 条`,
  )
}

function deleteTerm(state: ConsoleState, id: string): ConsoleState {
  const term = state.terms[id]
  if (!term) return state
  const terms = { ...state.terms }
  delete terms[id]
  let s: ConsoleState = { ...state, terms, termVersion: state.termVersion + 1 }
  s = rescanAll(s)
  return withLog(
    s,
    'term',
    null,
    null,
    `删除术语「${term.source}→${term.target}」（原 v${term.version}），相关建议已全部失效`,
  )
}

function toggleTerm(state: ConsoleState, id: string): ConsoleState {
  const old = state.terms[id]
  if (!old) return state
  const version = state.termVersion + 1
  const term: Term = { ...old, enabled: !old.enabled, version }
  let s: ConsoleState = {
    ...state,
    terms: { ...state.terms, [id]: term },
    termVersion: version,
  }
  s = rescanAll(s)
  return withLog(
    s,
    'term',
    null,
    null,
    `术语「${term.source}→${term.target}」已${term.enabled ? '启用' : '停用'}（v${version}），建议已重新计算`,
  )
}

function applyTerms(state: ConsoleState, keys: string[]): ConsoleState {
  // 解析出全部仍然有效的自动建议（key 内嵌术语版本：
  // 锁定冲突 / 同音歧义 / 不适用 / 已随版本变化失效的旧 key 一律忽略）
  const jobs = Array.from(new Set(keys))
    .map((key) => findMatch(state, key))
    .filter((m): m is TermMatch => !!m && m.kind === 'auto')
  if (jobs.length === 0) return state

  // 按片段聚合采纳区间。同一片段的多个 auto 建议在扫描仲裁中保证区间互不重叠，
  // 因此可以一次性从后往前拼接，避免逐条替换导致的位置漂移与顺序问题。
  const bySeq = new Map<number, TermMatch[]>()
  for (const job of jobs) {
    const list = bySeq.get(job.seq) ?? []
    list.push(job)
    bySeq.set(job.seq, list)
  }

  let s = state
  const applied: Array<{ seq: number; term: Term }> = []
  for (const seq of Array.from(bySeq.keys()).sort((a, b) => a - b)) {
    const seg = s.segments[seq]
    if (!seg) continue

    interface Piece {
      start: number
      end: number
      source: string
      target: string
      termId: string
      termVersion: number
    }
    const pieces: Piece[] = []
    for (const m of bySeq.get(seq)!) {
      const term = s.terms[m.termId]
      if (!term) continue
      for (const [start, end] of m.acceptedRanges ?? []) {
        if (seg.text.slice(start, end) !== term.source) continue // 兜底：区间必须确实是原词
        pieces.push({ start, end, source: term.source, target: term.target, termId: term.id, termVersion: term.version })
      }
    }
    if (pieces.length === 0) continue

    // 区间互不重叠，按起点倒序逐个拼接（同区间去重，防止外部传入重复 key）
    const seenRanges = new Set<string>()
    const dedup = pieces
      .sort((a, b) => b.start - a.start)
      .filter((p) => {
        const mark = `${p.start}:${p.end}`
        if (seenRanges.has(mark)) return false
        seenRanges.add(mark)
        return true
      })
    let nextText = seg.text
    const appliedTerms = { ...seg.appliedTerms }
    const touchedTerms: Term[] = []
    for (const p of dedup) {
      nextText = nextText.slice(0, p.start) + p.target + nextText.slice(p.end)
      appliedTerms[p.termId] = p.termVersion
      const term = s.terms[p.termId]
      if (term && !touchedTerms.some((t) => t.id === term.id)) touchedTerms.push(term)
    }
    if (nextText === seg.text) continue // 兜底幂等

    const next: SubtitleSegment = { ...seg, text: nextText, origin: 'manual', appliedTerms }
    s = { ...s, segments: { ...s.segments, [seq]: next } }
    s = rescanOne(s, seq)
    for (const term of touchedTerms) applied.push({ seq, term })
  }

  if (applied.length === 0) return state

  const seqs = Array.from(new Set(applied.map((a) => a.seq))).sort((a, b) => a - b)
  const message =
    applied.length === 1
      ? `接受术语建议：#${applied[0].seq}「${applied[0].term.source}→${applied[0].term.target}」`
      : `批量接受 ${applied.length} 条术语建议（片段 #${seqs.join('、#')}），可随时撤销`
  return withLog(s, 'term-apply', null, null, message)
}

function ingest(
  state: ConsoleState,
  event: SubtitleEvent,
  receivedAt: number | null,
): ConsoleState {
  // 1) 事件级去重：同一事件 ID 只处理一次
  if (state.seenEventIds[event.id]) {
    return withLog(
      state,
      'duplicate',
      event.seq,
      receivedAt,
      `重复事件 ${event.id}（#${event.seq} v${event.version}）已忽略，未生成新字幕`,
    )
  }
  const seenEventIds = { ...state.seenEventIds, [event.id]: true as const }
  const existing = state.segments[event.seq]

  // 2) 全新片段：直接落位；若序号小于已收到的最大序号，说明是晚到补齐
  if (!existing) {
    const seg: SubtitleSegment = {
      seq: event.seq,
      text: event.text,
      version: event.version,
      origin: 'machine',
      locked: false,
      speaker: event.speaker,
      lang: event.lang,
      startMs: event.startMs,
      endMs: event.endMs,
    }
    let s: ConsoleState = {
      ...state,
      seenEventIds,
      segments: { ...state.segments, [event.seq]: seg },
    }
    // 增量扫描：只扫描这一条新片段（晚到片段也只检查与它相关的术语），不重扫全表
    s = rescanOne(s, event.seq)
    const keys = Object.keys(state.segments)
    const maxSeq = keys.length > 0 ? Math.max(...keys.map(Number)) : null
    const isBackfill = maxSeq !== null && event.seq < maxSeq
    s = withLog(s, 'received', event.seq, receivedAt, `接收 #${event.seq} v${event.version}：「${event.text}」`)
    if (isBackfill) {
      s = withLog(s, 'backfilled', event.seq, receivedAt, `晚到片段 #${event.seq} 已自动补回缺口，并增量扫描术语`)
    }
    return s
  }

  const s0: ConsoleState = { ...state, seenEventIds }

  // 3) 已有片段：按版本号裁决
  if (event.version < existing.version) {
    return withLog(
      s0,
      'stale',
      event.seq,
      receivedAt,
      `过期版本 v${event.version}（当前 v${existing.version}）已忽略（#${event.seq}）`,
    )
  }
  if (event.version === existing.version) {
    if (event.text === existing.text) {
      // 内容级去重：不同事件 ID 但内容完全相同
      return withLog(s0, 'duplicate', event.seq, receivedAt, `重复内容 #${event.seq} v${event.version}，已忽略`)
    }
    return withLog(
      s0,
      'stale',
      event.seq,
      receivedAt,
      `同版本 v${event.version} 内容不一致，保留现有内容（#${event.seq}）`,
    )
  }

  // 4) 更新的机器版本
  if (existing.locked) {
    // 锁定片段：绝不静默覆盖，登记冲突等待人工裁决（同一片段只保留最新一条待裁决）
    const conflict: Conflict = {
      seq: event.seq,
      manualText: existing.text,
      manualVersion: existing.version,
      incomingText: event.text,
      incomingVersion: event.version,
      receivedAt,
    }
    const conflicts = [...state.conflicts.filter((c) => c.seq !== event.seq), conflict]
    const s = { ...s0, conflicts }
    return withLog(
      s,
      'conflict',
      event.seq,
      receivedAt,
      `#${event.seq} 已锁定，机器修订 v${event.version} 未覆盖人工内容，转入人工裁决`,
    )
  }

  // 未锁定：直接应用修订；若该片段曾有悬而未决的冲突，旧冲突随之失效
  const hadManualText = existing.origin === 'manual'
  const droppedConflict = state.conflicts.some((c) => c.seq === event.seq)
  const conflicts = state.conflicts.filter((c) => c.seq !== event.seq)
  const next: SubtitleSegment = {
    ...existing,
    text: event.text,
    version: event.version,
    origin: 'machine',
    // 元数据以最新机器事件为准
    speaker: event.speaker,
    lang: event.lang,
    startMs: event.startMs,
    endMs: event.endMs,
    // 机器新稿：清空术语应用记录，旧内容上的幂等抑制不再作用于新文本，随后增量重扫
    appliedTerms: {},
  }
  let s: ConsoleState = { ...s0, conflicts, segments: { ...state.segments, [event.seq]: next } }
  s = rescanOne(s, event.seq)
  const notes = [
    hadManualText ? '覆盖了未锁定的人工修改' : '',
    droppedConflict ? '旧的待裁决冲突已失效' : '',
  ]
    .filter(Boolean)
    .join('，')
  return withLog(
    s,
    'revised',
    event.seq,
    receivedAt,
    `机器修订 v${event.version} 已应用（#${event.seq}）${notes ? `，${notes}` : ''}`,
  )
}

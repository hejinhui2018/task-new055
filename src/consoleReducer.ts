import type {
  Conflict,
  ConsoleState,
  GlossaryHistoryEntry,
  LogKind,
  SubtitleEvent,
  SubtitleSegment,
} from './types'

/**
 * 控制台状态机：纯函数，不读时钟、不含随机性。
 * 相同的初始状态 + 相同的动作序列 => 完全相同的结果（可稳定重放）。
 */

/** apply-suggestions 动作携带的、定位一次替换所需的最小信息（来自扫描建议） */
export interface SuggestionPatch {
  id: string
  seq: number
  termId: string
  termVersion: number
  source: string
  target: string
  start: number
  end: number
}

export type ConsoleAction =
  | { type: 'ingest'; event: SubtitleEvent; receivedAt: number | null }
  | { type: 'edit'; seq: number; text: string }
  | { type: 'toggle-lock'; seq: number }
  | { type: 'resolve-conflict'; seq: number; choice: 'keep' | 'accept' }
  | { type: 'apply-suggestions'; patches: SuggestionPatch[] }
  | { type: 'undo-glossary' }
  | { type: 'redo-glossary' }
  | { type: 'reset' }

export function createInitialState(): ConsoleState {
  return {
    segments: {},
    seenEventIds: {},
    conflicts: [],
    log: [],
    nextLogId: 1,
    past: [],
    future: [],
  }
}

/** 事件流最多保留的条数，防止长时间运行无限增长 */
const MAX_LOG_ENTRIES = 200
/** 撤销栈深度 */
const MAX_HISTORY = 50

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

/** 校验位置上的文本是否仍是原词：英文忽略大小写，中文字面相等 */
function sliceMatches(slice: string, source: string): boolean {
  if (!slice) return false
  return /[A-Za-z]/.test(source) ? slice.toLowerCase() === source.toLowerCase() : slice === source
}

export function consoleReducer(state: ConsoleState, action: ConsoleAction): ConsoleState {
  switch (action.type) {
    case 'reset':
      // 重放必须回到一尘不染的初始状态，不留任何上一轮的痕迹（含撤销/重做栈）
      return createInitialState()

    case 'ingest':
      return ingest(state, action.event, action.receivedAt)

    case 'edit': {
      const seg = state.segments[action.seq]
      if (!seg || seg.locked) return state // 锁定片段不可直接编辑，需先解锁
      const text = action.text.trim()
      if (!text || text === seg.text) return state
      // 人工改写字本后，无法保证旧术语标记仍然成立，清空后由扫描重新给出建议
      const next: SubtitleSegment = {
        ...seg,
        text,
        origin: 'manual',
        glossaryApplied: [],
        appliedTargets: {},
      }
      const s = { ...state, segments: { ...state.segments, [action.seq]: next } }
      return withLog(s, 'manual', action.seq, null, `人工修改 #${action.seq}：「${text}」`)
    }

    case 'toggle-lock': {
      const seg = state.segments[action.seq]
      if (!seg) return state
      const locked = !seg.locked
      const s = {
        ...state,
        segments: { ...state.segments, [action.seq]: { ...seg, locked } },
      }
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
        // 全新机器文本：旧术语标记不再可信，清空后重新扫描
        glossaryApplied: [],
        appliedTargets: {},
      }
      const s = { ...state, conflicts, segments: { ...state.segments, [action.seq]: next } }
      return withLog(
        s,
        'resolved',
        action.seq,
        null,
        `接受机器修订 v${conflict.incomingVersion}（#${action.seq}），片段解除锁定`,
      )
    }

    case 'apply-suggestions':
      return applySuggestions(state, action.patches)

    case 'undo-glossary':
      return undoGlossary(state)

    case 'redo-glossary':
      return redoGlossary(state)
  }
}

/**
 * 应用术语建议（单条或批量）。
 * 不盲信建议携带的位置：应用前重新校验片段未锁定、位置上仍是原词、
 * 该术语版本尚未应用过——术语表变化或文本变化导致旧建议失效时，失效补丁自然跳过。
 */
function applySuggestions(state: ConsoleState, patches: SuggestionPatch[]): ConsoleState {
  if (patches.length === 0) return state

  // 按片段分组；同一片段内按位置从右向左替换，先替换的位置不影响后续偏移
  const bySeq = new Map<number, SuggestionPatch[]>()
  for (const p of patches) {
    const list = bySeq.get(p.seq) ?? []
    list.push(p)
    bySeq.set(p.seq, list)
  }

  const segments = { ...state.segments }
  const changes: GlossaryHistoryEntry['changes'] = []
  const termRefs: string[] = []

  for (const [seq, list] of bySeq) {
    const seg = segments[seq]
    if (!seg || seg.locked) continue // 锁定片段绝不被术语替换改写

    let text = seg.text
    // 幂等判定只看应用前已有的标记：同一术语版本在本片段的多个命中点可在一次批量中全部替换
    const initialMarkers = new Set(seg.glossaryApplied)
    const addedMarkers: string[] = []
    const targetsAfter: Record<string, string[]> = { ...seg.appliedTargets }
    // 本次批量已经替换过的原始坐标区间：重叠补丁（如两个术语原词相同）只应用一个
    const taken: Array<[number, number]> = []
    let touched = false

    const ordered = [...list].sort((a, b) => b.start - a.start || b.termId.localeCompare(a.termId))
    for (const p of ordered) {
      const marker = `${p.termId}@${p.termVersion}`
      // 幂等：该术语版本此前已经应用到片段，重复接受不再修改文本
      if (initialMarkers.has(marker)) continue
      if (p.start < 0 || p.end <= p.start || p.end > text.length) continue
      if (taken.some(([s, e]) => p.start < e && s < p.end)) continue
      const slice = text.slice(p.start, p.end)
      if (!sliceMatches(slice, p.source)) continue // 建议已失效（文本或术语版本变化）
      if (slice === p.target) continue
      text = text.slice(0, p.start) + p.target + text.slice(p.end)
      taken.push([p.start, p.end])
      if (!addedMarkers.includes(marker)) addedMarkers.push(marker)
      const known = targetsAfter[p.termId] ?? []
      if (!known.includes(p.target)) targetsAfter[p.termId] = [...known, p.target]
      touched = true
      if (!termRefs.includes(marker)) termRefs.push(marker)
    }

    if (!touched) continue
    const afterApplied = [...seg.glossaryApplied, ...addedMarkers]
    segments[seq] = {
      ...seg,
      text,
      origin: 'manual',
      glossaryApplied: afterApplied,
      appliedTargets: targetsAfter,
    }
    changes.push({
      seq,
      before: seg.text,
      after: text,
      beforeApplied: seg.glossaryApplied,
      afterApplied,
      beforeTargets: seg.appliedTargets,
      afterTargets: targetsAfter,
    })
  }

  if (changes.length === 0) return state // 全部失效/重复：不产生历史、不写日志

  // 一次批量接受只入栈一个历史条目，撤销时整体回滚
  const entry: GlossaryHistoryEntry = { changes, termRefs, count: changes.length }
  const s1: ConsoleState = {
    ...state,
    segments,
    past: [...state.past, entry].slice(-MAX_HISTORY),
    future: [],
  }
  const seqs = changes.map((c) => `#${c.seq}`).join('、')
  return withLog(
    s1,
    'glossary-applied',
    changes.length === 1 ? changes[0].seq : null,
    null,
    `接受术语建议 ${changes.length} 条（${seqs}，术语版本 ${termRefs.join('、')}）`,
  )
}

function undoGlossary(state: ConsoleState): ConsoleState {
  const entry = state.past[state.past.length - 1]
  if (!entry) return state
  const segments = { ...state.segments }
  let restored = 0
  for (const change of entry.changes) {
    const seg = segments[change.seq]
    if (!seg) continue
    // 应用之后该片段又被机器修订/人工改写：旧快照已过期，不覆盖当前文本
    if (seg.text !== change.after) continue
    segments[change.seq] = {
      ...seg,
      text: change.before,
      glossaryApplied: change.beforeApplied,
      appliedTargets: change.beforeTargets,
    }
    restored += 1
  }
  if (restored === 0) {
    // 全部过期：仅丢弃栈顶，不写误导性日志
    return { ...state, past: state.past.slice(0, -1) }
  }
  const s1: ConsoleState = {
    ...state,
    segments,
    past: state.past.slice(0, -1),
    future: [...state.future, entry],
  }
  return withLog(
    s1,
    'glossary-undo',
    null,
    null,
    `撤销术语应用 ${entry.count} 条，字幕恢复到应用前文本`,
  )
}

function redoGlossary(state: ConsoleState): ConsoleState {
  const entry = state.future[state.future.length - 1]
  if (!entry) return state
  const segments = { ...state.segments }
  let restored = 0
  for (const change of entry.changes) {
    const seg = segments[change.seq]
    if (!seg) continue
    // 重做前文本必须仍是撤销后的“应用前”文本，否则补丁已失效
    if (seg.text !== change.before) continue
    segments[change.seq] = {
      ...seg,
      text: change.after,
      glossaryApplied: change.afterApplied,
      appliedTargets: change.afterTargets,
    }
    restored += 1
  }
  if (restored === 0) {
    return { ...state, future: state.future.slice(0, -1) }
  }
  const s1: ConsoleState = {
    ...state,
    segments,
    past: [...state.past, entry],
    future: state.future.slice(0, -1),
  }
  return withLog(s1, 'glossary-redo', null, null, `重做术语应用 ${entry.count} 条`)
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
      glossaryApplied: [],
      appliedTargets: {},
    }
    const keys = Object.keys(state.segments)
    const maxSeq = keys.length > 0 ? Math.max(...keys.map(Number)) : null
    const isBackfill = maxSeq !== null && event.seq < maxSeq
    let s: ConsoleState = {
      ...state,
      seenEventIds,
      segments: { ...state.segments, [event.seq]: seg },
    }
    s = withLog(s, 'received', event.seq, receivedAt, `接收 #${event.seq} v${event.version}：「${event.text}」`)
    if (isBackfill) {
      s = withLog(s, 'backfilled', event.seq, receivedAt, `晚到片段 #${event.seq} 已自动补回缺口`)
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
    speaker: event.speaker ?? existing.speaker,
    // 机器新文本：旧术语标记不再可信，清空后由扫描增量重新给出建议
    glossaryApplied: [],
    appliedTargets: {},
  }
  const s = { ...s0, conflicts, segments: { ...state.segments, [event.seq]: next } }
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

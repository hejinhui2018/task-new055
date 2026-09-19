import type { GlossaryTerm, TermEntry } from './glossary'

/**
 * 版本化术语表状态机（纯函数）。
 *
 * 术语每次内容修改版本号 +1，旧版本上算出的建议在术语变化后整体失效重算；
 * 术语表自身的编辑（增删改、停启用）也支持撤销/重做，采用整表快照实现。
 */

export interface GlossaryState {
  /** id -> 术语 + 版本号 */
  terms: Record<string, TermEntry>
  /** 展示顺序（新增在末尾） */
  order: string[]
  /** 下一个术语序号，保证 id 纯函数生成、可重放 */
  nextTermSeq: number
  past: Array<{ terms: Record<string, TermEntry>; order: string[] }>
  future: Array<{ terms: Record<string, TermEntry>; order: string[] }>
}

export type TermDraft = Omit<GlossaryTerm, 'id'>

export type GlossaryAction =
  | { type: 'add-term'; draft: TermDraft }
  | { type: 'update-term'; id: string; draft: TermDraft }
  | { type: 'toggle-enabled'; id: string }
  | { type: 'delete-term'; id: string }
  | { type: 'undo-glossary' }
  | { type: 'redo-glossary' }
  | { type: 'reset-glossary' }

/** 内置演示术语（与 scenario 的文本/说话人对应） */
function demoTerms(): { terms: Record<string, TermEntry>; order: string[]; nextTermSeq: number } {
  const defs: Array<TermDraft> = [
    {
      source: '晚间新闻',
      target: '《晚间新闻》',
      language: 'zh',
      enabled: true,
      seqStart: null,
      seqEnd: null,
      speakers: [],
      homophones: [],
    },
    {
      source: '新闻摘要',
      target: '新闻提要',
      language: 'zh',
      enabled: true,
      seqStart: 103,
      seqEnd: 103,
      speakers: [],
      homophones: [],
    },
    {
      source: '北京时间',
      target: '北京时间（BJT）',
      language: 'zh',
      enabled: true,
      seqStart: null,
      seqEnd: null,
      speakers: ['主播B'],
      homophones: [],
    },
    {
      source: 'GPU',
      target: 'GPU 图形处理器',
      language: 'en',
      enabled: true,
      seqStart: null,
      seqEnd: null,
      speakers: [],
      homophones: [],
    },
  ]
  const terms: Record<string, TermEntry> = {}
  const order: string[] = []
  defs.forEach((draft, i) => {
    const id = `term-${i + 1}`
    terms[id] = { term: { id, ...normalizeDraft(draft) }, version: 1 }
    order.push(id)
  })
  return { terms, order, nextTermSeq: defs.length + 1 }
}

export function createInitialGlossaryState(): GlossaryState {
  const { terms, order, nextTermSeq } = demoTerms()
  return { terms, order, nextTermSeq, past: [], future: [] }
}

function normalizeDraft(draft: TermDraft): Omit<GlossaryTerm, 'id'> {
  return {
    source: draft.source.trim(),
    target: draft.target.trim(),
    language: draft.language,
    enabled: draft.enabled,
    seqStart: draft.seqStart,
    seqEnd: draft.seqEnd,
    speakers: draft.speakers.map((s) => s.trim()).filter(Boolean),
    homophones: draft.homophones.map((s) => s.trim()).filter(Boolean),
  }
}

/** 判断一次保存是否真的改变了术语内容（停启用不抬升内容版本） */
function contentChanged(a: GlossaryTerm, b: TermDraft): boolean {
  const n = normalizeDraft(b)
  return (
    a.source !== n.source ||
    a.target !== n.target ||
    a.language !== n.language ||
    a.seqStart !== n.seqStart ||
    a.seqEnd !== n.seqEnd ||
    a.speakers.join('|') !== n.speakers.join('|') ||
    a.homophones.join('|') !== n.homophones.join('|')
  )
}

function snapshot(state: GlossaryState) {
  return { terms: state.terms, order: state.order }
}

function commit(state: GlossaryState, terms: Record<string, TermEntry>, order: string[]): GlossaryState {
  return {
    ...state,
    terms,
    order,
    past: [...state.past, snapshot(state)].slice(-50),
    future: [],
  }
}

export function glossaryReducer(state: GlossaryState, action: GlossaryAction): GlossaryState {
  switch (action.type) {
    case 'reset-glossary':
      return createInitialGlossaryState()

    case 'add-term': {
      const draft = normalizeDraft(action.draft)
      if (!draft.source || !draft.target) return state
      const id = `term-${state.nextTermSeq}`
      const entry: TermEntry = { term: { id, ...draft }, version: 1 }
      return commit(
        { ...state, nextTermSeq: state.nextTermSeq + 1 },
        { ...state.terms, [id]: entry },
        [...state.order, id],
      )
    }

    case 'update-term': {
      const current = state.terms[action.id]
      if (!current) return state
      const draft = normalizeDraft(action.draft)
      if (!draft.source || !draft.target) return state
      if (!contentChanged(current.term, action.draft) && current.term.enabled === draft.enabled) return state
      // 内容修改抬升版本；仅 enabled 变化的保存不抬版本（停启用走独立动作）
      const version = contentChanged(current.term, action.draft) ? current.version + 1 : current.version
      const entry: TermEntry = { term: { id: action.id, ...draft }, version }
      return commit(state, { ...state.terms, [action.id]: entry }, state.order)
    }

    case 'toggle-enabled': {
      const current = state.terms[action.id]
      if (!current) return state
      const entry: TermEntry = {
        ...current,
        term: { ...current.term, enabled: !current.term.enabled },
      }
      return commit(state, { ...state.terms, [action.id]: entry }, state.order)
    }

    case 'delete-term': {
      if (!state.terms[action.id]) return state
      const terms = { ...state.terms }
      delete terms[action.id]
      return commit(state, terms, state.order.filter((id) => id !== action.id))
    }

    case 'undo-glossary': {
      const prev = state.past[state.past.length - 1]
      if (!prev) return state
      return {
        ...state,
        terms: prev.terms,
        order: prev.order,
        past: state.past.slice(0, -1),
        future: [...state.future, snapshot(state)],
      }
    }

    case 'redo-glossary': {
      const next = state.future[state.future.length - 1]
      if (!next) return state
      return {
        ...state,
        terms: next.terms,
        order: next.order,
        past: [...state.past, snapshot(state)],
        future: state.future.slice(0, -1),
      }
    }
  }
}

/** 供扫描器与持久化使用的有序术语列表 */
export function termEntries(state: GlossaryState): TermEntry[] {
  return state.order.map((id) => state.terms[id]).filter(Boolean)
}

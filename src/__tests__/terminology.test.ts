import { describe, expect, it } from 'vitest'
import { consoleReducer, createInitialState, findMatch } from '../consoleReducer'
import { allAutoKeys, matchesByKind } from '../selectors'
import { findOccurrences, replaceOccurrences, scanSegment } from '../termScan'
import { createMemoryStorage, loadSnapshot, persistState } from '../storage'
import type { ConsoleState, SubtitleEvent, SubtitleSegment, Term, TermDraft } from '../types'

/* ----------------------------- 测试夹具 ----------------------------- */

function term(partial: Partial<Term> & Pick<Term, 'id' | 'source' | 'target'>): Term {
  return { enabled: true, version: 1, ...partial }
}

function seg(partial: Partial<SubtitleSegment> & Pick<SubtitleSegment, 'seq' | 'text'>): SubtitleSegment {
  return { version: 1, origin: 'machine', locked: false, ...partial }
}

function withTerms(terms: Term[]): ConsoleState {
  let s = createInitialState()
  terms.forEach((t, i) => {
    s = {
      ...s,
      terms: { ...s.terms, [t.id]: { ...t, version: t.version || i + 1 } },
      termVersion: Math.max(s.termVersion, t.version || i + 1),
    }
  })
  return s
}

function ingestSeg(
  state: ConsoleState,
  seq: number,
  text: string,
  extra: Partial<SubtitleEvent> = {},
  receivedAt: number | null = null,
): ConsoleState {
  const event: SubtitleEvent = { id: `e-${seq}-${extra.version ?? 1}`, seq, version: 1, kind: 'create', text, ...extra }
  return consoleReducer(state, { type: 'ingest', event, receivedAt })
}

function upsert(state: ConsoleState, draft: TermDraft): ConsoleState {
  return consoleReducer(state, { type: 'term-upsert', draft })
}

function scanOf(state: ConsoleState, seq: number) {
  const scan = state.scans[seq]
  if (!scan) throw new Error(`#${seq} 缺少扫描缓存`)
  return scan
}

const auto = (state: ConsoleState) => matchesByKind(state, 'auto')
const kindsOf = (state: ConsoleState, seq: number) =>
  scanOf(state, seq).matches.map((m) => m.kind)

/* ============================ 边界匹配 ============================ */

describe('术语扫描 · 边界匹配', () => {
  it('拉丁/数字串要求词边界：不命中更长型号的内部子串', () => {
    expect(findOccurrences('X90 Pro 开售', 'X90')).toEqual([0])
    expect(findOccurrences('X90ProMax 开售', 'X90')).toEqual([]) // 右侧紧邻字母
    expect(findOccurrences('买X90了', 'X90')).toEqual([1]) // 中文不算边界字符，正常命中
    expect(findOccurrences('AIDE 是开发环境', 'AI')).toEqual([])
    expect(findOccurrences('AI 正在直播', 'AI')).toEqual([0])
    expect(findOccurrences('版本15上新', '15')).toEqual([2])
    expect(findOccurrences('iPhone15Pro', 'iPhone15')).toEqual([])
  })

  it('中文相邻字符不阻断匹配（中文无空格分词）', () => {
    expect(findOccurrences('欢迎收看晚间新闻直播', '晚间新闻')).toEqual([4])
    // 替换同样遵循边界
    expect(replaceOccurrences('X90ProMax 与 X90', 'X90', 'X90 Pro')).toBe('X90ProMax 与 X90 Pro')
  })

  it('同一片段多处出现全部标出，替换一次完成', () => {
    const s = withTerms([term({ id: 't1', source: '北京', target: '北京（BJT）' })])
    const scan = scanSegment(seg({ seq: 1, text: '北京早安，北京晚安' }), Object.values(s.terms), s.termVersion)
    const autoMatch = scan.matches.find((m) => m.kind === 'auto')!
    expect(autoMatch.replacement).toBe('北京（BJT）早安，北京（BJT）晚安')
    expect(autoMatch.reason).toContain('采纳 2 处')
  })
})

/* ============================ 范围：语言/说话人/时间 ============================ */

describe('术语扫描 · 语言 / 说话人 / 有效时间范围', () => {
  const terms = [
    term({ id: 'lang-only', source: '苹果', target: '苹果公司', lang: 'en' }),
    term({ id: 'speaker-only', source: '苹果', target: '苹果公司', speakers: ['陈默'] }),
    term({ id: 'window', source: '苹果', target: '苹果公司', validFromMs: 10000, validToMs: 20000 }),
  ]

  it('语言不符 → 不适用并解释；语言相符 → 自动建议', () => {
    const s = withTerms(terms)
    const zh = scanSegment(seg({ seq: 1, text: '苹果发布新品', lang: 'zh-CN' }), Object.values(s.terms), s.termVersion)
    expect(zh.matches.find((m) => m.termId === 'lang-only')?.kind).toBe('not-applicable')
    expect(zh.matches.find((m) => m.termId === 'lang-only')?.reason).toContain('语言')

    const en = scanSegment(seg({ seq: 2, text: '苹果 releases', lang: 'en' }), Object.values(s.terms), s.termVersion)
    expect(en.matches.find((m) => m.termId === 'lang-only')?.kind).toBe('auto')
  })

  it('说话人白名单：别人说 → 不适用；白名单说话人说 → 自动建议', () => {
    const s = withTerms(terms)
    const other = scanSegment(seg({ seq: 1, text: '苹果发布新品', speaker: '林晚' }), Object.values(s.terms), s.termVersion)
    expect(other.matches.find((m) => m.termId === 'speaker-only')?.kind).toBe('not-applicable')
    const chen = scanSegment(seg({ seq: 2, text: '苹果发布新品', speaker: '陈默' }), Object.values(s.terms), s.termVersion)
    expect(chen.matches.find((m) => m.termId === 'speaker-only')?.kind).toBe('auto')
  })

  it('有效时间按区间重叠判定：不重叠 → 不适用；边界相接/重叠 → 建议', () => {
    const s = withTerms(terms)
    const before = scanSegment(seg({ seq: 1, text: '苹果', startMs: 8000, endMs: 9999 }), Object.values(s.terms), s.termVersion)
    expect(before.matches.find((m) => m.termId === 'window')?.kind).toBe('not-applicable')
    const touch = scanSegment(seg({ seq: 2, text: '苹果', startMs: 9000, endMs: 10000 }), Object.values(s.terms), s.termVersion)
    expect(touch.matches.find((m) => m.termId === 'window')?.kind).toBe('auto') // 闭区间在 10000 相接
    const inside = scanSegment(seg({ seq: 3, text: '苹果', startMs: 25000, endMs: 30000 }), Object.values(s.terms), s.termVersion)
    expect(inside.matches.find((m) => m.termId === 'window')?.kind).toBe('not-applicable')
  })

  it('文本未出现原词时不产生噪声建议（即使范围不匹配也静默）', () => {
    const s = withTerms(terms)
    const scan = scanSegment(seg({ seq: 1, text: '今天天气不错', lang: 'en', speaker: '陈默', startMs: 1000, endMs: 2000 }), Object.values(s.terms), s.termVersion)
    expect(scan.matches).toHaveLength(0)
  })
})

/* ============================ 同音歧义 ============================ */

describe('术语扫描 · 同音歧义', () => {
  const t = term({ id: 'news', source: '新闻', target: '资讯', homophones: ['欣闻', '新文'] })

  it('出现同音词 → 同音歧义，绝不自动建议，并给出听音确认理由', () => {
    const s = withTerms([t])
    const scan = scanSegment(seg({ seq: 1, text: '令人欣闻的消息' }), Object.values(s.terms), s.termVersion)
    const m = scan.matches[0]
    expect(m.kind).toBe('homophone')
    expect(m.index).toBe(2)
    expect(m.replacement).toBeNull()
    expect(m.reason).toContain('听音确认')
  })

  it('同一片段同音词与原词同时出现：仍按歧义保守处理，不自动替换原词', () => {
    const s = withTerms([t])
    const scan = scanSegment(seg({ seq: 1, text: '新闻与欣闻都出现了' }), Object.values(s.terms), s.termVersion)
    expect(scan.matches).toHaveLength(1)
    expect(scan.matches[0].kind).toBe('homophone')
  })
})

/* ============================ 重叠术语 ============================ */

describe('术语扫描 · 重叠术语', () => {
  const terms = [
    term({ id: 'a-short', source: '新闻', target: '资讯' }),
    term({ id: 'b-long', source: '晚间新闻', target: '《晚间新闻》' }),
  ]

  it('同区间命中：更长术语胜出为自动建议，短词转不适用并解释', () => {
    const s = withTerms(terms)
    const scan = scanSegment(seg({ seq: 1, text: '收看晚间新闻直播' }), Object.values(s.terms), s.termVersion)
    const long = scan.matches.find((m) => m.termId === 'b-long')!
    const short = scan.matches.find((m) => m.termId === 'a-short')!
    expect(long.kind).toBe('auto')
    expect(long.replacement).toBe('收看《晚间新闻》直播')
    expect(short.kind).toBe('not-applicable')
    expect(short.reason).toContain('重叠')
  })

  it('不重叠的两处出现各自给建议', () => {
    const s = withTerms(terms)
    const scan = scanSegment(seg({ seq: 1, text: '晚间新闻之后还有新闻' }), Object.values(s.terms), s.termVersion)
    expect(scan.matches.find((m) => m.termId === 'b-long')?.kind).toBe('auto')
    // 第二处“新闻”不与长词重叠，应同样可建议
    const short = scan.matches.find((m) => m.termId === 'a-short')!
    expect(short.kind).toBe('auto')
    expect(short.index).toBe(8)
  })

  it('同音歧义区间优先于自动建议占位（歧义不得被自动替换破坏）', () => {
    const s = withTerms([
      term({ id: 'homo', source: '晚间新闻', target: 'X', homophones: ['间新'] }),
      term({ id: 'short', source: '间新', target: 'Y' }),
    ])
    const scan = scanSegment(seg({ seq: 1, text: '晚间新闻直播' }), Object.values(s.terms), s.termVersion)
    expect(scan.matches.find((m) => m.termId === 'homo')?.kind).toBe('homophone')
    expect(scan.matches.find((m) => m.termId === 'short')?.kind).toBe('not-applicable')
  })
})

/* ============================ 锁定字幕 ============================ */

describe('术语校对 · 人工锁定片段', () => {
  it('锁定片段命中原词 → 人工锁定冲突，接受动作不改写', () => {
    let s = withTerms([term({ id: 't1', source: '苹果', target: '苹果公司' })])
    s = ingestSeg(s, 1, '苹果发布新品')
    s = consoleReducer(s, { type: 'toggle-lock', seq: 1 })

    expect(kindsOf(s, 1)).toContain('locked-conflict')
    const lockedMatch = scanOf(s, 1).matches.find((m) => m.kind === 'locked-conflict')!
    expect(lockedMatch.reason).toContain('已人工锁定')
    // 批量接受全部也不会碰锁定项
    const before = s.segments[1].text
    s = consoleReducer(s, { type: 'terms-apply', keys: allAutoKeys(s) })
    s = consoleReducer(s, { type: 'terms-apply', keys: [lockedMatch.key] })
    expect(s.segments[1].text).toBe(before)
  })

  it('解锁后建议从锁定冲突变为可自动建议', () => {
    let s = withTerms([term({ id: 't1', source: '苹果', target: '苹果公司' })])
    s = ingestSeg(s, 1, '苹果发布新品')
    s = consoleReducer(s, { type: 'toggle-lock', seq: 1 })
    expect(kindsOf(s, 1)).toContain('locked-conflict')
    s = consoleReducer(s, { type: 'toggle-lock', seq: 1 })
    expect(kindsOf(s, 1)).toContain('auto')
  })
})

/* ============================ 术语版本变化 ============================ */

describe('版本化术语 · 旧建议失效与重新计算', () => {
  it('更新术语：termVersion 递增，全部建议携带新版本号', () => {
    let s = withTerms([term({ id: 't1', version: 3, source: '苹果', target: '苹果公司' })])
    s = ingestSeg(s, 1, '苹果发布')
    expect(scanOf(s, 1).matches[0].termVersion).toBe(3)

    s = upsert(s, { id: 't1', source: '苹果', target: '苹果（Apple）' })
    expect(s.termVersion).toBe(4)
    expect(s.terms['t1'].version).toBe(4)
    expect(scanOf(s, 1).matches[0].termVersion).toBe(4)
    expect(scanOf(s, 1).termVersion).toBe(4)
    expect(s.log.some((l) => l.kind === 'term' && l.message.includes('全量重扫'))).toBe(true)
  })

  it('新版本下旧的应用记录不再抑制建议；旧版本期间重复接受仍幂等', () => {
    let s = withTerms([term({ id: 't1', version: 1, source: '苹果', target: '苹果公司' })])
    s = ingestSeg(s, 1, '苹果发布')
    const key1 = scanOf(s, 1).matches.find((m) => m.kind === 'auto')!.key
    s = consoleReducer(s, { type: 'terms-apply', keys: [key1] })
    expect(s.segments[1].text).toBe('苹果公司发布')
    // 同版本重复接受：无任何变化
    const again = consoleReducer(s, { type: 'terms-apply', keys: [key1] })
    expect(again).toBe(s)

    // 术语更新到 v2（目标变了，原词仍在文本中——此处把原词改回以模拟新版本再次校对）
    s = consoleReducer(s, { type: 'edit', seq: 1, text: '苹果发布了新品' })
    s = upsert(s, { id: 't1', source: '苹果', target: '苹果（中国）' })
    const m2 = scanOf(s, 1).matches.find((m) => m.termId === 't1')
    expect(m2?.kind).toBe('auto')
    expect(m2?.termVersion).toBe(2)
    s = consoleReducer(s, { type: 'terms-apply', keys: [m2!.key] })
    expect(s.segments[1].text).toBe('苹果（中国）发布了新品')
  })

  it('停用/启用/删除术语都使建议失效重算', () => {
    let s = withTerms([
      term({ id: 'a', version: 1, source: '苹果', target: '苹果公司' }),
      term({ id: 'b', version: 2, source: '香蕉', target: '香蕉公司' }),
    ])
    s = ingestSeg(s, 1, '苹果与香蕉')
    expect(auto(s)).toHaveLength(2)

    s = consoleReducer(s, { type: 'term-toggle', id: 'a' })
    expect(auto(s).map((m) => m.termId)).toEqual(['b'])
    s = consoleReducer(s, { type: 'term-toggle', id: 'a' })
    expect(auto(s)).toHaveLength(2)

    s = consoleReducer(s, { type: 'term-delete', id: 'b' })
    expect(auto(s).map((m) => m.termId)).toEqual(['a'])
  })
})

/* ============================ 晚到片段增量扫描 ============================ */

describe('晚到片段 · 增量扫描', () => {
  it('新片段（含晚到）到达时生成自己的扫描结果，且只有相关术语产生记录', () => {
    let s = withTerms([
      term({ id: 'apple', source: '苹果', target: '苹果公司' }),
      term({ id: 'banana', source: '香蕉', target: '香蕉公司' }),
    ])
    s = ingestSeg(s, 103, '香蕉到货', {}, 1500)
    // #102 晚到
    s = ingestSeg(s, 102, '苹果发货', {}, 4500)

    expect(s.scans[102]).toBeDefined()
    expect(s.scans[103]).toBeDefined()
    const scan102 = scanOf(s, 102)
    expect(scan102.matches.map((m) => m.termId)).toEqual(['apple']) // 不含无关的 banana
    expect(s.log.some((l) => l.kind === 'backfilled' && l.seq === 102)).toBe(true)
  })

  it('机器修订只重扫该片段，并清空旧内容上的术语应用记录', () => {
    let s = withTerms([term({ id: 't1', source: '苹果', target: '苹果公司' })])
    s = ingestSeg(s, 1, '苹果 v1')
    s = consoleReducer(s, { type: 'terms-apply', keys: allAutoKeys(s) })
    expect(s.segments[1].appliedTerms?.['t1']).toBe(1)

    s = ingestSeg(s, 1, '苹果 v2 修订', { version: 2, kind: 'revision' }, 9000)
    expect(s.segments[1].appliedTerms).toEqual({})
    expect(auto(s).some((m) => m.seq === 1)).toBe(true) // 新稿重新得到建议
  })
})

/* ============================ 幂等 ============================ */

describe('术语应用 · 幂等', () => {
  it('单条/批量重复应用不会再次修改字幕', () => {
    let s = withTerms([
      term({ id: 'a', source: '苹果', target: '苹果公司' }),
      term({ id: 'b', source: '香蕉', target: '香蕉公司' }),
    ])
    s = ingestSeg(s, 1, '苹果与香蕉')
    const keys = allAutoKeys(s)
    expect(keys).toHaveLength(2)

    s = consoleReducer(s, { type: 'terms-apply', keys })
    const textOnce = s.segments[1].text
    expect(textOnce).toBe('苹果公司与香蕉公司')

    // 再来一次：状态引用不变（没有任何可做的工作）
    const second = consoleReducer(s, { type: 'terms-apply', keys })
    expect(second).toBe(s)
    expect(second.segments[1].text).toBe(textOnce)

    // 已失效的 key（术语已更新）直接忽略
    s = upsert(s, { id: 'a', source: '苹果', target: '苹果集团' })
    const stale = consoleReducer(s, { type: 'terms-apply', keys })
    expect(stale).toBe(s)
  })

  it('接受建议后人工把原词改回，当前版本仍不重复建议（应用记录保留）', () => {
    let s = withTerms([term({ id: 't1', source: '苹果', target: '苹果公司' })])
    s = ingestSeg(s, 1, '苹果发布')
    s = consoleReducer(s, { type: 'terms-apply', keys: allAutoKeys(s) })
    s = consoleReducer(s, { type: 'edit', seq: 1, text: '苹果发布（修订）' })
    expect(scanOf(s, 1).matches.find((m) => m.termId === 't1')?.kind).toBe('not-applicable')
    expect(auto(s)).toHaveLength(0)
  })

  it('应用长词后，包含在目标写法中的短词不会被二次修改（遮蔽位）', () => {
    let s = withTerms([
      term({ id: 'long', source: '晚间新闻', target: '《晚间新闻》' }),
      term({ id: 'short', source: '新闻', target: '资讯' }),
    ])
    s = ingestSeg(s, 1, '收看晚间新闻直播')
    s = consoleReducer(s, { type: 'terms-apply', keys: allAutoKeys(s) })
    expect(s.segments[1].text).toBe('收看《晚间新闻》直播')
    // “新闻”仍在《晚间新闻》中，但不得再建议改成“资讯”
    const short = scanOf(s, 1).matches.find((m) => m.termId === 'short')
    expect(short?.kind).toBe('not-applicable')
    expect(auto(s)).toHaveLength(0)
  })
})

/* ============================ 单条/批量接受与排序 ============================ */

describe('术语应用 · 单条与批量', () => {
  it('只接受指定的一条，另一条建议保留', () => {
    let s = withTerms([
      term({ id: 'a', source: '苹果', target: '苹果公司' }),
      term({ id: 'b', source: '香蕉', target: '香蕉公司' }),
    ])
    s = ingestSeg(s, 1, '苹果与香蕉')
    const aKey = scanOf(s, 1).matches.find((m) => m.termId === 'a')!.key
    s = consoleReducer(s, { type: 'terms-apply', keys: [aKey] })
    expect(s.segments[1].text).toBe('苹果公司与香蕉')
    expect(auto(s).map((m) => m.termId)).toEqual(['b'])
    expect(s.log.some((l) => l.kind === 'term-apply')).toBe(true)
  })

  it('批量跨片段按序号确定性应用，同片段先长后短', () => {
    let s = withTerms([
      term({ id: 'a', source: '新闻', target: '资讯' }),
      term({ id: 'b', source: '香蕉', target: '香蕉公司' }),
    ])
    s = ingestSeg(s, 2, '新闻一条')
    s = ingestSeg(s, 1, '香蕉一根')
    s = consoleReducer(s, { type: 'terms-apply', keys: allAutoKeys(s) })
    expect(s.segments[1].text).toBe('香蕉公司一根')
    expect(s.segments[2].text).toBe('资讯一条')
  })

  it('findMatch 能按 key 找到建议，坏 key 安全返回 undefined', () => {
    let s = withTerms([term({ id: 't1', source: '苹果', target: '苹果公司' })])
    s = ingestSeg(s, 1, '苹果')
    const key = auto(s)[0].key
    expect(findMatch(s, key)?.termId).toBe('t1')
    expect(findMatch(s, 'nonsense')).toBeUndefined()
    expect(findMatch(s, '999::t1')).toBeUndefined()
  })
})

/* ============================ 撤销 / 重做 ============================ */

describe('撤销重做', () => {
  it('接受建议可撤销、可重做；重做栈在新操作后清空', () => {
    let s: ConsoleState = withTerms([term({ id: 't1', source: '苹果', target: '苹果公司' })])
    s = ingestSeg(s, 1, '苹果发布')
    expect(s.past).toHaveLength(0) // ingest 不进历史

    s = consoleReducer(s, { type: 'terms-apply', keys: allAutoKeys(s) })
    expect(s.segments[1].text).toBe('苹果公司发布')
    expect(s.past).toHaveLength(1)
    expect(s.future).toHaveLength(0)

    s = consoleReducer(s, { type: 'undo' })
    expect(s.segments[1].text).toBe('苹果发布')
    expect(s.segments[1].appliedTerms ?? {}).toEqual({})
    expect(auto(s)).toHaveLength(1) // 撤销后建议回来
    expect(s.future).toHaveLength(1)

    s = consoleReducer(s, { type: 'redo' })
    expect(s.segments[1].text).toBe('苹果公司发布')
    expect(s.future).toHaveLength(0)

    // 撤销后做一个新的人工操作，重做栈作废
    s = consoleReducer(s, { type: 'undo' })
    s = consoleReducer(s, { type: 'toggle-lock', seq: 1 })
    expect(s.future).toHaveLength(0)
    expect(s.segments[1].locked).toBe(true)
    const redoNoop = consoleReducer(s, { type: 'redo' })
    expect(redoNoop).toBe(s)
  })

  it('术语维护与锁定/编辑都在撤销历史中；机器接收动作不入历史', () => {
    let s: ConsoleState = withTerms([])
    s = ingestSeg(s, 1, '苹果')
    s = upsert(s, { source: '苹果', target: '苹果公司' })
    const afterUpsertVersion = s.termVersion
    s = consoleReducer(s, { type: 'undo' })
    expect(s.termVersion).toBe(0)
    expect(s.terms).toEqual({})
    s = consoleReducer(s, { type: 'redo' })
    expect(s.termVersion).toBe(afterUpsertVersion)
  })

  it('空栈撤销/重做返回同一状态', () => {
    const s = createInitialState()
    expect(consoleReducer(s, { type: 'undo' })).toBe(s)
    expect(consoleReducer(s, { type: 'redo' })).toBe(s)
  })
})

/* ============================ 刷新恢复 ============================ */

describe('刷新恢复（持久化 + hydrate）', () => {
  it('事实层落盘后恢复：字幕/术语回来，扫描缓存按当前数据重建，撤销栈清空', () => {
    let s = withTerms([term({ id: 't1', source: '苹果', target: '苹果公司' })])
    s = ingestSeg(s, 1, '苹果发布')
    s = consoleReducer(s, { type: 'terms-apply', keys: allAutoKeys(s) }) // 产生一条撤销历史
    expect(s.past.length).toBeGreaterThan(0)

    const storage = createMemoryStorage()
    const result = persistState(s, storage)
    expect(result.ok).toBe(true)

    const loaded = loadSnapshot(storage)!
    expect(loaded.segments[1].text).toBe('苹果公司发布')
    expect(loaded.terms['t1'].target).toBe('苹果公司')
    expect((loaded as ConsoleState).scans).toBeUndefined() // 派生缓存不入库

    const restored = consoleReducer(createInitialState(), { type: 'hydrate', snapshot: loaded })
    expect(restored.segments[1].text).toBe('苹果公司发布')
    expect(restored.scans[1]).toBeDefined() // 缓存重建
    expect(restored.termVersion).toBe(s.termVersion)
    expect(restored.past).toEqual([])
    expect(restored.future).toEqual([])
  })

  it('脏数据 / 缺数据安全回退为 null', () => {
    const storage = createMemoryStorage({ 'subtitle-qc-console:snapshot:v1': '{不是json' })
    expect(loadSnapshot(storage)).toBeNull()
    const storage2 = createMemoryStorage({ 'subtitle-qc-console:snapshot:v1': JSON.stringify({ v: 99 }) })
    expect(loadSnapshot(storage2)).toBeNull()
  })
})

/* ============================ 重放与既有流程 ============================ */

describe('重放 · reset 与术语表的关系', () => {
  it('reset 清空字幕与扫描，但保留节目术语表（运营资产）', () => {
    let s = withTerms([term({ id: 't1', source: '苹果', target: '苹果公司' })])
    s = ingestSeg(s, 1, '苹果')
    s = consoleReducer(s, { type: 'terms-apply', keys: allAutoKeys(s) })
    const reset = consoleReducer(s, { type: 'reset' })
    expect(reset.segments).toEqual({})
    expect(reset.scans).toEqual({})
    expect(reset.seenEventIds).toEqual({})
    expect(reset.log).toEqual([])
    expect(reset.past).toEqual([])
    expect(reset.terms['t1']).toBeDefined()
    expect(reset.termVersion).toBe(s.termVersion)
  })

  it('无术语时 reset 与全新初始状态逐位相等（原有无残留保证不变）', () => {
    let s = createInitialState()
    s = ingestSeg(s, 1, '一条字幕')
    s = consoleReducer(s, { type: 'edit', seq: 1, text: '改过的字幕' })
    expect(consoleReducer(s, { type: 'reset' })).toEqual(createInitialState())
  })
})

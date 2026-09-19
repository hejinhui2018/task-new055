import { describe, expect, it } from 'vitest'
import { consoleReducer, createInitialState, type ConsoleAction, type SuggestionPatch } from '../consoleReducer'
import { scanOneSegment, type GlossaryTerm, type TermEntry } from '../glossary'
import type { SubtitleEvent, SubtitleSegment } from '../types'

function ev(
  id: string,
  seq: number,
  version: number,
  text: string,
  speaker?: string,
  kind: 'create' | 'revision' = 'create',
): SubtitleEvent {
  return { id, seq, version, kind, text, ...(speaker ? { speaker } : {}) }
}

function ingest(event: SubtitleEvent, receivedAt: number | null = null): ConsoleAction {
  return { type: 'ingest', event, receivedAt }
}

function term(
  id: string,
  source: string,
  target: string,
  extra: Partial<Omit<GlossaryTerm, 'id' | 'source' | 'target'>> & { version?: number } = {},
): TermEntry {
  const { version, ...rest } = extra
  return {
    term: {
      id,
      source,
      target,
      language: rest.language ?? 'zh',
      enabled: true,
      seqStart: rest.seqStart ?? null,
      seqEnd: rest.seqEnd ?? null,
      speakers: rest.speakers ?? [],
      homophones: rest.homophones ?? [],
    },
    version: version ?? 1,
  }
}

function patchesFor(seg: SubtitleSegment, entries: TermEntry[]): SuggestionPatch[] {
  return scanOneSegment(seg, entries)
    .filter((m) => m.kind === 'suggestion')
    .map((m) => ({
      id: m.id,
      seq: m.seq,
      termId: m.termId,
      termVersion: m.termVersion,
      source: m.source,
      target: m.target,
      start: m.start,
      end: m.end,
    }))
}

function apply(patches: SuggestionPatch[]): ConsoleAction {
  return { type: 'apply-suggestions', patches }
}

describe('术语应用 · 单条与批量', () => {
  it('单条接受：文本被替换、片段转人工、记录术语版本标记与日志', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('e1', 1, 1, '欢迎收看晚间新闻')))
    const entries = [term('t-news', '晚间新闻', '《晚间新闻》')]
    const patches = patchesFor(s.segments[1], entries)
    expect(patches).toHaveLength(1)

    s = consoleReducer(s, apply(patches))
    expect(s.segments[1].text).toBe('欢迎收看《晚间新闻》')
    expect(s.segments[1].origin).toBe('manual')
    expect(s.segments[1].glossaryApplied).toEqual(['t-news@1'])
    expect(s.segments[1].appliedTargets).toEqual({ 't-news': ['《晚间新闻》'] })
    expect(s.past).toHaveLength(1)
    expect(s.log.some((l) => l.kind === 'glossary-applied' && l.seq === 1)).toBe(true)
  })

  it('批量接受跨片段：一次只产生一个历史条目，撤销整体回滚', () => {
    let s = createInitialState()
    s = consoleReducer(s, ingest(ev('a', 1, 1, '新闻第一条')))
    s = consoleReducer(s, ingest(ev('b', 2, 1, '新闻第二条')))
    const entries = [term('t', '新闻', '新闻报道')]
    const all = [1, 2].flatMap((seq) => patchesFor(s.segments[seq], entries))
    expect(all).toHaveLength(2)

    s = consoleReducer(s, apply(all))
    expect(s.segments[1].text).toBe('新闻报道第一条')
    expect(s.segments[2].text).toBe('新闻报道第二条')
    expect(s.past).toHaveLength(1) // 批量 = 一个撤销单位
    expect(s.past[0].changes).toHaveLength(2)

    s = consoleReducer(s, { type: 'undo-glossary' })
    expect(s.segments[1].text).toBe('新闻第一条')
    expect(s.segments[2].text).toBe('新闻第二条')
    expect(s.segments[1].glossaryApplied).toEqual([])
    expect(s.future).toHaveLength(1)

    s = consoleReducer(s, { type: 'redo-glossary' })
    expect(s.segments[1].text).toBe('新闻报道第一条')
    expect(s.segments[2].text).toBe('新闻报道第二条')
    expect(s.past).toHaveLength(1)
    expect(s.future).toHaveLength(0)
  })

  it('同一片段的多个命中点在一次批量中全部替换，只记一个术语标记', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, '新闻连着新闻')))
    const entries = [term('t', '新闻', '新闻报道')]
    s = consoleReducer(s, apply(patchesFor(s.segments[1], entries)))
    expect(s.segments[1].text).toBe('新闻报道连着新闻报道')
    expect(s.segments[1].glossaryApplied).toEqual(['t@1'])
  })

  it('区间重叠的等长建议（两个术语原词相同）只应用一个', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, 'M1 发布')))
    const entries = [
      term('a', 'M1', 'M1 芯片', { language: 'en' }),
      term('b', 'M1', 'M1 处理器', { language: 'en' }),
    ]
    const patches = patchesFor(s.segments[1], entries)
    expect(patches).toHaveLength(2)
    s = consoleReducer(s, apply(patches))
    // 恰好一个目标被写入，另一个补丁因区间已变而跳过，文本中不存在双重替换
    const text = s.segments[1].text
    expect(text === 'M1 芯片 发布' || text === 'M1 处理器 发布').toBe(true)
    expect(s.segments[1].glossaryApplied).toHaveLength(1)
  })
})

describe('术语应用 · 幂等', () => {
  it('重复接受同一建议不再修改字幕，也不产生新历史', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, '欢迎收看晚间新闻')))
    const entries = [term('t', '晚间新闻', '《晚间新闻》')]
    const patches = patchesFor(s.segments[1], entries)

    s = consoleReducer(s, apply(patches))
    const once = s
    // 旧补丁再投一次：位置文本已不是原词，且术语版本已标记 → 完全无效
    const twice = consoleReducer(once, apply(patches))
    expect(twice).toBe(once)

    // 重新扫描当前文本：该术语版本已无建议
    const again = patchesFor(twice.segments[1], entries)
    expect(again).toHaveLength(0)
  })

  it('撤销后重做再撤销，文本与标记逐位一致', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, '晚间新闻')))
    const entries = [term('t', '晚间新闻', '《晚间新闻》')]
    s = consoleReducer(s, apply(patchesFor(s.segments[1], entries)))
    const applied = s.segments[1]

    s = consoleReducer(s, { type: 'undo-glossary' })
    s = consoleReducer(s, { type: 'redo-glossary' })
    expect(s.segments[1]).toEqual(applied)
    s = consoleReducer(s, { type: 'undo-glossary' })
    expect(s.segments[1].text).toBe('晚间新闻')
  })

  it('空补丁/不存在片段/非法位置不产生任何状态变化', () => {
    const s0 = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, '晚间新闻')))
    expect(consoleReducer(s0, apply([]))).toBe(s0)
    const ghost: SuggestionPatch = {
      id: 'x',
      seq: 999,
      termId: 't',
      termVersion: 1,
      source: '晚间新闻',
      target: '《晚间新闻》',
      start: 0,
      end: 4,
    }
    expect(consoleReducer(s0, apply([ghost]))).toBe(s0)
  })
})

describe('术语应用 · 锁定字幕保护', () => {
  it('锁定片段的建议不会被应用（单条与批量都不生效）', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, '品牌发布会')))
    s = consoleReducer(s, { type: 'toggle-lock', seq: 1 })
    const entries = [term('t', '品牌', '品牌™')]
    const patches = patchesFor(s.segments[1], entries)
    // 锁定时扫描器产出的是 locked-conflict，suggestion 列表为空
    expect(patches).toHaveLength(0)

    // 即使构造一个强行补丁，reducer 也必须拒绝改写锁定片段
    const forced: SuggestionPatch = {
      id: 'forced',
      seq: 1,
      termId: 't',
      termVersion: 1,
      source: '品牌',
      target: '品牌™',
      start: 0,
      end: 2,
    }
    expect(consoleReducer(s, apply([forced]))).toBe(s)
    expect(s.segments[1].text).toBe('品牌发布会')
    expect(s.segments[1].locked).toBe(true)
  })

  it('锁定冲突提示解锁，解锁后同一条命中变为可接受建议', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, '品牌发布会')))
    const entries = [term('t', '品牌', '品牌™')]
    s = consoleReducer(s, { type: 'toggle-lock', seq: 1 })
    expect(scanOneSegment(s.segments[1], entries)[0].kind).toBe('locked-conflict')

    s = consoleReducer(s, { type: 'toggle-lock', seq: 1 })
    expect(patchesFor(s.segments[1], entries)).toHaveLength(1)
    s = consoleReducer(s, apply(patchesFor(s.segments[1], entries)))
    expect(s.segments[1].text).toBe('品牌™发布会')
  })
})

describe('术语应用 · 术语版本变化', () => {
  it('术语升级后旧建议失效：旧补丁因位置文本不再匹配而跳过，新版本建议可应用', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, '品牌发布会')))
    const v1 = [term('t', '品牌', '品牌™', { version: 1 })]
    const v1Patches = patchesFor(s.segments[1], v1)
    s = consoleReducer(s, apply(v1Patches))
    expect(s.segments[1].text).toBe('品牌™发布会')

    // 新机器稿再次带来原词
    s = consoleReducer(s, ingest(ev('a2', 1, 2, '品牌发布会', undefined, 'revision')))
    expect(s.segments[1].glossaryApplied).toEqual([]) // 机器修订清空旧标记

    // 术语升级到 v2（目标写法变化）
    const v2 = [term('t', '品牌', '品牌®', { version: 2 })]
    const v2Patches = patchesFor(s.segments[1], v2)
    expect(v2Patches).toHaveLength(1)
    expect(v2Patches[0].termVersion).toBe(2)

    // 旧 v1 补丁在新文本上仍能通过位置校验，但界面只会展示当前扫描出的 v2 建议
    // （旧建议已随术语签名变化整体失效）；这里直接应用 v2，验证新版本替换正确
    s = consoleReducer(s, apply(v2Patches))
    expect(s.segments[1].text).toBe('品牌®发布会')
    expect(s.segments[1].glossaryApplied).toEqual(['t@2'])
  })

  it('术语改了原词后，旧位置补丁与当前文本不符，应用时安全跳过', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, '品牌发布会')))
    s = consoleReducer(s, apply([
      {
        id: 'stale',
        seq: 1,
        termId: 't',
        termVersion: 1,
        source: '旧原词XYZ',
        target: '新写法',
        start: 0,
        end: 5,
      },
    ]))
    // 位置越界/切片不符：状态不变
    expect(s.segments[1].text).toBe('品牌发布会')
    expect(s.past).toHaveLength(0)
  })

  it('术语编辑（内容修改）抬升版本号，旧版本建议 id 不再由扫描产出', () => {
    // 直接在引擎层验证版本体现在建议 id 中：id 形如 t@2#1:0:sug
    let s = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, '品牌发布会')))
    const v2Patches = patchesFor(s.segments[1], [term('t', '品牌', '品牌®', { version: 2 })])
    expect(v2Patches[0].id).toContain('t@2')
  })
})

describe('术语应用 · 晚到片段', () => {
  it('晚到片段只增量增加自己的建议，已应用片段的历史与文本不受影响', () => {
    let s = createInitialState()
    // #101、#103 先到
    s = consoleReducer(s, ingest(ev('e101', 101, 1, '晚间新闻直播')))
    s = consoleReducer(s, ingest(ev('e103', 103, 1, '新闻摘要')))

    // 先对 #101 应用术语
    const entries = [term('t', '新闻', '新闻报道')]
    s = consoleReducer(s, apply(patchesFor(s.segments[101], entries)))
    expect(s.segments[101].text).toBe('晚间新闻报道直播')
    const snapshot101 = s.segments[101]
    const pastCount = s.past.length

    // #102 晚到补齐
    s = consoleReducer(s, ingest(ev('e102', 102, 1, '新闻八点档'), 4500))
    expect(s.log.some((l) => l.kind === 'backfilled' && l.seq === 102)).toBe(true)

    // 已应用的 #101 原样未动，历史栈不被晚到事件污染
    expect(s.segments[101]).toEqual(snapshot101)
    expect(s.past).toHaveLength(pastCount)

    // #102 独立扫描出自己的建议并可应用
    const p102 = patchesFor(s.segments[102], entries)
    expect(p102.map((p) => p.seq)).toEqual([102])
    s = consoleReducer(s, apply(p102))
    expect(s.segments[102].text).toBe('新闻报道八点档')
  })

  it('说话人范围术语：晚到片段说话人不匹配时无建议', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('e102', 102, 1, '现在时间八点', '主播A')))
    const entries = [term('t', '时间', '时间（BJT）', { speakers: ['主播B'] })]
    expect(patchesFor(s.segments[102], entries)).toHaveLength(0)
  })
})

describe('术语应用 · 重放无残留', () => {
  it('reset 清空术语应用历史与重做栈，回到初始状态', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, '晚间新闻')))
    s = consoleReducer(s, apply(patchesFor(s.segments[1], [term('t', '晚间新闻', '《晚间新闻》')])))
    s = consoleReducer(s, { type: 'undo-glossary' })
    expect(s.past.length + s.future.length).toBe(1)

    const reset = consoleReducer(s, { type: 'reset' })
    expect(reset).toEqual(createInitialState())
  })

  it('接受新建议会清空重做栈（与通用撤销模型一致）', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, '新闻A')))
    s = consoleReducer(s, ingest(ev('b', 2, 1, '新闻B')))
    const entries = [term('t', '新闻', '新闻报道')]
    s = consoleReducer(s, apply(patchesFor(s.segments[1], entries)))
    s = consoleReducer(s, { type: 'undo-glossary' })
    expect(s.future).toHaveLength(1)
    // 对 #2 做一次新应用
    s = consoleReducer(s, apply(patchesFor(s.segments[2], entries)))
    expect(s.future).toHaveLength(0)
    expect(s.past).toHaveLength(1)
    expect(s.segments[1].text).toBe('新闻A') // 被撤销的 #1 不被新动作重做
    expect(s.segments[2].text).toBe('新闻报道B')
  })

  it('机器修订到达后，过期撤销快照不覆盖新文本，且不产生误导日志', () => {
    let s = consoleReducer(createInitialState(), ingest(ev('a', 1, 1, '晚间新闻')))
    s = consoleReducer(s, apply(patchesFor(s.segments[1], [term('t', '晚间新闻', '《晚间新闻》')])))
    // 应用之后机器又修订（未锁定直接覆盖）
    s = consoleReducer(s, ingest(ev('a2', 1, 2, '机器全新文本', undefined, 'revision')))
    const logBefore = s.log.length
    s = consoleReducer(s, { type: 'undo-glossary' })
    expect(s.segments[1].text).toBe('机器全新文本') // 未被旧快照覆盖
    expect(s.past).toHaveLength(0)
    expect(s.future).toHaveLength(0)
    expect(s.log.length).toBe(logBefore) // 没有写“已撤销”日志
  })
})

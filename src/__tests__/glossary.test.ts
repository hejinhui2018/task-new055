import { describe, expect, it } from 'vitest'
import {
  glossarySignature,
  scanOneSegment,
  scanSegments,
  segmentSignature,
  termAppliesToSegment,
  type GlossaryTerm,
  type ScanSegment,
  type TermEntry,
} from '../glossary'
import {
  createInitialGlossaryState,
  glossaryReducer,
  termEntries,
  type TermDraft,
} from '../glossaryReducer'

function term(partial: Partial<GlossaryTerm> & Pick<GlossaryTerm, 'source' | 'target'>): GlossaryTerm {
  return {
    id: partial.id ?? 't1',
    source: partial.source,
    target: partial.target,
    language: partial.language ?? 'zh',
    enabled: partial.enabled ?? true,
    seqStart: partial.seqStart ?? null,
    seqEnd: partial.seqEnd ?? null,
    speakers: partial.speakers ?? [],
    homophones: partial.homophones ?? [],
  }
}

function entry(t: GlossaryTerm, version = 1): TermEntry {
  return { term: t, version }
}

function seg(partial: Partial<ScanSegment> & { text: string }): ScanSegment {
  return {
    seq: partial.seq ?? 1,
    text: partial.text,
    locked: partial.locked ?? false,
    speaker: partial.speaker,
    glossaryApplied: partial.glossaryApplied ?? [],
    appliedTargets: partial.appliedTargets,
  }
}

const kindsOf = (matches: ReturnType<typeof scanOneSegment>) => matches.map((m) => m.kind)

describe('术语扫描 · 边界匹配', () => {
  it('英文术语按词边界匹配，不命中前缀/后缀粘连', () => {
    const gpu = entry(term({ id: 'gpu', source: 'GPU', target: 'GPU 图形处理器', language: 'en' }))

    // 两侧标点/中文/字符串边缘都算合法边界
    const ok = scanOneSegment(seg({ seq: 1, text: '新款 GPU 上市。' }), [gpu])
    expect(ok).toHaveLength(1)
    expect(ok[0]).toMatchObject({ kind: 'suggestion', start: 3, end: 6, matchedText: 'GPU' })

    // 右侧粘连字母/数字：GPUs 不是 GPU
    expect(kindsOf(scanOneSegment(seg({ text: 'GPUs 降价' }), [gpu]))).not.toContain('suggestion')
    // 左侧粘连字母/数字：M1GPU 里的 GPU 不是独立词
    expect(kindsOf(scanOneSegment(seg({ text: 'M1GPU 停产' }), [gpu]))).not.toContain('suggestion')
    // 连字符是边界：GPU-X 中的 GPU 是独立词
    expect(kindsOf(scanOneSegment(seg({ text: 'GPU-X 发布' }), [gpu]))).toContain('suggestion')
    // 大小写不敏感
    const lower = scanOneSegment(seg({ text: 'gpu 很热门' }), [gpu])
    expect(lower[0]).toMatchObject({ kind: 'suggestion', matchedText: 'gpu' })
  })

  it('中文术语按字面相邻匹配，允许构词嵌套', () => {
    const phone = entry(term({ id: 'phone', source: '手机', target: '智能手机' }))
    const matches = scanOneSegment(seg({ text: '智能手机销量创新高，手机配件热销' }), [phone])
    const sugs = matches.filter((m) => m.kind === 'suggestion')
    // 「智能手机」中的「手机」与独立「手机」都命中
    expect(sugs.map((m) => [m.start, m.end])).toEqual([
      [2, 4],
      [10, 12],
    ])
  })

  it('同一片段中的多处命中全部给出建议', () => {
    const news = entry(term({ id: 'news', source: '新闻', target: '新闻报道' }))
    const sugs = scanOneSegment(seg({ text: '新闻连着新闻' }), [news]).filter((m) => m.kind === 'suggestion')
    expect(sugs).toHaveLength(2)
  })
})

describe('术语扫描 · 重叠术语（最长匹配）', () => {
  const shortNews = entry(term({ id: 'news', source: '新闻', target: 'X' }))
  const eveningNews = entry(term({ id: 'evening', source: '晚间新闻', target: 'Y' }))

  it('长术语遮蔽同区间的短术语，被遮蔽命中标记为不适用并解释遮蔽方', () => {
    const matches = scanOneSegment(seg({ seq: 101, text: '欢迎收看晚间新闻直播' }), [shortNews, eveningNews])
    const sugs = matches.filter((m) => m.kind === 'suggestion')
    expect(sugs).toHaveLength(1)
    expect(sugs[0]).toMatchObject({ termId: 'evening', start: 4, end: 8 })

    const shadowed = matches.find((m) => m.kind === 'not-applicable' && m.termId === 'news')
    expect(shadowed).toBeDefined()
    expect(shadowed!.reason).toContain('最长匹配')
    expect(shadowed!.reason).toContain('晚间新闻')
  })

  it('短术语在长词之外的出现不受影响', () => {
    const sugs = scanOneSegment(seg({ text: '晚间新闻之后还有新闻摘要' }), [shortNews, eveningNews]).filter(
      (m) => m.kind === 'suggestion',
    )
    // 「晚间新闻」一条 + 独立「新闻」（新闻摘要处）一条
    expect(sugs.map((m) => m.termId).sort()).toEqual(['evening', 'news'])
  })

  it('等长重叠（两个术语原词相同）都保留为建议，交人工选择', () => {
    const a = entry(term({ id: 'a', source: 'M1', target: 'M1 芯片', language: 'en' }))
    const b = entry(term({ id: 'b', source: 'M1', target: 'M1 处理器', language: 'en' }))
    const sugs = scanOneSegment(seg({ text: 'M1 发布' }), [a, b]).filter((m) => m.kind === 'suggestion')
    expect(sugs).toHaveLength(2)
    expect(new Set(sugs.map((m) => m.termId))).toEqual(new Set(['a', 'b']))
  })
})

describe('术语扫描 · 锁定与同音歧义', () => {
  it('锁定片段的命中归类为人工锁定冲突，不自动建议', () => {
    const t = entry(term({ id: 't', source: '品牌', target: '品牌™' }))
    const matches = scanOneSegment(seg({ text: '品牌发布会', locked: true }), [t])
    expect(matches.map((m) => m.kind)).toEqual(['locked-conflict'])
    expect(matches[0].reason).toContain('已人工锁定')
  })

  it('片段出现同音词时归为同音歧义；原词并存时原词命中也降级', () => {
    const t = entry(
      term({ id: 't', source: '签证', target: '签注服务', homophones: ['签注'] }),
    )
    // 仅同音词出现
    const onlyHp = scanOneSegment(seg({ text: '已完成签注手续' }), [t])
    expect(onlyHp.map((m) => m.kind)).toEqual(['homophone'])
    expect(onlyHp[0].reason).toContain('同音词')

    // 原词与同音词同片段并存：原词命中也降级为歧义，不自动建议
    const both = scanOneSegment(seg({ text: '签证与签注不同' }), [t])
    expect(kindsOf(both)).not.toContain('suggestion')
    expect(kindsOf(both).every((k) => k === 'homophone')).toBe(true)
  })
})

describe('术语扫描 · 适用范围与不适用', () => {
  it('超出有效序号区间的片段完全不参与（连不适用也不报）', () => {
    const t = entry(term({ id: 't', source: '品牌', target: '品牌™', seqStart: 100, seqEnd: 200 }))
    expect(scanOneSegment(seg({ seq: 99, text: '品牌' }), [t])).toHaveLength(0)
    expect(scanOneSegment(seg({ seq: 201, text: '品牌' }), [t])).toHaveLength(0)
    // 边界为闭区间
    expect(scanOneSegment(seg({ seq: 100, text: '品牌' }), [t])).toHaveLength(1)
    expect(scanOneSegment(seg({ seq: 200, text: '品牌' }), [t])).toHaveLength(1)
  })

  it('说话人范围不匹配的片段不参与；匹配才扫描', () => {
    const t = entry(term({ id: 't', source: '时间', target: '时间（BJT）', speakers: ['主播B'] }))
    expect(scanOneSegment(seg({ text: '时间', speaker: '主播A' }), [t])).toHaveLength(0)
    expect(scanOneSegment(seg({ text: '时间' }), [t])).toHaveLength(0)
    expect(termAppliesToSegment(t, seg({ text: '时间', speaker: '主播B' }))).toBe(true)
    expect(scanOneSegment(seg({ text: '时间', speaker: '主播B' }), [t])[0].kind).toBe('suggestion')
  })

  it('停用术语不参与扫描', () => {
    const t = entry(term({ id: 't', source: '品牌', target: '品牌™', enabled: false }))
    expect(scanOneSegment(seg({ text: '品牌' }), [t])).toHaveLength(0)
  })

  it('生效范围内但文本无命中，归为不适用并解释', () => {
    const t = entry(term({ id: 't', source: '品牌', target: '品牌™' }))
    const matches = scanOneSegment(seg({ seq: 5, text: '完全无关的内容' }), [t])
    expect(matches).toHaveLength(1)
    expect(matches[0].kind).toBe('not-applicable')
    expect(matches[0].start).toBe(-1)
    expect(matches[0].reason).toContain('有效范围内')
  })
})

describe('术语扫描 · 幂等与版本', () => {
  it('片段已应用某术语版本后，该版本不再产出任何建议（含不适用）', () => {
    const t = entry(term({ id: 't', source: '品牌', target: '品牌™' }), 1)
    const s = seg({ text: '品牌', glossaryApplied: ['t@1'] })
    expect(scanOneSegment(s, [t])).toHaveLength(0)
  })

  it('术语升级到新版本后，新版本建议可以重新出现，旧版本不会复活', () => {
    const v1 = entry(term({ id: 't', source: '品牌', target: '品牌™' }), 1)
    // 已应用 v1、文本已替换为目标写法
    const applied = seg({ text: '品牌™', glossaryApplied: ['t@1'] })
    expect(scanOneSegment(applied, [v1])).toHaveLength(0)

    // v2：原词仍可能出现（例如目标写法调整后机器稿里仍有原词的另一处语境由调用方保证）
    const v2 = entry(term({ id: 't', source: '品牌', target: '品牌®' }), 2)
    // 当前文本是 v1 的目标写法：v2 不给可执行建议，而是解释已按旧版本规范化
    const covered = scanOneSegment(
      seg({ text: '品牌™', glossaryApplied: ['t@1'], appliedTargets: { t: ['品牌™'] } }),
      [v2],
    )
    expect(covered.filter((m) => m.kind === 'suggestion')).toHaveLength(0)
    expect(covered).toHaveLength(1)
    expect(covered[0].kind).toBe('not-applicable')
    expect(covered[0].reason).toContain('旧版本规范化')

    // 文本中再次出现原词（新机器稿）：v2 建议出现，v1 标记不阻止 v2
    const revised = seg({ seq: 1, text: '品牌', glossaryApplied: ['t@1'] })
    const sugs = scanOneSegment(revised, [v2]).filter((m) => m.kind === 'suggestion')
    expect(sugs).toHaveLength(1)
    expect(sugs[0]).toMatchObject({ termId: 't', termVersion: 2 })
  })

  it('术语表签名随内容/版本/启用状态变化，版本不变且内容不变时稳定', () => {
    const t = entry(term({ id: 't', source: 'A', target: 'B' }), 1)
    const sig1 = glossarySignature([t])
    expect(glossarySignature([t])).toBe(sig1)
    expect(glossarySignature([entry(term({ id: 't', source: 'A', target: 'C' }), 1)])).not.toBe(sig1)
    expect(glossarySignature([t, entry(term({ id: 'u', source: 'X', target: 'Y' }), 1)])).not.toBe(sig1)
    expect(glossarySignature([entry(term({ id: 't', source: 'A', target: 'B', enabled: false }), 1)])).not.toBe(sig1)
  })

  it('片段签名覆盖文本/锁定/说话人/已应用标记', () => {
    const base = seg({ seq: 1, text: 'A' })
    expect(segmentSignature(base)).toBe(segmentSignature(seg({ seq: 1, text: 'A' })))
    expect(segmentSignature(seg({ seq: 1, text: 'B' }))).not.toBe(segmentSignature(base))
    expect(segmentSignature(seg({ seq: 1, text: 'A', locked: true }))).not.toBe(segmentSignature(base))
    expect(segmentSignature(seg({ seq: 1, text: 'A', speaker: '主播A' }))).not.toBe(segmentSignature(base))
    expect(
      segmentSignature(seg({ seq: 1, text: 'A', glossaryApplied: ['t@1'] })),
    ).not.toBe(segmentSignature(base))
  })
})

describe('晚到片段增量扫描', () => {
  const terms = [
    entry(term({ id: 'news', source: '新闻', target: '新闻报道' })),
    entry(term({ id: 'gpu', source: 'GPU', target: 'GPU 图形处理器', language: 'en' })),
  ]

  it('只扫描新到达片段并与既有结果合并，未变片段结果可复用', () => {
    // 模拟 useSubtitleConsole 中的缓存算法：(gsig, ssig) 命中即复用旧结果引用
    const cache = new Map<number, { gsig: string; ssig: string; matches: ReturnType<typeof scanOneSegment> }>()
    const gsig = glossarySignature(terms)
    const scanIncrementally = (segments: ScanSegment[]) => {
      const out: ReturnType<typeof scanSegments> = []
      for (const s of segments) {
        const ssig = segmentSignature(s)
        const cached = cache.get(s.seq)
        if (cached && cached.gsig === gsig && cached.ssig === ssig) {
          out.push(...cached.matches)
          continue
        }
        const matches = scanOneSegment(s, terms) // 晚到片段只扫它自己
        cache.set(s.seq, { gsig, ssig, matches })
        out.push(...matches)
      }
      return out
    }

    // #101、#103 先到（#102 缺口）
    const first = [
      seg({ seq: 101, text: '晚间新闻直播' }),
      seg({ seq: 103, text: '新款 GPU 上市' }),
    ]
    const r1 = scanIncrementally(first)
    expect(new Set(r1.map((m) => m.seq))).toEqual(new Set([101, 103]))

    // #102 晚到：只增量扫描 #102
    const late = seg({ seq: 102, text: '新闻八点档' })
    const cached101 = cache.get(101)!
    const r2 = scanIncrementally([...first, late])
    expect(new Set(r2.map((m) => m.seq))).toEqual(new Set([101, 102, 103]))
    // #101/#103 未变化：缓存引用原样复用（没有重算）
    expect(cache.get(101)).toBe(cached101)
    expect(cache.get(101)!.matches).toBe(cached101.matches)
    // #102 的建议只含它自己的命中
    expect(cache.get(102)!.matches.every((m) => m.seq === 102)).toBe(true)
  })

  it('术语表版本变化时旧建议整体失效并按新术语重算（旧 id 不再出现）', () => {
    const cache = new Map<number, { gsig: string; ssig: string; matches: ReturnType<typeof scanOneSegment> }>()
    const run = (segments: ScanSegment[], gsig: string, activeTerms: TermEntry[]) => {
      const out: ReturnType<typeof scanSegments> = []
      for (const s of segments) {
        const ssig = segmentSignature(s)
        const cached = cache.get(s.seq)
        if (cached && cached.gsig === gsig && cached.ssig === ssig) {
          out.push(...cached.matches)
          continue
        }
        const matches = scanOneSegment(s, activeTerms)
        cache.set(s.seq, { gsig, ssig, matches })
        out.push(...matches)
      }
      return out
    }

    const segs = [seg({ seq: 1, text: '新款 GPU 上市' })]
    const v1 = [entry(term({ id: 'gpu', source: 'GPU', target: 'GPU 图形处理器', language: 'en' }), 1)]
    const before = run(segs, glossarySignature(v1), v1)
    const oldId = before[0].id
    expect(oldId).toContain('gpu@1')

    // 术语表修改：目标写法变化、版本抬升到 2，签名变化
    const v2 = [entry(term({ id: 'gpu', source: 'GPU', target: 'GPU 加速卡', language: 'en' }), 2)]
    const after = run(segs, glossarySignature(v2), v2)
    // 旧建议 id 彻底消失，新建议携带新版本与新目标
    expect(after.some((m) => m.id === oldId)).toBe(false)
    expect(after).toHaveLength(1)
    expect(after[0].id).toContain('gpu@2')
    expect(after[0].target).toBe('GPU 加速卡')
  })

  it('晚到片段仅受相关术语影响，范围外术语不产出结果', () => {
    const scoped = entry(term({ id: 's', source: '时间', target: '时间（BJT）', seqStart: 200, seqEnd: 300 }))
    const late = seg({ seq: 102, text: '现在时间八点' })
    expect(scanOneSegment(late, [scoped])).toHaveLength(0)
  })
})

describe('版本化术语表 reducer', () => {
  const draft = (over: Partial<TermDraft> = {}): TermDraft => ({
    source: '品牌',
    target: '品牌™',
    language: 'zh',
    enabled: true,
    seqStart: null,
    seqEnd: null,
    speakers: [],
    homophones: [],
    ...over,
  })

  it('新增术语版本从 1 开始，内容修改版本 +1，停用不抬版本', () => {
    let g = createInitialGlossaryState()
    const initialCount = g.order.length
    g = glossaryReducer(g, { type: 'add-term', draft: draft() })
    const id = `term-${initialCount + 1}`
    expect(g.terms[id].version).toBe(1)

    g = glossaryReducer(g, { type: 'update-term', id, draft: draft({ target: '品牌®' }) })
    expect(g.terms[id].version).toBe(2)
    expect(g.terms[id].term.target).toBe('品牌®')

    g = glossaryReducer(g, { type: 'toggle-enabled', id })
    expect(g.terms[id].version).toBe(2)
    expect(g.terms[id].term.enabled).toBe(false)
  })

  it('术语表自身的编辑支持撤销重做，术语变化后旧版本建议失效（id 中带新版本）', () => {
    let g = createInitialGlossaryState()
    g = glossaryReducer(g, { type: 'add-term', draft: draft() })
    const id = `term-${g.order.length}`
    g = glossaryReducer(g, { type: 'update-term', id, draft: draft({ target: '品牌®' }) })
    expect(termEntries(g).find((e) => e.term.id === id)!.version).toBe(2)

    g = glossaryReducer(g, { type: 'undo-glossary' })
    expect(termEntries(g).find((e) => e.term.id === id)!.version).toBe(1)
    g = glossaryReducer(g, { type: 'redo-glossary' })
    expect(termEntries(g).find((e) => e.term.id === id)!.version).toBe(2)
  })

  it('相同内容保存不抬版本；删除后不再参与扫描', () => {
    let g = createInitialGlossaryState()
    g = glossaryReducer(g, { type: 'add-term', draft: draft() })
    const id = `term-${g.order.length}`
    const before = g.terms[id]
    g = glossaryReducer(g, { type: 'update-term', id, draft: draft() })
    expect(g.terms[id]).toBe(before)

    g = glossaryReducer(g, { type: 'delete-term', id })
    expect(g.terms[id]).toBeUndefined()
    expect(g.order).not.toContain(id)
  })
})

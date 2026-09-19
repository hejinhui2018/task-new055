/**
 * 版本化术语校对扫描引擎（纯函数，不读时钟、无随机性，结果可稳定重放）。
 *
 * 输入“当前字幕片段 + 术语表快照”，输出四类匹配：
 *   - suggestion       原词命中、边界合法、无同音干扰、片段未锁定 → 可接受建议
 *   - locked-conflict  片段已人工锁定，原词虽命中也不会自动替换
 *   - homophone        同音词出现（或原词与同音词在同一片段并存），是否替换有歧义
 *   - not-applicable   片段在术语的有效范围内，但没有可替换的命中
 *                      （含被更长术语遮蔽的重叠命中）
 *
 * 超出序号/说话人范围的片段从一开始就不参与扫描，不计入任何类别。
 */

export type TermLanguage = 'zh' | 'en'

/** 节目专用术语（品牌名、人名、产品型号等） */
export interface GlossaryTerm {
  id: string
  /** 原词（字幕里可能出现的写法） */
  source: string
  /** 目标写法（运营确认的规范写法） */
  target: string
  /** 语言提示，主要用于边界策略；实际边界按原词首尾字符逐边判定 */
  language: TermLanguage
  /** 停用的术语不参与扫描 */
  enabled: boolean
  /** 有效序号区间（闭区间），null 表示该侧不限制；充当“有效时间”范围 */
  seqStart: number | null
  seqEnd: number | null
  /** 生效说话人列表；空数组表示不限制说话人 */
  speakers: string[]
  /** 同音词：与原词发音相同、写法不同的词，出现即意味着歧义 */
  homophones: string[]
}

/** 扫描时术语表中一条“术语 + 当前版本号”的快照 */
export interface TermEntry {
  term: GlossaryTerm
  /** 术语版本号，术语每次修改单调递增；删除后重建的术语重新从 1 开始 */
  version: number
}

export type MatchKind = 'suggestion' | 'locked-conflict' | 'homophone' | 'not-applicable'

/** 一条扫描结果（建议）。id 由术语版本/序号/位置确定性拼出，便于测试断言 */
export interface GlossaryMatch {
  id: string
  seq: number
  termId: string
  termVersion: number
  kind: MatchKind
  source: string
  target: string
  /** 命中原词（或同音词）在片段文本中的起止位置；not-applicable 无命中时为 -1 */
  start: number
  end: number
  /** 文本中实际命中的字面值（英文匹配可能与原词大小写不同） */
  matchedText: string
  /** 匹配依据的人话解释，直接展示给运营 */
  reason: string
}

/** 扫描所需的片段视图（结构子集，便于单测直接构造） */
export interface ScanSegment {
  seq: number
  text: string
  locked: boolean
  speaker?: string
  /** 片段上已应用的术语标记 `termId@version` */
  glossaryApplied: string[]
  /** 已应用术语各版本的目标写法（termId -> 目标写法），用于识别已规范化文本 */
  appliedTargets?: Record<string, string[]>
}

/** 找出关键词在文本中的全部出现位置（不做边界检查，仅用于目标写法的包含判断） */
function findOccurrences(text: string, keyword: string): Array<{ start: number; end: number }> {
  const kw = keyword.trim()
  if (!kw) return []
  const ascii = /[A-Za-z]/.test(kw)
  const haystack = ascii ? text.toLowerCase() : text
  const needle = ascii ? kw.toLowerCase() : kw
  const out: Array<{ start: number; end: number }> = []
  let from = 0
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    out.push({ start: idx, end: idx + needle.length })
    from = idx + needle.length
  }
  return out
}

interface RawHit {
  entry: TermEntry
  start: number
  end: number
  matchedText: string
}

const LATIN_WORD = /[A-Za-z0-9_]/

/** 拉丁词字符：英文术语要求两侧不是字母/数字/下划线（\b 语义，手工实现以支持混合字符串） */
function isLatinWordChar(ch: string | undefined): boolean {
  return ch !== undefined && LATIN_WORD.test(ch)
}

/**
 * 判断一次命中的边界是否合法：按原词“首/尾字符”逐边判定。
 *  - 首尾是拉丁字符的一侧，要求文本相邻字符不是拉丁词字符（GPU 不匹配 GPUs / M1GPU 里的 GPU）
 *  - 首尾是中文等非拉丁字符的一侧不做限制（中文构词允许嵌套，如「手机」可命中「智能手机」）
 */
function hasValidBoundary(text: string, start: number, end: number, source: string): boolean {
  const leftSourceChar = source[0]
  const rightSourceChar = source[source.length - 1]
  if (isLatinWordChar(leftSourceChar) && isLatinWordChar(text[start - 1])) return false
  if (isLatinWordChar(rightSourceChar) && isLatinWordChar(text[end])) return false
  return true
}

/** 找出一个关键词在文本中的全部合法边界命中；英文按大小写不敏感匹配，中文按字面匹配 */
function findHits(text: string, keyword: string): Array<{ start: number; end: number; matchedText: string }> {
  const kw = keyword.trim()
  if (!kw) return []
  const ascii = /[A-Za-z]/.test(kw)
  const haystack = ascii ? text.toLowerCase() : text
  const needle = ascii ? kw.toLowerCase() : kw
  const hits: Array<{ start: number; end: number; matchedText: string }> = []
  let from = 0
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    const end = idx + needle.length
    if (hasValidBoundary(text, idx, end, kw)) {
      hits.push({ start: idx, end, matchedText: text.slice(idx, end) })
    }
    from = idx + 1 // 允许重叠候选，由最长匹配统一裁决
  }
  return hits
}

/** 术语是否对该片段生效：启用状态、有效序号区间、说话人范围 */
export function termAppliesToSegment(entry: TermEntry, seg: ScanSegment): boolean {
  const t = entry.term
  if (!t.enabled) return false
  if (!t.source.trim()) return false
  if (t.seqStart !== null && seg.seq < t.seqStart) return false
  if (t.seqEnd !== null && seg.seq > t.seqEnd) return false
  if (t.speakers.length > 0) {
    if (!seg.speaker || !t.speakers.includes(seg.speaker)) return false
  }
  return true
}

function scopeText(entry: TermEntry): string {
  const t = entry.term
  const parts: string[] = []
  if (t.seqStart !== null || t.seqEnd !== null) {
    parts.push(`序号 ${t.seqStart ?? '−∞'}–${t.seqEnd ?? '+∞'}`)
  }
  if (t.speakers.length > 0) parts.push(`说话人 ${t.speakers.join('/')}`)
  return parts.length > 0 ? `（生效范围：${parts.join('，')}）` : ''
}

function matchId(entry: TermEntry, seq: number, start: number, tag: string): string {
  return `${entry.term.id}@${entry.version}#${seq}:${start === -1 ? 'na' : start}:${tag}`
}

/**
 * 重叠术语消解：命中区间相交时，只有“严格更长”的命中可以遮蔽较短者（最长匹配）。
 * 等长重叠（两个术语原词相同、各有目标写法）都保留，作为两条建议交人工选择。
 * 被遮蔽的命中不再单独建议，改报 not-applicable 并解释遮蔽方。
 */
function resolveOverlaps(hits: RawHit[]): { winners: RawHit[]; shadowed: Array<{ hit: RawHit; by: RawHit }> } {
  const winners: RawHit[] = []
  const shadowed: Array<{ hit: RawHit; by: RawHit }> = []
  for (const hit of hits) {
    const len = hit.end - hit.start
    const blocker = hits.find(
      (other) =>
        other !== hit &&
        other.start < hit.end &&
        hit.start < other.end &&
        other.end - other.start > len,
    )
    if (blocker) shadowed.push({ hit, by: blocker })
    else winners.push(hit)
  }
  return { winners, shadowed }
}

/** 扫描单个片段；输出按位置与类别排序，保证可稳定重放与断言 */
export function scanOneSegment(seg: ScanSegment, entries: TermEntry[]): GlossaryMatch[] {
  const out: GlossaryMatch[] = []

  // 1) 收集所有生效术语的原词命中
  const applicable = entries.filter((entry) => termAppliesToSegment(entry, seg))
  const sourceHits: RawHit[] = []
  const homophoneWords = new Map<TermEntry, string[]>()
  /** 原词全部落在旧版本目标写法内的术语：视为已规范化，不再登记“不适用” */
  const coveredTerms = new Set<string>()

  for (const entry of applicable) {
    const marker = `${entry.term.id}@${entry.version}`
    // 幂等：该术语版本已经应用到片段上，重复扫描不再产出任何建议
    if (seg.glossaryApplied.includes(marker)) continue

    // 中文目标写法常包含原词（晚间新闻→《晚间新闻》）：术语升级版本后旧标记不再阻止
    // 新版本，但落在“已应用目标写法”区间内的原词命中视为已规范化，不再建议。
    const priorTargets = seg.appliedTargets?.[entry.term.id] ?? []
    const covered = priorTargets.flatMap((target) => findOccurrences(seg.text, target))
    const insidePriorTarget = (start: number, end: number) =>
      covered.some((c) => c.start <= start && end <= c.end)

    const hits = findHits(seg.text, entry.term.source)
    if (hits.length > 0) {
      const kept = hits.filter((h) => !insidePriorTarget(h.start, h.end))
      sourceHits.push(...kept.map((h) => ({ entry, ...h })))
      if (kept.length === 0) coveredTerms.add(entry.term.id) // 原词全部位于已规范化文本内
    }

    const hpWords = entry.term.homophones
      .map((hp) => hp.trim())
      .filter((hp) => hp.length > 0 && findHits(seg.text, hp).length > 0)
    if (hpWords.length > 0) homophoneWords.set(entry, [...new Set(hpWords)])
  }

  // 2) 最长匹配消解重叠
  const { winners, shadowed } = resolveOverlaps(sourceHits)

  for (const { hit, by } of shadowed) {
    out.push({
      id: matchId(hit.entry, seg.seq, hit.start, 'shadow'),
      seq: seg.seq,
      termId: hit.entry.term.id,
      termVersion: hit.entry.version,
      kind: 'not-applicable',
      source: hit.entry.term.source,
      target: hit.entry.term.target,
      start: hit.start,
      end: hit.end,
      matchedText: hit.matchedText,
      reason: `原词「${hit.entry.term.source}」在位置 ${hit.start}–${hit.end} 的命中与更长术语「${by.entry.term.source}」（位置 ${by.start}–${by.end}）重叠，按最长匹配已被遮蔽，不再单独建议`,
    })
  }

  // 3) 胜出命中逐条分类
  for (const hit of winners) {
    const { entry } = hit
    const hpWords = homophoneWords.get(entry) ?? []
    const base = {
      seq: seg.seq,
      termId: entry.term.id,
      termVersion: entry.version,
      source: entry.term.source,
      target: entry.term.target,
      start: hit.start,
      end: hit.end,
      matchedText: hit.matchedText,
    }
    if (hpWords.length > 0) {
      out.push({
        ...base,
        id: matchId(entry, seg.seq, hit.start, 'amb'),
        kind: 'homophone',
        reason: `原词「${entry.term.source}」在位置 ${hit.start}–${hit.end} 命中，但同一片段出现同音词「${hpWords.join(
          '、',
        )}」，写法存在歧义，不自动建议替换为「${entry.term.target}」${scopeText(entry)}`,
      })
      continue
    }
    if (seg.locked) {
      out.push({
        ...base,
        id: matchId(entry, seg.seq, hit.start, 'lock'),
        kind: 'locked-conflict',
        reason: `原词「${entry.term.source}」在位置 ${hit.start}–${hit.end} 按${
          /[A-Za-z]/.test(entry.term.source) ? '英文词边界' : '字面相邻'
        }命中，但片段已人工锁定，术语替换不会自动执行，请先解锁或人工处理${scopeText(entry)}`,
      })
      continue
    }
    out.push({
      ...base,
      id: matchId(entry, seg.seq, hit.start, 'sug'),
      kind: 'suggestion',
      reason: `原词「${entry.term.source}」在位置 ${hit.start}–${hit.end} 按${
        /[A-Za-z]/.test(entry.term.source) ? '英文词边界' : '左右非字母数字'
      }匹配命中，片段未锁定且无同音干扰，可替换为规范写法「${entry.term.target}」${scopeText(entry)}`,
    })
  }

  // 4) 同音词本身也要逐条标出（即使原词未命中）
  for (const [entry, hpWords] of homophoneWords) {
    // 原词已有胜出命中时，歧义已在第 3 步报出，这里只补“仅同音词出现”的位置
    const hasWinningSourceHit = winners.some((w) => w.entry === entry)
    for (const hp of hpWords) {
      for (const h of findHits(seg.text, hp)) {
        if (hasWinningSourceHit) continue
        out.push({
          id: matchId(entry, seg.seq, h.start, `hp:${hp}`),
          seq: seg.seq,
          termId: entry.term.id,
          termVersion: entry.version,
          kind: 'homophone',
          source: entry.term.source,
          target: entry.term.target,
          start: h.start,
          end: h.end,
          matchedText: h.matchedText,
          reason: `同音词「${hp}」在位置 ${h.start}–${h.end} 出现，与原词「${entry.term.source}」同音，无法判定是否应写作「${entry.term.target}」，需人工判断${scopeText(entry)}`,
        })
      }
    }
  }

  // 5) 生效但既无原词命中也无同音词的术语：登记一条“不适用”，解释扫描过但无需替换
  for (const entry of applicable) {
    const marker = `${entry.term.id}@${entry.version}`
    if (seg.glossaryApplied.includes(marker)) continue
    const involved = out.some((m) => m.termId === entry.term.id && m.termVersion === entry.version)
    if (!involved) {
      const priorTargets = seg.appliedTargets?.[entry.term.id] ?? []
      const coveredReason =
        coveredTerms.has(entry.term.id) && priorTargets.length > 0
          ? `文本中的原词「${entry.term.source}」均已按该术语旧版本规范化为「${priorTargets.join('、')}」，新版本不在已规范文本上二次建议；如需改成新写法「${entry.term.target}」请人工处理`
          : `片段在术语「${entry.term.source}」的有效范围内，但文本未出现原词或同音词，无需替换`
      out.push({
        id: matchId(entry, seg.seq, -1, coveredTerms.has(entry.term.id) ? 'covered' : 'none'),
        seq: seg.seq,
        termId: entry.term.id,
        termVersion: entry.version,
        kind: 'not-applicable',
        source: entry.term.source,
        target: entry.term.target,
        start: -1,
        end: -1,
        matchedText: '',
        reason: `${coveredReason}${coveredTerms.has(entry.term.id) ? '' : scopeText(entry)}`,
      })
    }
  }

  const kindOrder: Record<MatchKind, number> = {
    suggestion: 0,
    'locked-conflict': 1,
    homophone: 2,
    'not-applicable': 3,
  }
  return out.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    if (kindOrder[a.kind] !== kindOrder[b.kind]) return kindOrder[a.kind] - kindOrder[b.kind]
    return a.id.localeCompare(b.id)
  })
}

/** 扫描全部片段。晚到片段到达时，调用方可只传入变化片段做增量，再按 id 合并 */
export function scanSegments(segments: ScanSegment[], entries: TermEntry[]): GlossaryMatch[] {
  return segments.flatMap((seg) => scanOneSegment(seg, entries)).sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq
    if (a.start !== b.start) return a.start - b.start
    return a.id.localeCompare(b.id)
  })
}

/**
 * 术语表版本签名：术语内容或版本任一变化都会改变签名。
 * 预览期间术语表变化时，调用方据此让旧建议整体失效并重新计算。
 */
export function glossarySignature(entries: TermEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.term.id.localeCompare(b.term.id))
  return JSON.stringify(
    sorted.map(({ term, version }) => [
      term.id,
      version,
      term.enabled ? 1 : 0,
      term.source,
      term.target,
      term.language,
      term.seqStart,
      term.seqEnd,
      term.speakers.join('|'),
      term.homophones.join('|'),
    ]),
  )
}

/** 片段签名：文本/锁定/说话人/已应用标记任一变化才需重新扫描该片段（晚到增量扫描依据） */
export function segmentSignature(seg: ScanSegment): string {
  return JSON.stringify([
    seg.seq,
    seg.locked ? 1 : 0,
    seg.speaker ?? '',
    seg.glossaryApplied,
    seg.appliedTargets ?? {},
    seg.text,
  ])
}

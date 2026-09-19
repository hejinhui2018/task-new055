import type {
  SegmentScan,
  SubtitleSegment,
  Term,
  TermMatch,
  TermMatchKind,
} from './types'

/**
 * 术语扫描器：纯函数，不读时钟、无随机性。
 *
 * 给定一条片段与当前版本的术语表，产出该片段的全部匹配建议，
 * 并为每条建议附人类可读的匹配依据 / 排除理由。
 *
 * 分类：
 *   auto             命中原词、范围匹配、片段未锁定 → 可自动建议
 *   locked-conflict  片段已人工锁定 → 绝不自动改，提示人工处理
 *   homophone        命中同音词 → 听音歧义，不自动建议
 *   not-applicable   语言 / 说话人 / 有效时间不符，或被更长的重叠术语遮蔽
 */

/**
 * 词边界字符：只把 ASCII 字母数字下划线视为“单词内部”。
 * 中文/日文/韩文文本没有空格分词，相邻 CJK 字不阻断匹配（如「晚间新闻」可在「收看晚间新闻直播」中命中）；
 * CJK 之间的包含关系交给“更长重叠术语胜出”仲裁。而 Latin/数字串严格要求边界，
 * 例如 iPhone15 不会命中 iPhone15ProMax 的内部子串，AI 不会命中 AIDE。
 */
function isBoundaryChar(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return /[A-Za-z0-9_]/.test(ch)
}

/** word 是否在 text 的 index 处构成“边界完整匹配”（不匹配更长拉丁/数字单词的内部子串） */
function isBoundaryAt(text: string, index: number, word: string): boolean {
  if (index < 0 || text.substr(index, word.length) !== word) return false
  const before = text[index - 1]
  const after = text[index + word.length]
  return !isBoundaryChar(before) && !isBoundaryChar(after)
}

/** 找出 word 在 text 中所有边界匹配的起始位置 */
export function findOccurrences(text: string, word: string): number[] {
  const out: number[] = []
  if (!word) return out
  let from = 0
  for (;;) {
    const idx = text.indexOf(word, from)
    if (idx < 0) break
    if (isBoundaryAt(text, idx, word)) out.push(idx)
    from = idx + word.length
  }
  return out
}

/** 边界感知的全局替换：只替换边界完整的出现，绝不破坏更长单词的内部 */
export function replaceOccurrences(text: string, source: string, target: string): string {
  const hits = findOccurrences(text, source)
  if (hits.length === 0) return text
  let out = ''
  let cursor = 0
  for (const idx of hits) {
    out += text.slice(cursor, idx) + target
    cursor = idx + source.length
  }
  out += text.slice(cursor)
  return out
}

interface ScopeResult {
  ok: boolean
  reason: string
}

function fmtRange(fromMs?: number, toMs?: number): string {
  const f = fromMs === undefined ? '节目开始' : `+${(fromMs / 1000).toFixed(1)}s`
  const t = toMs === undefined ? '节目结束' : `+${(toMs / 1000).toFixed(1)}s`
  return `${f}~${t}`
}

/** 语言 / 说话人 / 有效时间三维范围判定 */
function checkScope(term: Term, seg: SubtitleSegment): ScopeResult {
  if (term.lang) {
    if (!seg.lang) {
      return { ok: false, reason: `片段缺少语言信息，无法确认属于术语适用语言「${term.lang}」` }
    }
    if (seg.lang !== term.lang) {
      return {
        ok: false,
        reason: `片段语言「${seg.lang}」不在术语适用语言「${term.lang}」范围内`,
      }
    }
  }
  if (term.speakers && term.speakers.length > 0) {
    if (!seg.speaker) {
      return {
        ok: false,
        reason: `片段缺少说话人信息，无法确认属于适用说话人（${term.speakers.join('、')}）`,
      }
    }
    if (!term.speakers.includes(seg.speaker)) {
      return {
        ok: false,
        reason: `说话人「${seg.speaker}」不在术语适用说话人范围（${term.speakers.join('、')}）内`,
      }
    }
  }
  if (term.validFromMs !== undefined || term.validToMs !== undefined) {
    if (seg.startMs === undefined || seg.endMs === undefined) {
      return { ok: false, reason: `片段缺少时间信息，无法确认落在术语有效期 ${fmtRange(term.validFromMs, term.validToMs)} 内` }
    }
    const from = term.validFromMs ?? Number.NEGATIVE_INFINITY
    const to = term.validToMs ?? Number.POSITIVE_INFINITY
    // 闭区间相交判定：片段时间窗与术语有效期没有重叠才排除
    if (seg.endMs < from || seg.startMs > to) {
      return {
        ok: false,
        reason: `片段时间 ${fmtRange(seg.startMs, seg.endMs)} 与术语有效期 ${fmtRange(
          term.validFromMs,
          term.validToMs,
        )} 不重叠`,
      }
    }
  }
  return { ok: true, reason: '' }
}

interface Occurrence {
  term: Term
  /** 该出现的实际文本：原词或同音词 */
  word: string
  start: number
  end: number
  kind: TermMatchKind
  /** 已应用术语的遮蔽位：只参与重叠占坑，不产生建议条目 */
  shield?: boolean
}

const KIND_RANK: Record<TermMatchKind, number> = {
  // 重叠选择时越保守越优先占坑：同音歧义 / 锁定保护 都不得被自动建议的替换破坏
  homophone: 0,
  'locked-conflict': 1,
  auto: 2,
  'not-applicable': 3,
}

function matchKey(seq: number, termId: string, termVersion: number): string {
  return `${seq}::${termId}@${termVersion}`
}

/** 只替换指定位置区间（同一原词的部分出现可能因重叠而不替换） */
export function replaceAtOccurrences(
  text: string,
  ranges: Array<[number, number]>,
  source: string,
  target: string,
): string {
  const sorted = ranges.slice().sort((a, b) => b[0] - a[0])
  let out = text
  for (const [start, end] of sorted) {
    if (text.slice(start, end) !== source) continue // 防御：区间必须确实是原词
    out = out.slice(0, start) + target + out.slice(end)
  }
  return out
}

/** 扫描单条片段；termVersion 写入缓存，术语表任何变动都会让调用方丢弃旧缓存 */
export function scanSegment(
  seg: SubtitleSegment,
  terms: Term[],
  termVersion: number,
): SegmentScan {
  const active = terms.filter((t) => t.enabled && t.source.trim().length > 0)
  const notApplicable: TermMatch[] = []
  /** 待仲裁出现（原词 / 同音词），按出现位置独立参与重叠选择 */
  const occurrences: Occurrence[] = []
  /** 已应用术语当前版本的原词区间：最高优先占坑，阻止二次修改 */
  const shields: Occurrence[] = []

  for (const term of active) {
    const scope = checkScope(term, seg)
    if (!scope.ok) {
      // 只有文本里确实出现了原词或同音写法，“不适用”才值得向运营解释；
      // 文本根本不涉及该术语时静默跳过（晚到片段也因此只与相关术语产生记录）。
      const appearsHere =
        findOccurrences(seg.text, term.source).length > 0 ||
        (term.homophones ?? []).some((w) => findOccurrences(seg.text, w).length > 0)
      if (appearsHere) {
        notApplicable.push({
          key: matchKey(seg.seq, term.id, term.version),
          seq: seg.seq,
          termId: term.id,
          termVersion,
          kind: 'not-applicable',
          matchedText: term.source,
          index: null,
          replacement: null,
          reason: scope.reason,
        })
      }
      continue
    }

    // 幂等：该术语的当前版本已经应用过（即使人工又把原词改回来），不再给建议；
    // 其原词区间仍作为遮蔽位参与重叠仲裁，阻止别的短词对同一区间二次修改。
    if (seg.appliedTerms?.[term.id] === term.version) {
      const appliedHits = findOccurrences(seg.text, term.source)
      if (appliedHits.length > 0) {
        for (const i of appliedHits) {
          shields.push({ term, word: term.source, start: i, end: i + term.source.length, kind: 'not-applicable', shield: true })
        }
        notApplicable.push({
          key: matchKey(seg.seq, term.id, term.version),
          seq: seg.seq,
          termId: term.id,
          termVersion,
          kind: 'not-applicable',
          matchedText: term.source,
          index: null,
          replacement: null,
          reason: `术语「${term.source}→${term.target}」v${term.version} 已在本片段应用，重复接受不会再次修改字幕`,
        })
      }
      continue
    }

    if (term.source === term.target) {
      if (findOccurrences(seg.text, term.source).length > 0) {
        notApplicable.push({
          key: matchKey(seg.seq, term.id, term.version),
          seq: seg.seq,
          termId: term.id,
          termVersion,
          kind: 'not-applicable',
          matchedText: term.source,
          index: null,
          replacement: null,
          reason: '原词与目标写法完全相同，替换不会改变字幕，不生成建议',
        })
      }
      continue
    }

    // 同音词出现位置
    const homoOccs: Occurrence[] = []
    for (const word of term.homophones ?? []) {
      for (const i of findOccurrences(seg.text, word)) {
        homoOccs.push({ term, word, start: i, end: i + word.length, kind: 'homophone' })
      }
    }
    const sourceIdx = findOccurrences(seg.text, term.source)
    if (homoOccs.length > 0) {
      // 保守原则：只要片段里出现同音写法，原词出现也一律按歧义处理（绝不自动替换）
      occurrences.push(...homoOccs)
      for (const i of sourceIdx) {
        occurrences.push({ term, word: term.source, start: i, end: i + term.source.length, kind: 'homophone' })
      }
      continue
    }

    const kind: TermMatchKind = seg.locked ? 'locked-conflict' : 'auto'
    for (const i of sourceIdx) {
      occurrences.push({ term, word: term.source, start: i, end: i + term.source.length, kind })
    }
  }

  // 重叠仲裁（按“每个出现位置”独立选择）：
  // 已应用遮蔽位最先占坑；其余按 保守度 > 命中长度（更长更具体）> 位置 > termId 排序。
  // 同一术语的多个出现可以部分入选、部分被遮蔽。
  const occupied: Array<{ start: number; end: number; term: Term; shield?: boolean }> = shields.map((o) => ({
    start: o.start,
    end: o.end,
    term: o.term,
    shield: true,
  }))
  const ordered = occurrences.slice().sort((a, b) => {
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind]
    const lenDiff = b.word.length - a.word.length
    if (lenDiff !== 0) return lenDiff
    if (a.start !== b.start) return a.start - b.start
    return a.term.id.localeCompare(b.term.id)
  })

  const accepted = new Map<string, Occurrence[]>()
  const blocked = new Map<string, Array<{ occ: Occurrence; by: { term: Term; shield?: boolean } }>>()
  for (const occ of ordered) {
    const holder = occupied.find((o) => o.start < occ.end && occ.start < o.end)
    if (holder) {
      const list = blocked.get(occ.term.id) ?? []
      list.push({ occ, by: holder })
      blocked.set(occ.term.id, list)
      continue
    }
    occupied.push({ start: occ.start, end: occ.end, term: occ.term })
    const list = accepted.get(occ.term.id) ?? []
    list.push(occ)
    accepted.set(occ.term.id, list)
  }

  const matches: TermMatch[] = []
  for (const [termId, occs] of accepted) {
    const term = occs[0].term
    const first = occs.slice().sort((a, b) => a.start - b.start)[0]
    const kind = first.kind
    const blockedList = blocked.get(termId) ?? []
    blocked.delete(termId) // 已有入选出现的术语不再出“不适用”条目，遮蔽信息并入理由

    let reason: string
    if (kind === 'homophone') {
      const words = Array.from(new Set(occs.map((o) => o.word))).map((w) => `「${w}」`).join('、')
      reason =
        `出现同音写法 ${words}（术语「${term.source}→${term.target}」，第 ${occs.map((o) => o.start + 1).join('、')} 字处），` +
        `可能是「${term.source}」也可能不是，需人工听音确认，不自动替换` +
        (seg.locked ? '；片段已人工锁定' : '')
    } else {
      reason =
        `边界完整匹配原词「${term.source}」（第 ${occs.map((o) => o.start + 1).join('、')} 字处，采纳 ${occs.length} 处），` +
        `语言 / 说话人 / 有效时间均在范围内，建议统一写作「${term.target}」` +
        (kind === 'locked-conflict' ? '；但片段已人工锁定，不能自动替换，请解锁后人工处理或裁决' : '')
    }
    if (blockedList.length > 0) {
      const who = blockedList[0].by
      reason +=
        `；另有 ${blockedList.length} 处与${who.shield ? '已应用术语' : '更高优先级术语'}「${who.term.source}→${who.term.target}」重叠，未纳入本条`
    }

    const autoRanges: Array<[number, number]> =
      kind === 'auto'
        ? occs.filter((o) => o.word === term.source).map((o) => [o.start, o.end] as [number, number])
        : []
    matches.push({
      key: matchKey(seg.seq, termId, term.version),
      seq: seg.seq,
      termId,
      termVersion,
      kind,
      matchedText: first.word,
      index: first.start,
      replacement: kind === 'auto' ? replaceAtOccurrences(seg.text, autoRanges, term.source, term.target) : null,
      acceptedRanges: kind === 'auto' ? autoRanges : undefined,
      reason,
    })
  }

  // 全部出现都被遮蔽的术语：给一条“不适用”解释原因
  for (const [termId, list] of blocked) {
    const { occ, by } = list[0]
    notApplicable.push({
      key: matchKey(seg.seq, termId, occ.term.version),
      seq: seg.seq,
      termId,
      termVersion,
      kind: 'not-applicable',
      matchedText: occ.word,
      index: null,
      replacement: null,
      reason: by.shield
        ? `命中区间落在已应用术语「${by.term.source}→${by.term.target}」v${by.term.version} 的文本内，该区间已校对完成，本条不再重复修改，请人工确认`
        : `命中区间与更高优先级术语「${by.term.source}→${by.term.target}」重叠，为避免破坏更长 / 更明确的术语，本条不自动处理，请人工确认`,
    })
  }

  const matchesSorted = matches.sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.termId.localeCompare(b.termId))
  const notApplicableSorted = notApplicable.sort((a, b) => a.termId.localeCompare(b.termId))
  return {
    text: seg.text,
    termVersion,
    termIds: active.map((t) => t.id),
    locked: seg.locked,
    matches: [...matchesSorted, ...notApplicableSorted],
  }
}

/** 缓存有效条件：片段文本、锁定态与术语版本都未变 */
export function isScanFresh(
  scan: SegmentScan | undefined,
  seg: SubtitleSegment,
  termVersion: number,
): boolean {
  return (
    !!scan &&
    scan.text === seg.text &&
    scan.locked === seg.locked &&
    scan.termVersion === termVersion
  )
}

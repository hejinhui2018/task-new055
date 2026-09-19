/**
 * 领域模型：字幕事件、字幕片段、冲突、事件日志、版本化术语表。
 *
 * 所有时间均为“逻辑时间”（相对场景开始的毫秒数），由事件/动作携带，
 * 状态层本身从不读取时钟，保证可稳定重放。
 */

/** 机器侧推送的事件类型：新字幕 / 修订 */
export type EventKind = 'create' | 'revision'

/** 机器推送的一条字幕事件 */
export interface SubtitleEvent {
  /** 事件唯一 ID，用于去重（网络重发时 ID 不变） */
  id: string
  /** 字幕序号，时间线按它排序 */
  seq: number
  /** 内容版本号，单调递增 */
  version: number
  kind: EventKind
  text: string
  /** 说话人标识（如主播名）；缺省表示不限制，任何说话人均可命中 */
  speaker?: string
  /** 字幕语言（BCP-47 风格代码，如 zh-CN / en）；缺省视为不限制 */
  lang?: string
  /** 片段在节目时间轴上的开始/结束毫秒；缺省时术语的有效时间不参与判定 */
  startMs?: number
  endMs?: number
}

/** 场景脚本中的一条：在 at 毫秒时投递 event */
export interface ScheduledEvent {
  at: number
  event: SubtitleEvent
}

export type SegmentOrigin = 'machine' | 'manual'

/** 时间线上的一条字幕片段 */
export interface SubtitleSegment {
  seq: number
  text: string
  version: number
  /** 当前内容的来源：机器推送 or 人工修改 */
  origin: SegmentOrigin
  /** 锁定后机器修订不再静默覆盖，转入人工裁决 */
  locked: boolean
  /** 说话人 / 语言 / 时间窗口元数据，随最新一次机器事件更新；用于术语范围判定 */
  speaker?: string
  lang?: string
  startMs?: number
  endMs?: number
  /**
   * 术语应用记录：termId -> 应用时的术语版本。
   * 同一术语在同一版本下的建议不得重复修改字幕（幂等）。
   */
  appliedTerms?: Record<string, number>
}

/** 一条待裁决冲突：锁定片段收到了更新的机器版本 */
export interface Conflict {
  seq: number
  /** 冲突发生瞬间的人工内容快照（用于日志与兜底展示） */
  manualText: string
  manualVersion: number
  incomingText: string
  incomingVersion: number
  receivedAt: number | null
}

/**
 * 版本化术语条目。
 * 每次新建/更新都会分配一个单调递增的版本号：
 * 术语版本变化后，旧建议全部失效并按新版本重新计算；
 * 已按旧版本应用过的片段可再次获得新版本建议。
 */
export interface Term {
  id: string
  /** 原词（被扫描的写法），首尾空白会被裁掉 */
  source: string
  /** 目标写法（接受建议后替换成它） */
  target: string
  /** 适用语言；空数组/缺省表示不限制语言 */
  lang?: string
  /** 生效说话人白名单；空数组/缺省表示不限制说话人 */
  speakers?: string[]
  /** 节目时间轴上的有效区间（毫秒，闭区间边界按重叠判定）；缺省表示全程有效 */
  validFromMs?: number
  validToMs?: number
  /** 同音词表：片段中出现这些写法时只提示“同音歧义”，绝不自动建议 */
  homophones?: string[]
  /** 是否启用；停用后不参与扫描，但术语与版本均保留 */
  enabled: boolean
  /** 术语条目版本号，单调递增 */
  version: number
}

/** 建议分类 */
export type TermMatchKind =
  | 'auto' // 可自动建议：命中原词、在范围内、未被人工锁定、未应用过
  | 'locked-conflict' // 人工锁定片段命中：不能自动改，需人工裁决
  | 'homophone' // 同音歧义：出现同音词，需要人工听音确认，不自动建议
  | 'not-applicable' // 不适用：语言/说话人/有效时间范围不匹配

/**
 * 单条术语对单条片段的扫描结果。
 * “不适用”同样保留理由，便于运营解释“为什么没建议”。
 */
export interface TermMatch {
  key: string // `${seq}::${termId}`
  seq: number
  termId: string
  termVersion: number
  kind: TermMatchKind
  /** 命中词（原词或同音词的实际文本） */
  matchedText: string
  /** 命中位置（相对当前片段文本）；同音/自动类才有，不适用时为 null */
  index: number | null
  /** 建议替换后的文本（仅 auto 类需要预计算，保证接受时与预览一致） */
  replacement: string | null
  /** auto 类实际采纳的原词区间（部分出现可能因重叠被排除） */
  acceptedRanges?: Array<[number, number]>
  /** 人类可读的匹配依据/排除理由 */
  reason: string
}

/** 一条片段的扫描缓存：以片段文本与术语表版本为键，变化即失效 */
export interface SegmentScan {
  text: string
  termVersion: number
  termIds: string[]
  locked: boolean
  matches: TermMatch[]
}

export type LogKind =
  | 'received' // 正常接收新片段
  | 'backfilled' // 晚到片段补回缺口
  | 'duplicate' // 重复事件/重复内容，已忽略
  | 'stale' // 过期或矛盾的版本，已忽略
  | 'revised' // 机器修订已直接应用
  | 'conflict' // 锁定片段收到修订，转入人工裁决
  | 'manual' // 人工修改
  | 'lock' // 锁定 / 解锁
  | 'resolved' // 冲突已裁决
  | 'term' // 术语表维护（新增/更新/停用）
  | 'term-apply' // 接受术语建议（单条/批量）
  | 'term-scan' // 术语扫描结果变化（全量重扫/晚到增量）

/** 新建/更新术语时的提交内容（无 id 表示新建，由状态机分配确定性 id） */
export interface TermDraft {
  id?: string
  source: string
  target: string
  lang?: string
  speakers?: string[]
  /** 毫秒；null/undefined 表示不设置该边界 */
  validFromMs?: number | null
  validToMs?: number | null
  homophones?: string[]
  enabled?: boolean
}

/** 不含撤销/重做栈的纯状态快照（压栈使用，避免栈指数膨胀） */
export type ConsoleSnapshot = Omit<ConsoleState, 'past' | 'future'>

/** 持久化的事实层：在快照基础上再去掉派生扫描缓存（恢复时重建） */
export type PersistedConsole = Omit<ConsoleSnapshot, 'scans'>

export interface LogEntry {
  id: number
  kind: LogKind
  seq: number | null
  /** 逻辑时间；人工操作为 null（界面显示“手动”） */
  at: number | null
  message: string
}

/** 控制台全部状态。纯数据、可深比较，reset 后必须与初始状态完全一致。 */
export interface ConsoleState {
  segments: Record<number, SubtitleSegment>
  /** 已见过的事件 ID 集合，用于事件级去重 */
  seenEventIds: Record<string, true>
  conflicts: Conflict[]
  log: LogEntry[]
  nextLogId: number
  /** 版本化术语表（id -> 术语） */
  terms: Record<string, Term>
  /** 术语版本号：任何术语新增/更新/停用/删除都会整体 +1，使旧建议失效 */
  termVersion: number
  /** 每个片段的扫描缓存（随片段文本/锁定态/术语版本失效重算） */
  scans: Record<number, SegmentScan>
  /** 撤销栈：保存当前状态之前的历史快照（不含栈本身） */
  past: ConsoleSnapshot[]
  /** 重做栈 */
  future: ConsoleSnapshot[]
}

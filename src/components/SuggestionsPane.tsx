import { useMemo, useState } from 'react'
import type { ConsoleAction, SuggestionPatch } from '../consoleReducer'
import type { GlossaryMatch, MatchKind } from '../glossary'
import type { ConsoleState } from '../types'

interface SuggestionsPaneProps {
  matches: GlossaryMatch[]
  state: ConsoleState
  dispatch: (action: ConsoleAction) => void
  canUndo: boolean
  canRedo: boolean
}

const KIND_TITLE: Record<MatchKind, { icon: string; title: string; className: string }> = {
  suggestion: { icon: '✅', title: '可自动建议', className: 'sug--ok' },
  'locked-conflict': { icon: '🔒', title: '人工锁定冲突', className: 'sug--lock' },
  homophone: { icon: '🔊', title: '同音歧义', className: 'sug--amb' },
  'not-applicable': { icon: '➖', title: '不适用片段', className: 'sug--na' },
}

function toPatch(m: GlossaryMatch): SuggestionPatch {
  return {
    id: m.id,
    seq: m.seq,
    termId: m.termId,
    termVersion: m.termVersion,
    source: m.source,
    target: m.target,
    start: m.start,
    end: m.end,
  }
}

/** 高亮片段文本中被命中的区间 */
function HighlightedText({ text, start, end }: { text: string; start: number; end: number }) {
  if (start < 0) return <p className="sug-text">{text}</p>
  return (
    <p className="sug-text">
      {text.slice(0, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </p>
  )
}

/** 版本化术语校对建议：先看影响面再决定接受，绝不直接批量替换。 */
export function SuggestionsPane({ matches, state, dispatch, canUndo, canRedo }: SuggestionsPaneProps) {
  const [showNa, setShowNa] = useState(false)

  const groups = useMemo(() => {
    const g: Record<MatchKind, GlossaryMatch[]> = {
      suggestion: [],
      'locked-conflict': [],
      homophone: [],
      'not-applicable': [],
    }
    for (const m of matches) g[m.kind].push(m)
    return g
  }, [matches])

  const suggestions = groups.suggestion
  const acceptAll = () => {
    if (suggestions.length === 0) return
    dispatch({ type: 'apply-suggestions', patches: suggestions.map(toPatch) })
  }

  return (
    <section className="pane suggestions-pane" aria-label="术语校对建议">
      <h2>
        <span aria-hidden="true">🔍</span> 术语校对建议
        <span className="pane-history">
          <button type="button" onClick={() => dispatch({ type: 'undo-glossary' })} disabled={!canUndo}>
            ↩ 撤销应用
          </button>
          <button type="button" onClick={() => dispatch({ type: 'redo-glossary' })} disabled={!canRedo}>
            ↪ 重做
          </button>
        </span>
      </h2>

      <div className="sug-summary" role="status">
        <span className="chip chip--ok">可建议 {suggestions.length}</span>
        <span className="chip chip--locked">锁定冲突 {groups['locked-conflict'].length}</span>
        <span className="chip chip--warn">同音歧义 {groups.homophone.length}</span>
        <span className="chip">不适用 {groups['not-applicable'].length}</span>
        <button
          type="button"
          className="btn-primary sug-batch"
          onClick={acceptAll}
          disabled={suggestions.length === 0}
          title="把当前全部可自动建议的替换一次性应用；可整批撤销"
        >
          ✔ 批量接受全部建议（{suggestions.length}）
        </button>
      </div>

      {matches.length === 0 && (
        <p className="muted">暂无扫描结果。收到字幕后系统会按术语表逐条扫描，并解释每条匹配依据。</p>
      )}

      {(['suggestion', 'locked-conflict', 'homophone'] as MatchKind[]).map((kind) =>
        groups[kind].length === 0 ? null : (
          <div key={kind} className={`sug-group ${KIND_TITLE[kind].className}`}>
            <h3>
              {KIND_TITLE[kind].icon} {KIND_TITLE[kind].title}（{groups[kind].length}）
            </h3>
            <ul>
              {groups[kind].map((m) => {
                const seg = state.segments[m.seq]
                return (
                  <li key={m.id} className="sug-card">
                    <div className="sug-card-head">
                      <span className="seq">#{m.seq}</span>
                      <span className="chip">
                        {m.source} → {m.target}
                      </span>
                      <span className="chip">术语 v{m.termVersion}</span>
                      {seg?.locked && <span className="chip chip--locked">🔒 片段已锁定</span>}
                    </div>
                    {seg && <HighlightedText text={seg.text} start={m.start} end={m.end} />}
                    <p className="sug-reason">{m.reason}</p>
                    <div className="sug-actions">
                      {m.kind === 'suggestion' && (
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => dispatch({ type: 'apply-suggestions', patches: [toPatch(m)] })}
                        >
                          ✔ 接受这条
                        </button>
                      )}
                      {m.kind === 'locked-conflict' && (
                        <button
                          type="button"
                          onClick={() => dispatch({ type: 'toggle-lock', seq: m.seq })}
                          title="解锁后重新扫描，该命中会变为可接受建议"
                        >
                          🔓 解锁 #{m.seq} 后重扫
                        </button>
                      )}
                      {m.kind === 'homophone' && <span className="muted">请人工确认写法，系统不自动替换</span>}
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        ),
      )}

      {groups['not-applicable'].length > 0 && (
        <div className="sug-group sug--na">
          <button type="button" className="na-toggle" onClick={() => setShowNa((v) => !v)} aria-expanded={showNa}>
            {KIND_TITLE['not-applicable'].icon} 不适用片段（{groups['not-applicable'].length}）
            <span aria-hidden="true">{showNa ? '▲ 收起' : '▼ 展开'}</span>
          </button>
          {showNa && (
            <ul>
              {groups['not-applicable'].map((m) => (
                <li key={m.id} className="sug-card sug-card--na">
                  <div className="sug-card-head">
                    <span className="seq">#{m.seq}</span>
                    <span className="chip">
                      {m.source} → {m.target}
                    </span>
                    <span className="chip">术语 v{m.termVersion}</span>
                  </div>
                  <p className="sug-reason">{m.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

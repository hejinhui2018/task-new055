import type { ConsoleAction } from '../consoleReducer'
import type { ConsoleState, TermMatch } from '../types'
import { allAutoKeys, canRedo, canUndo, termById } from '../selectors'

interface TermSuggestionsPaneProps {
  state: ConsoleState
  dispatch: (action: ConsoleAction) => void
}

const SECTION_META: Array<{
  kind: TermMatch['kind']
  icon: string
  title: string
  desc: string
  listClass: string
}> = [
  {
    kind: 'auto',
    icon: '🟢',
    title: '可自动建议',
    desc: '边界完整、范围匹配、片段未锁定：可单条或批量接受',
    listClass: 'match-list--auto',
  },
  {
    kind: 'locked-conflict',
    icon: '🔒',
    title: '人工锁定冲突',
    desc: '片段已锁定，术语不能自动改写：请先解锁或在时间线人工处理',
    listClass: 'match-list--locked',
  },
  {
    kind: 'homophone',
    icon: '🔊',
    title: '同音歧义',
    desc: '出现同音写法，可能不是该术语：需人工听音确认，绝不自动替换',
    listClass: 'match-list--homo',
  },
  {
    kind: 'not-applicable',
    icon: '🚫',
    title: '不适用片段',
    desc: '语言 / 说话人 / 有效时间不符、被更长术语遮蔽或已应用：仅解释原因',
    listClass: 'match-list--na',
  },
]

function highlight(text: string, matchedText: string, index: number | null) {
  if (index === null || index < 0) return text
  const end = index + matchedText.length
  return (
    <>
      {text.slice(0, index)}
      <mark className="match-hit">{text.slice(index, end)}</mark>
      {text.slice(end)}
    </>
  )
}

/** 版本化术语建议：先看影响范围与匹配依据，再决定单条/批量接受；支持撤销重做。 */
export function TermSuggestionsPane({ state, dispatch }: TermSuggestionsPaneProps) {
  const autoKeys = allAutoKeys(state)

  return (
    <section className="pane suggestions-pane" aria-label="术语校对建议">
      <h2>
        <span aria-hidden="true">🧪</span> 术语校对建议
        <span className="suggestions-toolbar">
          <button
            type="button"
            onClick={() => dispatch({ type: 'undo' })}
            disabled={!canUndo(state)}
            title="撤销上一步人工操作（接受建议 / 编辑 / 锁定 / 术语维护）"
          >
            ↶ 撤销
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'redo' })}
            disabled={!canRedo(state)}
            title="重做"
          >
            ↷ 重做
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => dispatch({ type: 'terms-apply', keys: autoKeys })}
            disabled={autoKeys.length === 0}
            title="把当前全部可自动建议写入字幕（可撤销）"
          >
            ✅ 批量接受全部（{autoKeys.length}）
          </button>
        </span>
      </h2>

      {SECTION_META.map((section) => {
        const matches: TermMatch[] = []
        for (const scan of Object.values(state.scans)) {
          matches.push(...scan.matches.filter((m) => m.kind === section.kind))
        }
        matches.sort((a, b) => a.seq - b.seq || (a.index ?? 1e9) - (b.index ?? 1e9))
        return (
          <div className={`match-section ${section.listClass}`} key={section.kind}>
            <h3>
              <span aria-hidden="true">{section.icon}</span> {section.title}
              <span className="match-count">{matches.length}</span>
              <span className="muted" style={{ fontWeight: 400 }}>
                {section.desc}
              </span>
            </h3>
            {matches.length === 0 ? (
              <p className="muted match-empty">无</p>
            ) : (
              <ul className="match-list">
                {matches.map((m) => (
                  <MatchRow key={m.key} state={state} match={m} dispatch={dispatch} />
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </section>
  )
}

function MatchRow({
  state,
  match,
  dispatch,
}: {
  state: ConsoleState
  match: TermMatch
  dispatch: (action: ConsoleAction) => void
}) {
  const seg = state.segments[match.seq]
  const term = termById(state, match.termId)
  return (
    <li className={`match-row match-row--${match.kind}`}>
      <div className="match-head">
        <span className="seq">#{match.seq}</span>
        {term && (
          <span className="term-pair">
            {term.source} <span aria-hidden="true">→</span> {term.target}
          </span>
        )}
        <span className="chip">术语 v{match.termVersion}</span>
        {seg?.locked && <span className="chip chip--locked">🔒 片段已锁定</span>}
        {match.kind === 'auto' && (
          <span className="row-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={() => dispatch({ type: 'terms-apply', keys: [match.key] })}
            >
              ✅ 接受这条
            </button>
            <button
              type="button"
              title="接受本片段内全部可自动建议"
              onClick={() =>
                dispatch({
                  type: 'terms-apply',
                  keys: (state.scans[match.seq]?.matches ?? [])
                    .filter((m) => m.kind === 'auto')
                    .map((m) => m.key),
                })
              }
            >
              接受本片段全部
            </button>
          </span>
        )}
      </div>
      <p className="match-text">原文：{highlight(seg?.text ?? '', match.matchedText, match.index)}</p>
      {match.kind === 'auto' && match.replacement !== null && (
        <p className="match-preview">替换后：{match.replacement}</p>
      )}
      <p className="match-reason">依据：{match.reason}</p>
    </li>
  )
}

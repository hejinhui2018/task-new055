import { useState } from 'react'
import type { TermDraft } from '../glossaryReducer'
import type { GlossaryState } from '../glossaryReducer'
import type { GlossaryAction } from '../glossaryReducer'

interface GlossaryPaneProps {
  glossary: GlossaryState
  dispatch: (action: GlossaryAction) => void
  canUndo: boolean
  canRedo: boolean
}

const EMPTY_DRAFT: TermDraft = {
  source: '',
  target: '',
  language: 'zh',
  enabled: true,
  seqStart: null,
  seqEnd: null,
  speakers: [],
  homophones: [],
}

/** 逗号/顿号/空白分隔的列表输入解析 */
function parseList(raw: string): string[] {
  return raw
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function scopeLabel(draft: TermDraft): string {
  const seq =
    draft.seqStart === null && draft.seqEnd === null
      ? '全部序号'
      : `序号 ${draft.seqStart ?? '−∞'}–${draft.seqEnd ?? '+∞'}`
  const speakers = draft.speakers.length > 0 ? ` · 说话人 ${draft.speakers.join('/')}` : ''
  return `${seq}${speakers}`
}

/** 版本化术语表：运营维护品牌名/人名/型号，每次修改抬升版本号并使旧建议失效。 */
export function GlossaryPane({ glossary, dispatch, canUndo, canRedo }: GlossaryPaneProps) {
  const [draft, setDraft] = useState<TermDraft>(EMPTY_DRAFT)
  const [seqRaw, setSeqRaw] = useState('')
  const [speakersRaw, setSpeakersRaw] = useState('')
  const [homophonesRaw, setHomophonesRaw] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)

  const composeDraft = (): TermDraft => ({
    ...draft,
    seqStart: parseRange(seqRaw)[0],
    seqEnd: parseRange(seqRaw)[1],
    speakers: parseList(speakersRaw),
    homophones: parseList(homophonesRaw),
  })

  const resetForm = () => {
    setDraft(EMPTY_DRAFT)
    setSeqRaw('')
    setSpeakersRaw('')
    setHomophonesRaw('')
    setEditingId(null)
  }

  const submit = () => {
    const finalDraft = composeDraft()
    if (!finalDraft.source.trim() || !finalDraft.target.trim()) return
    if (editingId) dispatch({ type: 'update-term', id: editingId, draft: finalDraft })
    else dispatch({ type: 'add-term', draft: finalDraft })
    resetForm()
  }

  const startEdit = (id: string) => {
    const entry = glossary.terms[id]
    if (!entry) return
    setEditingId(id)
    setDraft({
      source: entry.term.source,
      target: entry.term.target,
      language: entry.term.language,
      enabled: entry.term.enabled,
      seqStart: entry.term.seqStart,
      seqEnd: entry.term.seqEnd,
      speakers: entry.term.speakers,
      homophones: entry.term.homophones,
    })
    setSeqRaw(
      entry.term.seqStart === null && entry.term.seqEnd === null
        ? ''
        : `${entry.term.seqStart ?? ''}-${entry.term.seqEnd ?? ''}`,
    )
    setSpeakersRaw(entry.term.speakers.join('、'))
    setHomophonesRaw(entry.term.homophones.join('、'))
  }

  return (
    <section className="pane glossary-pane" aria-label="节目术语表">
      <h2>
        <span aria-hidden="true">📖</span> 节目术语表
        <span className="pane-history">
          <button type="button" onClick={() => dispatch({ type: 'undo-glossary' })} disabled={!canUndo}>
            ↩ 撤销
          </button>
          <button type="button" onClick={() => dispatch({ type: 'redo-glossary' })} disabled={!canRedo}>
            ↪ 重做
          </button>
        </span>
      </h2>
      <p className="muted hint-small">
        术语修改会立即抬升版本号，右侧旧建议自动失效并重新扫描；系统只给建议，不会直接批量替换字幕。
      </p>

      <ul className="term-list">
        {glossary.order.map((id) => {
          const entry = glossary.terms[id]
          if (!entry) return null
          const t = entry.term
          return (
            <li key={id} className={`term-card${t.enabled ? '' : ' term-card--off'}`}>
              <div className="term-card-head">
                <span className="term-pair">
                  <code>{t.source}</code>
                  <span aria-hidden="true">→</span>
                  <strong>{t.target}</strong>
                </span>
                <span className="chip">v{entry.version}</span>
                <span className="chip">{t.language === 'zh' ? '中文' : 'EN'}</span>
                {!t.enabled && <span className="chip chip--warn">已停用</span>}
              </div>
              <div className="term-meta">
                <span className="muted">{scopeLabel(t)}</span>
                {t.homophones.length > 0 && (
                  <span className="chip chip--warn">同音词：{t.homophones.join('、')}</span>
                )}
              </div>
              <div className="term-actions">
                <button type="button" onClick={() => startEdit(id)}>
                  ✏️ 编辑
                </button>
                <button type="button" onClick={() => dispatch({ type: 'toggle-enabled', id })}>
                  {t.enabled ? '⏸ 停用' : '▶ 启用'}
                </button>
                <button type="button" className="btn-danger" onClick={() => dispatch({ type: 'delete-term', id })}>
                  🗑 删除
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <form
        className="term-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h3>{editingId ? `编辑术语（保存后版本 +1）` : '新增术语'}</h3>
        <div className="term-form-grid">
          <label>
            原词
            <input
              value={draft.source}
              placeholder="如：晚间新闻 / GPU"
              onChange={(e) => setDraft({ ...draft, source: e.target.value })}
            />
          </label>
          <label>
            目标写法
            <input
              value={draft.target}
              placeholder="如：《晚间新闻》"
              onChange={(e) => setDraft({ ...draft, target: e.target.value })}
            />
          </label>
          <label>
            语言
            <select
              value={draft.language}
              onChange={(e) => setDraft({ ...draft, language: e.target.value as TermDraft['language'] })}
            >
              <option value="zh">中文（字面匹配）</option>
              <option value="en">英文（词边界匹配）</option>
            </select>
          </label>
          <label>
            有效序号区间
            <input
              value={seqRaw}
              placeholder="如 101-103；留空=全部"
              onChange={(e) => setSeqRaw(e.target.value)}
            />
          </label>
          <label>
            说话人范围
            <input
              value={speakersRaw}
              placeholder="如 主播B；留空=不限"
              onChange={(e) => setSpeakersRaw(e.target.value)}
            />
          </label>
          <label>
            同音词（可选）
            <input
              value={homophonesRaw}
              placeholder="逗号分隔，出现即标歧义"
              onChange={(e) => setHomophonesRaw(e.target.value)}
            />
          </label>
        </div>
        <div className="term-form-actions">
          <button type="submit" className="btn-primary" disabled={!draft.source.trim() || !draft.target.trim()}>
            {editingId ? '保存修改（版本 +1）' : '＋ 新增术语'}
          </button>
          {editingId && (
            <button type="button" onClick={resetForm}>
              取消
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

/** 解析 "101-103" / "101-" / "-103" 形式的序号区间 */
function parseRange(raw: string): [number | null, number | null] {
  const trimmed = raw.trim()
  if (!trimmed) return [null, null]
  if (!trimmed.includes('-')) {
    const n = Number(trimmed)
    return Number.isFinite(n) ? [n, n] : [null, null]
  }
  const [l, r] = trimmed.split('-', 2)
  const start = l.trim() === '' ? null : Number(l)
  const end = r.trim() === '' ? null : Number(r)
  return [
    start !== null && Number.isFinite(start) ? start : null,
    end !== null && Number.isFinite(end) ? end : null,
  ]
}

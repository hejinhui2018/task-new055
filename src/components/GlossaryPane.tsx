import { useState } from 'react'
import type { ConsoleAction } from '../consoleReducer'
import type { ConsoleState, Term, TermDraft } from '../types'
import { sortedTerms } from '../selectors'

interface GlossaryPaneProps {
  state: ConsoleState
  dispatch: (action: ConsoleAction) => void
}

interface FormState {
  id?: string
  source: string
  target: string
  lang: string
  speakers: string
  validFromMs: string
  validToMs: string
  homophones: string
  enabled: boolean
}

const EMPTY_FORM: FormState = {
  source: '',
  target: '',
  lang: '',
  speakers: '',
  validFromMs: '',
  validToMs: '',
  homophones: '',
  enabled: true,
}

function splitList(value: string): string[] {
  return value
    .split(/[,，、\s]+/)
    .map((v) => v.trim())
    .filter(Boolean)
}

function termToForm(term: Term): FormState {
  return {
    id: term.id,
    source: term.source,
    target: term.target,
    lang: term.lang ?? '',
    speakers: (term.speakers ?? []).join('、'),
    validFromMs: term.validFromMs !== undefined ? String(term.validFromMs / 1000) : '',
    validToMs: term.validToMs !== undefined ? String(term.validToMs / 1000) : '',
    homophones: (term.homophones ?? []).join('、'),
    enabled: term.enabled,
  }
}

function fmtMs(ms: number | undefined): string {
  return ms === undefined ? '∞' : `+${(ms / 1000).toFixed(1)}s`
}

/** 版本化节目术语表维护：新建 / 更新（版本 +1）/ 停用 / 删除。只维护，从不直接批量替换字幕。 */
export function GlossaryPane({ state, dispatch }: GlossaryPaneProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const editing = form.id !== undefined

  const submit = () => {
    const draft: TermDraft = {
      id: form.id,
      source: form.source,
      target: form.target,
      lang: form.lang.trim() || undefined,
      speakers: splitList(form.speakers),
      validFromMs: form.validFromMs.trim() === '' ? null : Number(form.validFromMs) * 1000,
      validToMs: form.validToMs.trim() === '' ? null : Number(form.validToMs) * 1000,
      homophones: splitList(form.homophones),
      enabled: form.enabled,
    }
    if (!draft.source.trim() || !draft.target.trim()) return
    dispatch({ type: 'term-upsert', draft })
    setForm(EMPTY_FORM)
  }

  const field = (key: keyof FormState, value: string | boolean) =>
    setForm((f) => ({ ...f, [key]: value }))

  return (
    <section className="pane glossary-pane" aria-label="节目术语表">
      <h2>
        <span aria-hidden="true">📖</span> 节目术语表
        <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
          术语版本 v{state.termVersion} · {sortedTerms(state).length} 条
        </span>
      </h2>

      <div className="term-form">
        <div className="term-form-row">
          <label>
            原词
            <input
              value={form.source}
              placeholder="如 晚间新闻 / iPhone15"
              onChange={(e) => field('source', e.target.value)}
            />
          </label>
          <label>
            目标写法
            <input
              value={form.target}
              placeholder="如 《晚间新闻》 / iPhone 15 Pro"
              onChange={(e) => field('target', e.target.value)}
            />
          </label>
        </div>
        <div className="term-form-row">
          <label>
            语言
            <input
              value={form.lang}
              placeholder="如 zh-CN（留空=不限）"
              onChange={(e) => field('lang', e.target.value)}
            />
          </label>
          <label className="term-form-grow">
            说话人范围
            <input
              value={form.speakers}
              placeholder="如 林晚、陈默（留空=不限，顿号/逗号分隔）"
              onChange={(e) => field('speakers', e.target.value)}
            />
          </label>
        </div>
        <div className="term-form-row">
          <label>
            有效起（秒）
            <input
              type="number"
              step="0.1"
              value={form.validFromMs}
              placeholder="节目开始"
              onChange={(e) => field('validFromMs', e.target.value)}
            />
          </label>
          <label>
            有效止（秒）
            <input
              type="number"
              step="0.1"
              value={form.validToMs}
              placeholder="节目结束"
              onChange={(e) => field('validToMs', e.target.value)}
            />
          </label>
          <label className="term-form-grow">
            同音词（歧义只提示）
            <input
              value={form.homophones}
              placeholder="如 欣闻（顿号/逗号分隔）"
              onChange={(e) => field('homophones', e.target.value)}
            />
          </label>
          <label className="term-form-check">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => field('enabled', e.target.checked)}
            />
            启用
          </label>
        </div>
        <div className="term-form-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={submit}
            disabled={!form.source.trim() || !form.target.trim()}
          >
            {editing ? `💾 保存更新（生成 v${state.termVersion + 1}）` : '➕ 新增术语'}
          </button>
          {editing && (
            <button type="button" onClick={() => setForm(EMPTY_FORM)}>
              取消编辑
            </button>
          )}
          <span className="muted">更新后旧建议立即失效，按新版本重新扫描，不会直接替换字幕</span>
        </div>
      </div>

      <ul className="term-list">
        {sortedTerms(state).map((term) => (
          <li
            key={term.id}
            className={`term-card${term.enabled ? '' : ' term-card--off'}${form.id === term.id ? ' term-card--editing' : ''}`}
          >
            <div className="term-card-main">
              <span className="term-pair">
                <del className={term.enabled ? '' : 'term-off-text'}>{term.source}</del>
                <span aria-hidden="true">→</span>
                <strong>{term.target}</strong>
              </span>
              <span className="chip">v{term.version}</span>
              {term.lang && <span className="chip">🌐 {term.lang}</span>}
              {term.speakers && term.speakers.length > 0 && (
                <span className="chip">🎤 {term.speakers.join('、')}</span>
              )}
              {(term.validFromMs !== undefined || term.validToMs !== undefined) && (
                <span className="chip">
                  ⏱ {fmtMs(term.validFromMs)}~{fmtMs(term.validToMs)}
                </span>
              )}
              {term.homophones && term.homophones.length > 0 && (
                <span className="chip chip--warn">🔊 同音：{term.homophones.join('、')}</span>
              )}
              {!term.enabled && <span className="chip">已停用</span>}
            </div>
            <div className="term-card-actions">
              <button type="button" onClick={() => setForm(termToForm(term))}>
                ✏️ 更新
              </button>
              <button type="button" onClick={() => dispatch({ type: 'term-toggle', id: term.id })}>
                {term.enabled ? '⏸ 停用' : '▶ 启用'}
              </button>
              <button type="button" onClick={() => dispatch({ type: 'term-delete', id: term.id })}>
                🗑 删除
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

import { useEffect, useMemo, useReducer, useRef } from 'react'
import { consoleReducer, createInitialState } from './consoleReducer'
import {
  createInitialGlossaryState,
  glossaryReducer,
  termEntries,
  type GlossaryAction,
} from './glossaryReducer'
import {
  glossarySignature,
  scanOneSegment,
  segmentSignature,
  type GlossaryMatch,
  type TermEntry,
} from './glossary'
import { Player } from './player'
import { SCENARIO } from './scenario'
import { storage } from './storage'
import { sortedSegments } from './selectors'
import type { ConsoleState } from './types'

interface ScanCacheEntry {
  gsig: string
  ssig: string
  matches: GlossaryMatch[]
}

/**
 * 把控制台 reducer、术语表 reducer、播放器与增量扫描装配成 React 可用的整体。
 *
 * 扫描在渲染期同步完成（useMemo）：术语表版本变化时，旧建议在同一轮渲染中失效，
 * 界面不可能拿到上一版术语算出的建议；片段未变化时只复用缓存，
 * 晚到片段到达仅扫描该片段相关的术语。
 */
export function useSubtitleConsole() {
  const [state, dispatch] = useReducer(consoleReducer, undefined, (): ConsoleState => {
    return storage.loadConsole() ?? createInitialState()
  })
  const [glossary, glossaryDispatch] = useReducer(
    glossaryReducer,
    undefined,
    () => storage.loadGlossary() ?? createInitialGlossaryState(),
  )

  const playerRef = useRef<Player | null>(null)
  if (playerRef.current === null) {
    playerRef.current = new Player(SCENARIO, dispatch)
  }
  const [, bump] = useReducer((x: number) => x + 1, 0)

  useEffect(() => {
    const player = playerRef.current!
    const unsubscribe = player.subscribe(bump)
    return () => {
      unsubscribe()
      player.dispose()
    }
  }, [])

  // 刷新恢复：状态变化即落盘
  useEffect(() => {
    storage.saveConsole(state)
  }, [state])
  useEffect(() => {
    storage.saveGlossary(glossary)
  }, [glossary])

  const entries: TermEntry[] = useMemo(() => termEntries(glossary), [glossary])
  const gsig = useMemo(() => glossarySignature(entries), [entries])

  // 增量扫描缓存：seq -> { 术语表签名, 片段签名, 扫描结果 }
  const scanCache = useRef<Map<number, ScanCacheEntry>>(new Map())
  const matchesBySeq = useMemo(() => {
    const result = new Map<number, GlossaryMatch[]>()
    const liveSeqs = new Set<number>()
    for (const seg of sortedSegments(state)) {
      liveSeqs.add(seg.seq)
      const ssig = segmentSignature(seg)
      const cached = scanCache.current.get(seg.seq)
      if (cached && cached.gsig === gsig && cached.ssig === ssig) {
        result.set(seg.seq, cached.matches)
        continue
      }
      // 晚到/变化片段：只对当前生效的术语扫描这一个片段
      const matches = scanOneSegment(seg, entries)
      scanCache.current.set(seg.seq, { gsig, ssig, matches })
      result.set(seg.seq, matches)
    }
    // 清理已不存在的片段缓存（reset/重放后）
    for (const seq of scanCache.current.keys()) {
      if (!liveSeqs.has(seq)) scanCache.current.delete(seq)
    }
    return result
  }, [state, gsig, entries])

  const allMatches = useMemo(
    () =>
      [...matchesBySeq.values()]
        .flat()
        .sort((a, b) =>
          a.seq !== b.seq ? a.seq - b.seq : a.start !== b.start ? a.start - b.start : a.id.localeCompare(b.id),
        ),
    [matchesBySeq],
  )

  return {
    state,
    dispatch,
    player: playerRef.current,
    glossary,
    glossaryDispatch: glossaryDispatch as (action: GlossaryAction) => void,
    entries,
    matches: allMatches,
    matchesBySeq,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    canUndoGlossary: glossary.past.length > 0,
    canRedoGlossary: glossary.future.length > 0,
  }
}

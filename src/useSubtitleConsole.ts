import { useEffect, useReducer, useRef } from 'react'
import { consoleReducer, createInitialState } from './consoleReducer'
import { DEFAULT_TERMS, DEFAULT_TERM_VERSION } from './defaultTerms'
import { Player } from './player'
import { SCENARIO } from './scenario'
import { loadSnapshot, persistState, STORAGE_KEY } from './storage'

/** 初始状态：优先恢复刷新前的快照；否则载入节目预置术语表 */
function init(): ReturnType<typeof createInitialState> {
  if (typeof window !== 'undefined') {
    const snapshot = loadSnapshot(window.localStorage, STORAGE_KEY)
    if (snapshot) {
      // hydrate 会重建全部扫描缓存，恢复后的建议与刷新前完全一致
      return consoleReducer(createInitialState(), { type: 'hydrate', snapshot })
    }
  }
  return createInitialState({ terms: DEFAULT_TERMS, termVersion: DEFAULT_TERM_VERSION })
}

/** 把纯函数 reducer 与播放器装配成 React 可用的整体。 */
export function useSubtitleConsole() {
  const [state, dispatch] = useReducer(consoleReducer, undefined, init)
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

  // 刷新恢复：事实层（字幕、冲突、日志、术语表、术语版本）每次变化都落盘；
  // 扫描缓存与撤销/重做栈不持久化，恢复时重建/清空。
  useEffect(() => {
    persistState(state)
  }, [state])

  return { state, dispatch, player: playerRef.current }
}

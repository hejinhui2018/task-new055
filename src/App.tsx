import { useSubtitleConsole } from './useSubtitleConsole'
import {
  duplicateCount,
  firstBlockingGap,
  gaps,
  lockedCount,
  onAirSegment,
  onAirSeq,
  sortedSegments,
  upcomingSegments,
} from './selectors'
import { Header } from './components/Header'
import { PreviewPane } from './components/PreviewPane'
import { TimelinePane } from './components/TimelinePane'
import { EventLogPane } from './components/EventLogPane'
import { ConflictPanel } from './components/ConflictPanel'
import { PlaybackControls } from './components/PlaybackControls'
import { GlossaryPane } from './components/GlossaryPane'
import { SuggestionsPane } from './components/SuggestionsPane'

export default function App() {
  const {
    state,
    dispatch,
    player,
    glossary,
    glossaryDispatch,
    matches,
    canUndo,
    canRedo,
    canUndoGlossary,
    canRedoGlossary,
  } = useSubtitleConsole()

  return (
    <div className="console">
      <Header
        segmentCount={sortedSegments(state).length}
        gapCount={gaps(state).length}
        duplicateCount={duplicateCount(state)}
        conflictCount={state.conflicts.length}
        lockedCount={lockedCount(state)}
      />
      <ConflictPanel state={state} dispatch={dispatch} />
      <section className="grid grid--glossary" aria-label="版本化术语校对">
        <GlossaryPane
          glossary={glossary}
          dispatch={glossaryDispatch}
          canUndo={canUndoGlossary}
          canRedo={canRedoGlossary}
        />
        <SuggestionsPane
          matches={matches}
          state={state}
          dispatch={dispatch}
          canUndo={canUndo}
          canRedo={canRedo}
        />
      </section>
      <main className="grid">
        <PreviewPane
          onAir={onAirSegment(state)}
          blockingGap={firstBlockingGap(state)}
          upcoming={upcomingSegments(state)}
        />
        <TimelinePane state={state} onAirSeq={onAirSeq(state)} dispatch={dispatch} />
        <EventLogPane log={state.log} />
      </main>
      <PlaybackControls player={player} />
    </div>
  )
}

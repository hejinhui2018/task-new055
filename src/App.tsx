import { useSubtitleConsole } from './useSubtitleConsole'
import {
  allAutoKeys,
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
import { TermSuggestionsPane } from './components/TermSuggestionsPane'

export default function App() {
  const { state, dispatch, player } = useSubtitleConsole()

  return (
    <div className="console">
      <Header
        segmentCount={sortedSegments(state).length}
        gapCount={gaps(state).length}
        duplicateCount={duplicateCount(state)}
        conflictCount={state.conflicts.length}
        lockedCount={lockedCount(state)}
        suggestionCount={allAutoKeys(state).length}
      />
      <ConflictPanel state={state} dispatch={dispatch} />
      <main className="grid">
        <PreviewPane
          onAir={onAirSegment(state)}
          blockingGap={firstBlockingGap(state)}
          upcoming={upcomingSegments(state)}
        />
        <TimelinePane state={state} onAirSeq={onAirSeq(state)} dispatch={dispatch} />
        <EventLogPane log={state.log} />
        <GlossaryPane state={state} dispatch={dispatch} />
        <TermSuggestionsPane state={state} dispatch={dispatch} />
      </main>
      <PlaybackControls player={player} />
    </div>
  )
}

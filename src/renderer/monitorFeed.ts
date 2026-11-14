import type { MonitorSample } from '@shared/types'
import { MONITOR_WINDOW, appendSample } from './monitorFormat'

// One subscription to the main process's monitor feed per window, shared by
// everything that wants samples (the status-bar pill and the Monitoring view).
// The main process keys its subscribers by window, so a second direct
// subscription from the same window would replace the first. Late listeners get
// the samples already received replayed first, so the Monitoring view opens with
// its charts filled in.

type Listener = (sample: MonitorSample) => void

const listeners = new Set<Listener>()
let recent: MonitorSample[] = []
let stopFeed: (() => void) | null = null

/** Receive every monitor sample (recent ones first). Returns the unsubscribe. */
export function subscribeMonitor(listener: Listener): () => void {
  for (const sample of recent) listener(sample)
  listeners.add(listener)
  if (!stopFeed) {
    stopFeed = window.api.onMonitorSample((sample) => {
      recent = appendSample(recent, sample, MONITOR_WINDOW)
      for (const l of listeners) l(sample)
    })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopFeed?.()
      stopFeed = null
      recent = []
    }
  }
}

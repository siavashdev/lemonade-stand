import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { MonitorSample } from '@shared/types'
import { subscribeMonitor } from './monitorFeed'
import { chartPaths, formatRate, niceMax } from './monitorFormat'

const SPARK_POINTS = 30
const SPARK_W = 34
const SPARK_H = 13

interface Pill {
  online: boolean
  active: number
  tokensPerSecond: number
  cpuPercent: number | null
  /** Recent live generation speeds, for the sparkline. */
  recent: number[]
}

const EMPTY: Pill = { online: false, active: 0, tokensPerSecond: 0, cpuPercent: null, recent: [] }

/**
 * The always-visible Monitoring indicator in the status bar: whether the model is
 * working, its live speed with a sparkline, and CPU. Click for the full view. It
 * keeps its own state so the once-a-second updates re-render only this pill, not
 * the whole app, and it stops listening while the window is hidden.
 */
export function MonitorPill({ onOpen }: { onOpen: () => void }): JSX.Element {
  const [pill, setPill] = useState<Pill>(EMPTY)
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    let stop: (() => void) | null = null
    const onSample = (s: MonitorSample): void => {
      setSeen(true)
      setPill((prev) => ({
        online: s.online,
        active: s.inference?.activeRequests ?? 0,
        tokensPerSecond: s.inference?.liveTokensPerSecond ?? 0,
        cpuPercent: s.system?.cpuPercent ?? null,
        recent: [...prev.recent, s.inference?.liveTokensPerSecond ?? 0].slice(-SPARK_POINTS)
      }))
    }
    const sync = (): void => {
      if (document.hidden) {
        stop?.()
        stop = null
      } else if (!stop) {
        stop = subscribeMonitor(onSample)
      }
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      stop?.()
    }
  }, [])

  const working = pill.active > 0
  const state = !seen ? 'connecting' : !pill.online ? 'offline' : working ? 'working' : 'idle'
  const label =
    state === 'offline'
      ? 'Offline'
      : state === 'working'
        ? pill.tokensPerSecond > 0
          ? `${formatRate(pill.tokensPerSecond)} tok/s`
          : 'Working…'
        : state === 'idle'
          ? 'Idle'
          : 'Monitoring'
  const max = niceMax(Math.max(10, ...pill.recent), 10)
  const { line } = chartPaths(pill.recent, SPARK_POINTS, SPARK_W, SPARK_H, max)

  return (
    <button
      className={`statusbar-btn monitor-pill ${state}`}
      onClick={onOpen}
      title="Monitoring: live resource usage and inference speed"
      aria-label={`Monitoring: ${label}`}
    >
      <span className="monitor-dot" aria-hidden="true" />
      <span className="monitor-pill-text">{label}</span>
      <svg
        className="monitor-spark"
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        width={SPARK_W}
        height={SPARK_H}
        aria-hidden="true"
      >
        {line ? <path d={line} /> : <path d={`M0 ${SPARK_H - 1} H${SPARK_W}`} />}
      </svg>
      {pill.cpuPercent !== null && (
        <span className="monitor-pill-cpu">CPU {Math.round(pill.cpuPercent)}%</span>
      )}
    </button>
  )
}

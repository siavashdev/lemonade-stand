import { useEffect, useRef, useState } from 'react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import type { MonitorSample } from '@shared/types'
import { ChartBarIcon, PopOutIcon } from './icons'
import { subscribeMonitor } from './monitorFeed'
import {
  MAX_REQUEST_ROWS,
  MONITOR_WINDOW,
  appendSample,
  chartBands,
  chartPaths,
  detectRequest,
  formatCount,
  formatGb,
  formatPercent,
  formatRate,
  formatSeconds,
  niceMax,
  type RequestRecord
} from './monitorFormat'

const CHART_W = 300
const CHART_H = 70

/** A small filled line chart of the recent samples, newest at the right. Spans
 * in `busy` are shaded, so work in progress shows even while the line is at zero. */
function Chart({
  values,
  max,
  label,
  busy
}: {
  values: (number | null)[]
  max: number
  label: string
  busy?: boolean[]
}): JSX.Element {
  const { line, area } = chartPaths(values, MONITOR_WINDOW, CHART_W, CHART_H, max)
  return (
    <svg
      className="mon-chart"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {busy &&
        chartBands(busy, MONITOR_WINDOW, CHART_W).map((b) => (
          <rect key={b.x} className="mon-band" x={b.x} y={0} width={b.width} height={CHART_H} />
        ))}
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} className="mon-grid" x1={0} x2={CHART_W} y1={CHART_H * f} y2={CHART_H * f} />
      ))}
      {area && <path className="mon-area" d={area} />}
      {line && <path className="mon-line" d={line} />}
    </svg>
  )
}

/** One resource: current value, the axis ceiling, and its history. */
function Card({
  title,
  value,
  detail,
  values,
  max,
  tone,
  wide,
  busy,
  note
}: {
  title: string
  value: string
  detail?: string
  values: (number | null)[]
  max: number
  tone: string
  wide?: boolean
  busy?: boolean[]
  note?: string
}): JSX.Element {
  const available = values.some((v) => v !== null)
  return (
    <div className={`mon-card ${wide ? 'wide' : ''}`} style={{ color: `var(${tone})` }}>
      <div className="mon-card-head">
        <span className="mon-card-title">{title}</span>
        <span className="mon-card-value">{available ? value : 'n/a'}</span>
      </div>
      <div className="mon-card-chart">
        <Chart values={values} max={max} busy={busy} label={`${title} over the last few minutes`} />
        <span className="mon-axis">{available ? `max ${detail ?? ''}`.trim() : ''}</span>
      </div>
      {!available && <div className="mon-card-note">Not reported by this server or machine.</div>}
      {available && note && <div className="mon-card-note">{note}</div>}
    </div>
  )
}

function Tile({
  label,
  value,
  sub
}: {
  label: string
  value: string
  sub?: string
}): JSX.Element {
  return (
    <div className="mon-tile">
      <span className="mon-tile-label">{label}</span>
      <span className="mon-tile-value">{value}</span>
      {sub && <span className="mon-tile-sub">{sub}</span>}
    </div>
  )
}

/**
 * The Monitoring view: live graphs of the Lemonade server's resource usage (CPU,
 * RAM, GPU, VRAM, NPU) and inference activity (generation speed, time to first
 * token, requests), so it's obvious work is happening without relying on fan
 * noise or the log stream. The main process polls only while a view is open.
 *
 * `overlay` is the modal inside the main window; it can be popped out into a
 * separate window (`windowed`), which fills its own OS window and leaves the chat
 * usable beside it.
 */
export function MonitorPanel({
  variant = 'overlay',
  onClose,
  onPopOut,
  awaitingApproval = false
}: {
  variant?: 'overlay' | 'windowed'
  onClose?: () => void
  /** Open the view in its own window. `position` is where, in screen
   * coordinates, when the user dragged it out of the app. */
  onPopOut?: (position?: { x: number; y: number }) => void
  /** A tool call in the chat is waiting for the user's approval. */
  awaitingApproval?: boolean
}): JSX.Element {
  const windowed = variant === 'windowed'
  const [history, setHistory] = useState<MonitorSample[]>([])
  const [requests, setRequests] = useState<RequestRecord[]>([])
  const lastSample = useRef<MonitorSample | null>(null)

  // Dragging the title bar moves the overlay with the pointer. Pull it past the
  // edge of the app window (or let go outside it) and it opens as a separate
  // window, exactly as the pop-out button does. A window can't draw outside
  // itself, so this stands in for dragging the overlay out of the app.
  const [drag, setDrag] = useState<{ dx: number; dy: number; detach: boolean } | null>(null)
  const dragStart = useRef<{
    x: number
    y: number
    grab: number
    rect: DOMRect
    moved: boolean
  } | null>(null)
  const EDGE_PX = 80
  // Whether the panel, moved by (dx, dy), hangs far enough over the window's edge
  // (or the pointer has left the window) that letting go should detach it.
  const wouldDetach = (
    start: { rect: DOMRect },
    dx: number,
    dy: number,
    e: ReactPointerEvent
  ): boolean => {
    const { rect } = start
    const pointerOutside =
      e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight
    return (
      pointerOutside ||
      rect.left + dx < -EDGE_PX ||
      rect.right + dx > window.innerWidth + EDGE_PX ||
      rect.top + dy < -EDGE_PX ||
      rect.bottom + dy > window.innerHeight + EDGE_PX
    )
  }
  function startDrag(e: ReactPointerEvent<HTMLElement>): void {
    if (windowed || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const rect = (e.currentTarget.parentElement ?? e.currentTarget).getBoundingClientRect()
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      grab: e.clientX - rect.left,
      rect,
      moved: false
    }
    // Capture keeps move/up events coming even once the pointer leaves the window.
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function moveDrag(e: ReactPointerEvent<HTMLElement>): void {
    const start = dragStart.current
    if (!start) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (!start.moved && Math.hypot(dx, dy) < 6) return
    start.moved = true
    setDrag({ dx, dy, detach: wouldDetach(start, dx, dy, e) })
  }
  function endDrag(e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void {
    const start = dragStart.current
    dragStart.current = null
    setDrag(null)
    if (!start?.moved || cancelled) return
    if (!wouldDetach(start, e.clientX - start.x, e.clientY - start.y, e)) return
    // Place the new window so the pointer lands in its title bar.
    onPopOut?.({ x: e.screenX - Math.min(start.grab, 240), y: e.screenY - 16 })
  }

  useEffect(() => {
    return subscribeMonitor((sample) => {
      const finished = detectRequest(lastSample.current, sample)
      lastSample.current = sample
      setHistory((prev) => appendSample(prev, sample))
      if (finished) setRequests((prev) => [finished, ...prev].slice(0, MAX_REQUEST_ROWS))
    })
  }, [])

  const latest = history.at(-1) ?? null
  const inf = latest?.inference ?? null
  const sys = latest?.system ?? null
  const series = (pick: (s: MonitorSample) => number | null): (number | null)[] =>
    history.map(pick)
  const peak = (values: (number | null)[], floor: number): number =>
    niceMax(Math.max(floor, ...values.map((v) => v ?? 0)), floor)

  const liveTps = series((s) => s.inference?.liveTokensPerSecond ?? null)
  const liveMax = peak(liveTps, 10)
  const ram = series((s) => s.system?.memoryGb ?? null)
  const vram = series((s) => s.system?.vramGb ?? null)
  const ramMax = peak(ram, 4)
  const vramMax = sys?.vramTotalGb ? niceMax(sys.vramTotalGb) : peak(vram, 4)

  const generating = (inf?.activeRequests ?? 0) > 0
  const busyFlags = history.map((s) => (s.inference?.activeRequests ?? 0) > 0)
  const awaitingOutput = generating && (inf?.liveTokensPerSecond ?? 0) === 0
  const state = !latest ? 'connecting' : latest.online ? 'live' : 'closed'
  const approx = inf?.estimated ? '~' : ''

  const panel = (
    <section
      className={`logs-panel mon-panel ${windowed ? 'windowed' : ''} ${drag ? 'dragging' : ''} ${
        drag?.detach ? 'will-detach' : ''
      }`}
      style={drag ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : undefined}
      onClick={(e) => e.stopPropagation()}
      role={windowed ? undefined : 'dialog'}
      aria-modal={windowed ? undefined : true}
      aria-label="Monitoring"
    >
      <header
        className="pantry-head"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={(e) => endDrag(e, false)}
        onPointerCancel={(e) => endDrag(e, true)}
      >
        <div>
          <h2>
            <ChartBarIcon /> Monitoring
          </h2>
          <p className="pantry-sub">
            {windowed
              ? 'Live resource usage and inference speed of the Lemonade server.'
              : 'Live resource usage and inference speed. Drag this title bar toward the edge of the window to open it separately.'}
          </p>
        </div>
        {!windowed && (
          <div className="mon-head-actions">
            <button
              className="pantry-close"
              onClick={() => onPopOut?.()}
              aria-label="Open in a separate window"
              title="Open in a separate window, so you can keep the chat in view"
            >
              <PopOutIcon />
            </button>
            <button className="pantry-close" onClick={onClose} aria-label="Close" title="Close">
              ✕
            </button>
          </div>
        )}
      </header>

      <div className="mon-body">
        {awaitingApproval && (
          <div className="mon-banner">
            A tool call in the chat is waiting for your approval. Close Monitoring to answer it; the
            reply continues after that.
          </div>
        )}
        {state === 'closed' && (
          <div className="mon-banner">
            The Lemonade server isn't answering. Charts resume when it comes back.
          </div>
        )}

        <h3 className="mon-section">
          Inference
          <span className={`mon-activity ${generating ? 'busy' : ''}`}>
            <span className="logs-dot" aria-hidden="true" />
            {generating ? `Generating (${inf?.activeRequests} active)` : 'Idle'}
          </span>
        </h3>

        <div className="mon-tiles">
          <Tile
            label="Live speed"
            value={`${formatRate(inf?.liveTokensPerSecond ?? null)} tok/s`}
            sub={
              awaitingOutput
                ? 'working, no output yet'
                : generating
                  ? 'while generating'
                  : (inf?.liveTokensPerSecond ?? 0) > 0
                    ? 'speed of the last model call'
                    : 'while generating'
            }
          />
          <Tile
            label="Last request"
            value={`${approx}${formatRate(inf?.tokensPerSecond ?? null)} tok/s`}
            sub={`first token in ${formatSeconds(inf?.timeToFirstToken ?? null)}${
              inf?.estimated ? ' · estimated' : ''
            }`}
          />
          <Tile
            label="Last prompt"
            value={`${approx}${formatCount(inf?.promptTokens ?? null)} tok`}
            sub={`${formatCount(inf?.cacheTokens ?? null)} from cache`}
          />
          <Tile
            label="Since server start"
            value={`${formatCount(inf?.outputTokensTotal ?? null)} tok out`}
            sub={`${formatCount(inf?.requestCountTotal ?? null)} requests`}
          />
        </div>

        <div className="mon-grid-cards">
          <Card
            wide
            title="Generation speed (tok/s)"
            value={`${formatRate(inf?.liveTokensPerSecond ?? null)} tok/s`}
            detail={`${liveMax} tok/s`}
            values={liveTps}
            max={liveMax}
            tone="--accent"
            busy={busyFlags}
            note="Shaded: a request was running. Omni models reply all at once, so their speed appears as a brief reading when each model call finishes, and under Last request."
          />
        </div>

        <h3 className="mon-section">System</h3>
        <div className="mon-grid-cards">
          <Card
            title="CPU"
            value={formatPercent(sys?.cpuPercent ?? null)}
            detail="100%"
            values={series((s) => s.system?.cpuPercent ?? null)}
            max={100}
            tone="--c-system"
          />
          <Card
            title="Memory (RAM)"
            value={formatGb(sys?.memoryGb ?? null)}
            detail={`${ramMax} GB`}
            values={ram}
            max={ramMax}
            tone="--c-results"
          />
          <Card
            title={sys?.gpuName ? `GPU · ${sys.gpuName}` : 'GPU'}
            value={formatPercent(sys?.gpuPercent ?? null)}
            detail="100%"
            values={series((s) => s.system?.gpuPercent ?? null)}
            max={100}
            tone="--c-messages"
          />
          <Card
            title="GPU memory"
            value={formatGb(sys?.vramGb ?? null)}
            detail={`${vramMax} GB`}
            values={vram}
            max={vramMax}
            tone="--c-reserve"
          />
          <Card
            title="NPU"
            value={formatPercent(sys?.npuPercent ?? null)}
            detail="100%"
            values={series((s) => s.system?.npuPercent ?? null)}
            max={100}
            tone="--c-tools"
          />
        </div>

        <h3 className="mon-section">Recent requests</h3>
        {requests.length === 0 ? (
          <div className="mon-empty">
            Finished requests appear here as they complete. Figures marked ~ are estimated by
            Lemonade Stand, used when the server's log has no timing for the request.
          </div>
        ) : (
          <table className="mon-table">
            <thead>
              <tr>
                <th>Finished</th>
                <th>tok/s</th>
                <th>First token</th>
                <th>Prompt in</th>
                <th>Generated</th>
                <th>Cached</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => {
                const mark = r.estimated ? '~' : ''
                return (
                  <tr key={r.time}>
                    <td>{new Date(r.time).toLocaleTimeString()}</td>
                    <td>
                      {mark}
                      {formatRate(r.tokensPerSecond)}
                    </td>
                    <td>{formatSeconds(r.timeToFirstToken)}</td>
                    <td>
                      {mark}
                      {formatCount(r.inputTokens)}
                    </td>
                    <td>
                      {mark}
                      {formatCount(r.outputTokens)}
                    </td>
                    <td>{formatCount(r.cacheTokens)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <footer className="logs-foot">
        <span className={`logs-state ${state}`}>
          <span className="logs-dot" aria-hidden="true" />
          {state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting…' : 'Disconnected'}
        </span>
        <span>Updates every second · last {Math.round(MONITOR_WINDOW / 60)} minutes shown</span>
      </footer>
    </section>
  )

  return windowed ? (
    panel
  ) : (
    <div className="pantry-overlay logs-overlay" onClick={onClose}>
      {panel}
      {drag?.detach && (
        <div className="mon-detach-hint" role="status">
          Release to open Monitoring in its own window
        </div>
      )}
    </div>
  )
}


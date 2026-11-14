import type { Pitcher } from '@shared/types'
import { isMissed, nextFireAt } from '@shared/schedule'
import { readPitchers } from '../config'

// setTimeout overflows (and fires immediately) past ~24.8 days, which a monthly
// task can exceed, so long waits are split into hops.
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Owns the timers for scheduled Pitchers plus the launch-time on-open / catch-up
 * runs. Pours are handed off to an injected `pour` callback the main process
 * implements (it has the agent, history store, and window). Runs are serialized
 * through a queue and deferred while an interactive agent turn is active, so a
 * scheduled pour never collides with the user's own chat.
 */
export class PitcherScheduler {
  private timers = new Map<string, NodeJS.Timeout>()
  private queue: string[] = []
  private draining = false
  private stopped = false

  constructor(
    private readonly cwd: string,
    private readonly pour: (p: Pitcher) => Promise<void>,
    private readonly isBusy: () => boolean
  ) {}

  /** Call once after the window exists. Runs on-open + any missed scheduled
   * fires, then arms timers for future fires. */
  start(): void {
    this.stopped = false
    const pitchers = readPitchers(this.cwd).filter((p) => p.enabled)
    for (const p of pitchers) {
      if (p.trigger.type === 'on-open') this.enqueue(p.id)
      else if (isMissed(p)) this.enqueue(p.id)
    }
    this.arm(pitchers)
  }

  /** Re-read from disk and rebuild all timers (after a save or delete). */
  reload(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.arm(readPitchers(this.cwd).filter((p) => p.enabled))
  }

  /** Tear down every timer (on quit). */
  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private arm(pitchers: Pitcher[]): void {
    for (const p of pitchers) this.schedule(p, new Date())
  }

  /** Arm the timer for `p`'s next fire strictly after `after`. */
  private schedule(p: Pitcher, after: Date): void {
    if (p.trigger.type === 'on-open') return
    const existing = this.timers.get(p.id)
    if (existing) clearTimeout(existing)

    let target: number
    if (p.trigger.type === 'interval') {
      target = after.getTime() + p.trigger.everyMinutes * 60_000
    } else {
      const next = nextFireAt(p.trigger, after)
      if (next == null) return
      target = next
    }

    // setTimeout (not setInterval) so we recompute after each fire, which is
    // robust to clock drift, DST, and the machine sleeping through a fire.
    const delay = target - Date.now()
    const isHop = delay > MAX_TIMEOUT_MS
    const timer = setTimeout(
      () => {
        if (isHop) {
          this.schedule(p, after) // only a hop of a long wait; recompute and keep waiting
          return
        }
        this.enqueue(p.id)
        // Re-arm from the fire time so a timer that lands a few ms early can't
        // pick the same fire again.
        this.schedule(p, new Date(Math.max(Date.now(), target)))
      },
      Math.min(Math.max(0, delay), MAX_TIMEOUT_MS)
    )
    this.timers.set(p.id, timer)
  }

  /** Queue a pour by id. Shared by timers and the manual "Pour now" path so
   * every run goes through the same serialized, busy-aware drain. */
  enqueue(id: string): void {
    if (!this.queue.includes(id)) this.queue.push(id)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length && !this.stopped) {
        // Never collide with an interactive turn; wait it out.
        if (this.isBusy()) {
          await new Promise((r) => setTimeout(r, 2000))
          continue
        }
        const id = this.queue.shift()!
        const p = readPitchers(this.cwd).find((x) => x.id === id)
        if (!p || !p.enabled) continue
        try {
          await this.pour(p)
        } catch {
          // pour() is expected to record its own failure; never let one bad
          // pour break the drain loop for the rest of the queue.
        }
      }
    } finally {
      this.draining = false
    }
  }
}

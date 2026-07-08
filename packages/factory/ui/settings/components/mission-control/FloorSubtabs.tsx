import React from 'react'
import { Icon } from './icons'
import type { CenterMode, TicketSource } from './floorModel'

// The Floor sub-tab strip. Sits UNDER the top FLOOR/BENCH/PANEL tabs and is the
// primary nav between the CenterMode surfaces (Agents / Backlog / Hosts), replacing
// the sidebar's onScope as the way you switch views. Fixed center tabs render as
// rounded pills (active = lime, with a count + needs badge); dynamically-opened task
// tabs render to their right as CLOSEABLE pills. The Dispatch button lives on the
// right of the strip. Prototype concept: sub-tab strip + one contextual controls bar.

/** A fixed center tab (Agents / Backlog / Hosts) with live counts. */
export interface FixedTab {
  center: CenterMode
  label: string
  count: number
  /** Needs-you count; renders a red badge when > 0. Omit for centers with no needs. */
  needs?: number
}

/** A dynamically-opened, closeable task tab. Double-clicking a ticket or agent opens one. */
export interface TaskTab {
  id: string
  title: string
  source: TicketSource
}

/**
 * Open a task tab, de-duping by id (double-clicking the same ticket focuses the
 * existing tab instead of stacking a duplicate). Pure so it's unit-tested.
 */
export function openTaskTab(tabs: TaskTab[], tab: TaskTab): TaskTab[] {
  if (tabs.some((t) => t.id === tab.id)) return tabs
  return [...tabs, tab]
}

/**
 * Close a task tab. When the closed tab was active, focus falls to its left neighbor
 * (or the right one when it was first, or null when it was the last tab — which drops
 * the user back to the active fixed center tab). Returns the next tabs + active id.
 * Pure so the open/close/active-fallback logic is unit-tested.
 */
export function closeTaskTab(
  tabs: TaskTab[],
  activeId: string | null,
  closeId: string,
): { tabs: TaskTab[]; activeId: string | null } {
  const idx = tabs.findIndex((t) => t.id === closeId)
  if (idx === -1) return { tabs, activeId }
  const next = tabs.filter((t) => t.id !== closeId)
  if (activeId !== closeId) return { tabs: next, activeId }
  if (next.length === 0) return { tabs: next, activeId: null }
  // Left neighbor (or first tab when the closed one led). Guaranteed in range since
  // next.length > 0 and idx <= old length - 1, so Math.max(0, idx-1) < next.length.
  const neighbor = next[Math.max(0, idx - 1)]!
  return { tabs: next, activeId: neighbor.id }
}

interface FloorSubtabsProps {
  fixed: FixedTab[]
  /** The active fixed center (only visually active when no task tab is active). */
  center: CenterMode
  taskTabs: TaskTab[]
  /** null = a fixed center tab is active; otherwise the active task-tab id. */
  activeTaskTab: string | null
  onSelectCenter: (c: CenterMode) => void
  onSelectTaskTab: (id: string) => void
  onCloseTaskTab: (id: string) => void
  onDispatch: () => void
}

export function FloorSubtabs({
  fixed, center, taskTabs, activeTaskTab,
  onSelectCenter, onSelectTaskTab, onCloseTaskTab, onDispatch,
}: FloorSubtabsProps) {
  return (
    <div className="fsubtabs" role="tablist">
      {fixed.map((t) => {
        const on = activeTaskTab === null && center === t.center
        return (
          <button
            key={t.center}
            role="tab"
            aria-selected={on}
            className={`fsubtab ${on ? 'on' : ''}`}
            onClick={() => onSelectCenter(t.center)}
          >
            <span className="fsubtab-label">{t.label}</span>
            <span className="fsubtab-cnt">{t.count}</span>
            {t.needs ? <span className="fsubtab-needs">{t.needs}</span> : null}
          </button>
        )
      })}

      {taskTabs.map((t) => {
        const on = activeTaskTab === t.id
        return (
          <span
            key={t.id}
            role="tab"
            aria-selected={on}
            className={`fsubtab tasktab ${on ? 'on' : ''}`}
            onClick={() => onSelectTaskTab(t.id)}
          >
            <span className={`tasktab-src ${t.source}`}>{t.source}</span>
            <span className="fsubtab-label">{t.title}</span>
            <span
              className="tasktab-x"
              role="button"
              aria-label={`Close ${t.title}`}
              title="Close tab"
              onClick={(e) => { e.stopPropagation(); onCloseTaskTab(t.id) }}
            >
              <Icon name="x" size={11} />
            </span>
          </span>
        )
      })}

      <div className="grow" />

      <button className="disp" onClick={onDispatch}><Icon name="zap" size={12} /> Dispatch</button>
    </div>
  )
}

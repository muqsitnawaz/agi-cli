import React from 'react'
import { Icon } from './icons'
import type {
  AgentAbbr,
  CenterMode,
  FloorSort,
  TicketGroupBy,
  TicketSort,
  TicketSource,
} from './floorModel'

// Contextual Floor filter bar. It renders ONE control set for the ACTIVE sub-tab
// (agents vs backlog) instead of the old unconditional global bar — so the Backlog
// view no longer stacked the agents Group/Sort bar on top of its own toolbar. The
// Dispatch button now lives on the sub-tab strip (FloorSubtabs), not here. The right
// cluster (running stat, plain-language, panel toggles) is chrome common to both modes.
// Prototype: factory-floor-v2.html fbar.

export type StatusChip = 'needs' | 'running' | 'idle' | 'failed'

/**
 * Which contextual control set a center wants. Pure so the parent gates the bar off
 * for centers that have no controls (host / projects) and the choice is unit-tested.
 */
export function floorControlsMode(center: CenterMode): 'agents' | 'backlog' | null {
  if (center === 'agents') return 'agents'
  if (center === 'backlog') return 'backlog'
  return null
}

const SORT_OPTS: { value: FloorSort; label: string }[] = [
  { value: 'needs', label: 'Needs you first' },
  { value: 'recent', label: 'Recent activity' },
  { value: 'tok', label: 'tok/s' },
  { value: 'name', label: 'Name' },
]

// Backlog group/sort options — moved here from BacklogCenter's now-removed toolbar so
// the single contextual bar owns them (one bar, zero duplication).
const TICKET_GROUP_OPTS: { value: TicketGroupBy; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'priority', label: 'Priority' },
  { value: 'source', label: 'Source' },
  { value: 'status', label: 'Status' },
]
const TICKET_SORT_OPTS: TicketSort[] = ['priority', 'id']

const DEFAULT_AGENT_CHIPS: AgentAbbr[] = ['CC', 'CX', 'GX']

const SVG = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 } as const

interface FloorControlsProps {
  /** Which control set to render. Center 'host'/other renders no bar (parent gates). */
  mode: 'agents' | 'backlog'

  runningCount: number
  totalCount: number

  sidebarOpen: boolean
  onToggleSidebar: () => void
  rightOpen: boolean
  onToggleRight: () => void
  plain: boolean
  onTogglePlain: () => void

  // --- agents-mode controls ---
  sort: FloorSort
  onSort: (s: FloorSort) => void
  /** Which status chips are active. */
  activeStatus: StatusChip[]
  onToggleStatus: (chip: StatusChip) => void
  /** Which agent-type chips to show (defaults to CC/CX/GX like the prototype). */
  agentChips?: AgentAbbr[]
  /** Which agent-type chips are active. */
  activeAbbrs: AgentAbbr[]
  onToggleAbbr: (abbr: AgentAbbr) => void

  // --- backlog-mode controls ---
  ticketGroup: TicketGroupBy
  onTicketGroup: (by: TicketGroupBy) => void
  ticketSort: TicketSort
  onTicketSort: (by: TicketSort) => void
  srcFilter: Record<TicketSource, boolean>
  onToggleSrc: (src: TicketSource) => void

  search: string
  onSearch: (q: string) => void
}

export function FloorControls({
  mode,
  runningCount, totalCount,
  sidebarOpen, onToggleSidebar, rightOpen, onToggleRight, plain, onTogglePlain,
  sort, onSort, activeStatus, onToggleStatus, agentChips = DEFAULT_AGENT_CHIPS, activeAbbrs, onToggleAbbr,
  ticketGroup, onTicketGroup, ticketSort, onTicketSort, srcFilter, onToggleSrc,
  search, onSearch,
}: FloorControlsProps) {
  const statusOn = new Set(activeStatus)
  const abbrOn = new Set(activeAbbrs)

  return (
    <div className="fbar" data-mode={mode}>
      {mode === 'agents' ? (
        <>
          <div className="fgroup">
            <span className="fgroup-label">Sort</span>
            <select className="sel" value={sort} onChange={(e) => onSort(e.target.value as FloorSort)}>
              {SORT_OPTS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className="fsep" />

          <div className="fgroup">
            <span className="fgroup-label">Status</span>
            <span className={`chip needs ${statusOn.has('needs') ? 'on' : ''}`} onClick={() => onToggleStatus('needs')}>
              <Icon name="alert" size={11} /> Needs you
            </span>
            <span className={`chip ${statusOn.has('running') ? 'on' : ''}`} onClick={() => onToggleStatus('running')}>
              <span className="dot running" /> Running
            </span>
            <span className={`chip ${statusOn.has('idle') ? 'on' : ''}`} onClick={() => onToggleStatus('idle')}>
              <span className="dot idle" /> Idle
            </span>
            <span className={`chip ${statusOn.has('failed') ? 'on' : ''}`} onClick={() => onToggleStatus('failed')}>
              <span className="dot failed" /> Failed
            </span>
          </div>

          <div className="fsep" />

          <div className="fgroup">
            <span className="fgroup-label">Agent</span>
            {agentChips.map((ab) => (
              <span key={ab} className={`chip ${abbrOn.has(ab) ? 'on' : ''}`} onClick={() => onToggleAbbr(ab)}>{ab}</span>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="fgroup">
            <span className="fgroup-label">Group</span>
            <select className="sel" value={ticketGroup} onChange={(e) => onTicketGroup(e.target.value as TicketGroupBy)}>
              {TICKET_GROUP_OPTS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className="fsep" />

          <div className="fgroup">
            <span className="fgroup-label">Sort</span>
            <select className="sel" value={ticketSort} onChange={(e) => onTicketSort(e.target.value as TicketSort)}>
              {TICKET_SORT_OPTS.map((o) => (
                <option key={o} value={o}>{o === 'id' ? 'ID' : 'Priority'}</option>
              ))}
            </select>
          </div>

          <div className="fsep" />

          <div className="fgroup">
            <span className="fgroup-label">Source</span>
            <span className={`chip ${srcFilter.LN ? 'on' : ''}`} onClick={() => onToggleSrc('LN')}>LN</span>
            <span className={`chip ${srcFilter.GH ? 'on' : ''}`} onClick={() => onToggleSrc('GH')}>GH</span>
          </div>
        </>
      )}

      <div className="fsep" />

      <input
        className="search"
        placeholder={mode === 'agents' ? 'search agents, branches, activity…' : 'search tickets, ids, labels…'}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />

      <div className="grow" />

      <div className="stat"><span className="dot running" /><b>{runningCount}</b>/<span>{totalCount}</span> running</div>
      <button className="themebtn" onClick={onTogglePlain}>Plain language: {plain ? 'on' : 'off'}</button>
      <button
        className={`iconbtn ${sidebarOpen ? 'on' : ''}`}
        title="Show / hide projects sidebar"
        onClick={onToggleSidebar}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" {...SVG}>
          <rect x="2.2" y="2.5" width="11.6" height="11" rx="1.4" />
          <line x1="6" y1="2.5" x2="6" y2="13.5" />
        </svg>
      </button>
      <button
        className={`iconbtn ${rightOpen ? 'on' : ''}`}
        title="Show / hide the detail panel"
        onClick={onToggleRight}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" {...SVG}>
          <rect x="2.2" y="2.5" width="11.6" height="11" rx="1.4" />
          <line x1="10" y1="2.5" x2="10" y2="13.5" />
        </svg>
      </button>
    </div>
  )
}

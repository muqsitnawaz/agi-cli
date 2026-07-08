import { describe, test, expect } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FloorControls, floorControlsMode } from './FloorControls'
import type { TicketSource } from './floorModel'

describe('floorControlsMode', () => {
  test('agents center wants the agents control set', () => {
    expect(floorControlsMode('agents')).toBe('agents')
  })
  test('backlog center wants the backlog control set', () => {
    expect(floorControlsMode('backlog')).toBe('backlog')
  })
  test('host center wants NO controls (bar is gated off)', () => {
    expect(floorControlsMode('host')).toBeNull()
  })
})

const noop = () => {}
const srcFilter: Record<TicketSource, boolean> = { LN: true, GH: true }

function markup(mode: 'agents' | 'backlog'): string {
  return renderToStaticMarkup(
    <FloorControls
      mode={mode}
      runningCount={2}
      totalCount={5}
      sidebarOpen
      onToggleSidebar={noop}
      rightOpen
      onToggleRight={noop}
      plain={false}
      onTogglePlain={noop}
      sort="needs"
      onSort={noop}
      activeStatus={[]}
      onToggleStatus={noop}
      activeAbbrs={[]}
      onToggleAbbr={noop}
      ticketGroup="project"
      onTicketGroup={noop}
      ticketSort="priority"
      onTicketSort={noop}
      srcFilter={srcFilter}
      onToggleSrc={noop}
      search=""
      onSearch={noop}
    />,
  )
}

describe('FloorControls renders the correct control set per mode', () => {
  test("agents mode shows the agents Status/Agent chips, not the backlog LN/GH source chips", () => {
    const html = markup('agents')
    expect(html).toContain('Needs you') // agents Status chip
    expect(html).toContain('Running')
    expect(html).toContain('>CC<') // agent-type chip
    expect(html).not.toContain('>LN<') // backlog source chip must NOT be here
  })

  test('backlog mode shows Group + LN/GH source chips, not the agents Status chips', () => {
    const html = markup('backlog')
    expect(html).toContain('Group')
    expect(html).toContain('>LN<')
    expect(html).toContain('>GH<')
    expect(html).not.toContain('Needs you') // agents Status chip must NOT be here
  })

  test('neither mode renders the Dispatch button — it moved to the sub-tab strip', () => {
    expect(markup('agents')).not.toContain('Dispatch')
    expect(markup('backlog')).not.toContain('Dispatch')
  })
})

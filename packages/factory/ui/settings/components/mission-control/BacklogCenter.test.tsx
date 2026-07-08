import { describe, test, expect } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BacklogCenter } from './BacklogCenter'
import type { FloorTicket, TicketSource } from './floorModel'

const noop = () => {}
const srcFilter: Record<TicketSource, boolean> = { LN: true, GH: true }

const tickets: FloorTicket[] = [
  { id: 'RUSH-1', title: 'Fix the thing', project: 'rush', source: 'LN', pri: 'high', status: 'todo', desc: '', labels: ['bug'] },
  { id: '#42', title: 'Kanban stub', project: 'swarmify', source: 'GH', pri: 'med', status: 'in-progress', desc: '', labels: [] },
]

function markup(): string {
  return renderToStaticMarkup(
    <BacklogCenter
      tickets={tickets}
      group="project"
      sort="priority"
      srcFilter={srcFilter}
      projFilter={null}
      search=""
      selectedTicketId={null}
      onSelectTicket={noop}
      onOpenTask={noop}
    />,
  )
}

describe('BacklogCenter', () => {
  test('no longer renders its own toolbar — the duplicate bktoolbar is gone', () => {
    const html = markup()
    expect(html).not.toContain('bktoolbar')
    // The group/sort <select>s that lived in that toolbar are gone too (they moved
    // to the shared contextual bar). Only ticket rows + section headers remain.
    expect(html).not.toContain('<select')
  })

  test('still renders the ticket rows it is responsible for', () => {
    const html = markup()
    expect(html).toContain('trow2')
    expect(html).toContain('RUSH-1')
    expect(html).toContain('Fix the thing')
  })

  test('respects the source filter driven by the shared bar', () => {
    const html = renderToStaticMarkup(
      <BacklogCenter
        tickets={tickets}
        group="project"
        sort="priority"
        srcFilter={{ LN: true, GH: false }}
        projFilter={null}
        search=""
        selectedTicketId={null}
        onSelectTicket={noop}
        onOpenTask={noop}
      />,
    )
    expect(html).toContain('RUSH-1') // LN kept
    expect(html).not.toContain('Kanban stub') // GH filtered out
  })
})

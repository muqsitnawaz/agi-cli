import { describe, test, expect } from 'bun:test'
import { openTaskTab, closeTaskTab, type TaskTab } from './FloorSubtabs'

const tab = (id: string): TaskTab => ({ id, title: `Task ${id}`, source: 'LN' })

describe('openTaskTab', () => {
  test('appends a new tab', () => {
    const next = openTaskTab([], tab('A'))
    expect(next.map((t) => t.id)).toEqual(['A'])
  })

  test('de-dupes by id — re-opening the same task does not stack a duplicate', () => {
    const start = [tab('A'), tab('B')]
    const next = openTaskTab(start, tab('A'))
    expect(next).toBe(start) // same reference: no state churn
    expect(next.map((t) => t.id)).toEqual(['A', 'B'])
  })

  test('keeps insertion order', () => {
    let tabs: TaskTab[] = []
    for (const id of ['A', 'B', 'C']) tabs = openTaskTab(tabs, tab(id))
    expect(tabs.map((t) => t.id)).toEqual(['A', 'B', 'C'])
  })
})

describe('closeTaskTab', () => {
  test('removes the tab and leaves active untouched when a non-active tab closes', () => {
    const res = closeTaskTab([tab('A'), tab('B'), tab('C')], 'A', 'C')
    expect(res.tabs.map((t) => t.id)).toEqual(['A', 'B'])
    expect(res.activeId).toBe('A')
  })

  test('closing the active middle tab focuses the LEFT neighbor', () => {
    const res = closeTaskTab([tab('A'), tab('B'), tab('C')], 'B', 'B')
    expect(res.tabs.map((t) => t.id)).toEqual(['A', 'C'])
    expect(res.activeId).toBe('A')
  })

  test('closing the active FIRST tab focuses the new first tab', () => {
    const res = closeTaskTab([tab('A'), tab('B'), tab('C')], 'A', 'A')
    expect(res.tabs.map((t) => t.id)).toEqual(['B', 'C'])
    expect(res.activeId).toBe('B')
  })

  test('closing the last remaining tab clears active (falls back to a fixed center tab)', () => {
    const res = closeTaskTab([tab('A')], 'A', 'A')
    expect(res.tabs).toEqual([])
    expect(res.activeId).toBeNull()
  })

  test('closing an unknown id is a no-op', () => {
    const start = [tab('A'), tab('B')]
    const res = closeTaskTab(start, 'A', 'Z')
    expect(res.tabs).toBe(start)
    expect(res.activeId).toBe('A')
  })
})

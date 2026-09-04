import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hideProject,
  unhideProject,
  liveThreadsForColony,
  hiddenCatalog,
} from './hidden-projects.js'

test('hideProject adds a name once', () => {
  const next = hideProject(['alpha'], 'beta')
  assert.deepEqual(next, ['alpha', 'beta'])
  assert.deepEqual(hideProject(next, 'beta'), ['alpha', 'beta'])
})

test('unhideProject removes a name', () => {
  assert.deepEqual(unhideProject(['alpha', 'beta'], 'alpha'), ['beta'])
  assert.deepEqual(unhideProject(['beta'], 'missing'), ['beta'])
})

test('liveThreadsForColony drops archived threads and hidden repos', () => {
  const threads = [
    { id: '1', project: 'keep', archived: false },
    { id: '2', project: 'keep', archived: true },
    { id: '3', project: 'gone', archived: false },
    { id: '4', project: 'also', archived: false },
  ]
  const live = liveThreadsForColony(threads, ['2'], ['gone'])
  assert.deepEqual(
    live.map((t) => t.id),
    ['1', '4']
  )
})

test('hiddenCatalog lists hidden names with live thread counts', () => {
  const catalog = hiddenCatalog(
    ['gone', 'empty'],
    [
      { project: 'gone', archived: false },
      { project: 'gone', archived: false },
      { project: 'gone', archived: true },
      { project: 'keep', archived: false },
    ]
  )
  assert.equal(catalog.length, 2)
  assert.equal(catalog[0].name, 'empty')
  assert.equal(catalog[0].count, 0)
  assert.equal(catalog[1].name, 'gone')
  assert.equal(catalog[1].count, 2)
})

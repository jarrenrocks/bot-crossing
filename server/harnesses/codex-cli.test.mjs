import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createCodexHarness } from './codex-cli.mjs'

const line = (type, payload, timestamp = '2026-09-04T12:00:00.000Z') => JSON.stringify({ timestamp, type, payload })

async function fixture(records, { indexed = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-codex-'))
  const codexHome = path.join(root, '.codex')
  const day = path.join(codexHome, 'sessions', '2026', '09', '04')
  const project = path.join(root, 'project', 'nested')
  await fsp.mkdir(day, { recursive: true })
  await fsp.mkdir(project, { recursive: true })
  await fsp.writeFile(path.join(root, 'project', '.git'), 'gitdir: elsewhere\n')
  const file = path.join(day, 'rollout-example.jsonl')
  await fsp.writeFile(file, `${records.join('\n')}\n`)
  if (indexed) {
    await fsp.writeFile(path.join(codexHome, 'session_index.jsonl'), `${JSON.stringify({ id: 'session-1', thread_name: 'Indexed title', updated_at: '2026-09-04T12:01:00.000Z' })}\n`)
  }
  return { root, codexHome, project, file }
}

test('normalizes a recent running Codex transcript', async (t) => {
  const data = await fixture([
    line('session_meta', { id: 'session-1', cwd: '/placeholder', timestamp: '2026-09-04T11:00:00.000Z', git: { branch: 'feature/codex' } }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build a small adapter.' }] }),
    line('turn_context', { cwd: '/placeholder', model: 'gpt-test', effort: 'high' }),
    line('event_msg', { type: 'task_started' }),
  ])
  t.after(() => fsp.rm(data.root, { recursive: true, force: true }))
  const raw = await fsp.readFile(data.file, 'utf8')
  await fsp.writeFile(data.file, raw.replaceAll('/placeholder', data.project))
  const stat = await fsp.stat(data.file)

  const harness = createCodexHarness({ codexHome: data.codexHome, now: () => stat.mtimeMs + 1000 })
  assert.equal(await harness.detect(), true)
  const [thread] = await harness.scanThreads()
  assert.equal(thread.id, 'codex-cli:session-1')
  assert.equal(thread.title, 'Indexed title')
  assert.equal(thread.preview, 'Build a small adapter.')
  assert.equal(thread.projectPath, path.join(data.root, 'project'))
  assert.equal(thread.cwd, data.project)
  assert.equal(thread.gitBranch, 'feature/codex')
  assert.equal(thread.model, 'gpt-test')
  assert.equal(thread.effort, 'high')
  assert.equal(thread.running, true)
  assert.equal(thread.unread, false)
  assert.equal(thread.canOpen, false)
  assert.equal(thread.canArchive, false)
  assert.equal(thread.sizeBytes, stat.size)
  assert.deepEqual(thread.ref, { sessionId: 'session-1', cwd: data.project })
})

test('skips malformed records and does not call an old unfinished task running', async (t) => {
  const data = await fixture([
    '{not-json',
    line('session_meta', { id: 'session-1', cwd: '/tmp/project' }),
    line('event_msg', { type: 'task_started' }),
  ], { indexed: false })
  t.after(() => fsp.rm(data.root, { recursive: true, force: true }))
  const harness = createCodexHarness({ codexHome: data.codexHome, now: () => Date.now() + 10 * 60 * 1000 })
  const [thread] = await harness.scanThreads()
  assert.equal(thread.running, false)
  assert.equal(thread.title, 'Untitled thread')
})

test('reports the latest aborted lifecycle as an error', async (t) => {
  const data = await fixture([
    line('session_meta', { id: 'session-1', cwd: '/tmp/project' }),
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'turn_aborted' }),
  ])
  t.after(() => fsp.rm(data.root, { recursive: true, force: true }))
  const [thread] = await createCodexHarness({ codexHome: data.codexHome }).scanThreads()
  assert.equal(thread.running, false)
  assert.equal(thread.hasError, true)
})

test('reads lifecycle state from the tail of a large transcript', async (t) => {
  const data = await fixture([
    line('session_meta', { id: 'session-1', cwd: '/tmp/project' }),
    line('event_msg', { type: 'task_started' }),
    line('response_item', { type: 'reasoning', content: 'x'.repeat(300 * 1024) }),
    line('event_msg', { type: 'task_complete' }),
  ])
  t.after(() => fsp.rm(data.root, { recursive: true, force: true }))
  const [thread] = await createCodexHarness({ codexHome: data.codexHome }).scanThreads()
  assert.equal(thread.running, false)
})

test('handles an absent Codex installation and unsupported actions', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-codex-missing-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const harness = createCodexHarness({ codexHome: path.join(root, '.codex') })
  assert.equal(await harness.detect(), false)
  assert.deepEqual(await harness.scanThreads(), [])
  assert.equal(harness.openThread({}).ok, false)
  assert.equal(harness.newSession('/tmp').ok, false)
  assert.equal((await harness.setArchived({}, true)).ok, false)
})

test('builds the verified VS Code route for a valid Codex thread ID', () => {
  const harness = createCodexHarness()
  const sessionId = '12345678-1234-4abc-8def-123456789abc'
  assert.deepEqual(harness.openThread({ sessionId }), {
    ok: true,
    url: `openai-codex://route/local/${sessionId}`,
  })
  assert.equal(harness.openThread({ sessionId: 'not-a-session' }).ok, false)
})

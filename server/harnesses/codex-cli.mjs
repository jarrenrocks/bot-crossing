/** Read-only adapter for Codex CLI's local JSONL session transcripts. */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { exists, jsonLines, listDirs, listFiles, readHead } from '../lib/fsutil.mjs'

const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 256 * 1024
const ACTIVE_WINDOW_MS = 5 * 60 * 1000
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function timestamp(value, fallback = 0) {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : fallback
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => typeof part === 'string' ? part : part?.text || part?.input_text || '').filter(Boolean).join('\n')
}

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240)

async function readTail(file, size) {
  if (size <= TAIL_BYTES) return await fsp.readFile(file, 'utf8')
  const handle = await fsp.open(file, 'r')
  try {
    const buffer = Buffer.alloc(TAIL_BYTES)
    await handle.read(buffer, 0, TAIL_BYTES, size - TAIL_BYTES)
    const text = buffer.toString('utf8')
    const newline = text.indexOf('\n')
    return newline < 0 ? '' : text.slice(newline + 1)
  } finally {
    await handle.close()
  }
}

async function findTranscripts(root) {
  const found = []
  for (const year of await listDirs(root)) {
    for (const month of await listDirs(year)) {
      for (const day of await listDirs(month)) {
        found.push(...await listFiles(day, (name) => /^rollout-.*\.jsonl$/.test(name)))
      }
    }
  }
  return found
}

async function readIndex(file) {
  const result = new Map()
  try {
    for (const row of jsonLines(await fsp.readFile(file, 'utf8'))) {
      if (!row?.id) continue
      const old = result.get(row.id)
      if (!old || timestamp(row.updated_at) >= timestamp(old.updated_at)) result.set(row.id, row)
    }
  } catch {
    // The index is optional; transcripts are authoritative.
  }
  return result
}

function inspect(records) {
  const result = { sessionId: '', cwd: '', gitBranch: '', model: '', effort: '', originator: '', sessionSource: '', createdAt: 0, prompt: '', lifecycle: '' }
  for (const record of records) {
    const payload = record?.payload
    if (!payload || typeof payload !== 'object') continue
    if (record.type === 'session_meta') {
      result.sessionId ||= payload.id || payload.session_id || ''
      result.cwd ||= payload.cwd || ''
      result.gitBranch ||= payload.git?.branch || ''
      result.originator ||= payload.originator || ''
      result.sessionSource ||= payload.source || ''
      result.createdAt ||= timestamp(payload.timestamp || record.timestamp)
      result.model ||= payload.model || payload.model_provider || ''
    } else if (record.type === 'turn_context') {
      result.cwd = payload.cwd || result.cwd
      result.model = payload.model || result.model
      result.effort = payload.effort || result.effort
    } else if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      result.prompt ||= clean(contentText(payload.content))
    } else if (record.type === 'event_msg') {
      if (payload.type === 'task_started') result.lifecycle = 'running'
      if (payload.type === 'task_complete') result.lifecycle = 'complete'
      if (payload.type === 'turn_aborted') result.lifecycle = 'aborted'
    }
  }
  return result
}

async function findGitRoot(cwd, cache) {
  if (!cwd || !path.isAbsolute(cwd)) return ''
  if (cache.has(cwd)) return cache.get(cwd)
  let current = cwd
  while (true) {
    if (await exists(path.join(current, '.git'))) {
      cache.set(cwd, current)
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  cache.set(cwd, '')
  return ''
}

export function createCodexHarness({ codexHome = path.join(os.homedir(), '.codex'), now = () => Date.now(), activeWindowMs = ACTIVE_WINDOW_MS } = {}) {
  const sessionsDir = path.join(codexHome, 'sessions')
  const indexFile = path.join(codexHome, 'session_index.jsonl')
  const parseCache = new Map()
  const rootCache = new Map()

  async function parse(file, stat) {
    const cached = parseCache.get(file)
    if (cached?.mtimeMs === stat.mtimeMs && cached?.size === stat.size) return cached.value
    const head = await readHead(file, HEAD_BYTES)
    const tail = stat.size > HEAD_BYTES ? await readTail(file, stat.size) : ''
    const value = inspect([...jsonLines(head), ...jsonLines(tail)])
    parseCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value })
    return value
  }

  async function scanThreads() {
    const index = await readIndex(indexFile)
    const threads = []
    for (const file of await findTranscripts(sessionsDir)) {
      try {
        const stat = await fsp.stat(file)
        const session = await parse(file, stat)
        if (!session.sessionId) continue
        const indexed = index.get(session.sessionId)
        const cwd = session.cwd && path.isAbsolute(session.cwd) ? session.cwd : ''
        const projectPath = (await findGitRoot(cwd, rootCache)) || cwd
        const lastActivityAt = Math.max(stat.mtimeMs, timestamp(indexed?.updated_at))
        threads.push({
          id: `codex-cli:${session.sessionId}`,
          title: clean(indexed?.thread_name) || session.prompt || 'Untitled thread',
          preview: session.prompt,
          project: projectPath ? path.basename(projectPath) : '',
          projectPath,
          worktree: '',
          cwd,
          gitBranch: session.gitBranch,
          model: session.model,
          effort: session.effort,
          createdAt: session.createdAt || stat.birthtimeMs || stat.ctimeMs,
          lastActivityAt,
          lastFocusedAt: 0,
          running: session.lifecycle === 'running' && now() - lastActivityAt <= activeWindowMs,
          unread: false,
          hasError: session.lifecycle === 'aborted',
          starred: false,
          routine: '',
          prState: '',
          archived: false,
          sizeBytes: stat.size,
          source: session.originator.startsWith('codex_vscode') ? 'vscode' : session.sessionSource || 'cli',
          canOpen: SESSION_ID_RE.test(session.sessionId) && session.originator.startsWith('codex_vscode'),
          canArchive: false,
          ref: { sessionId: session.sessionId, cwd, originator: session.originator },
        })
      } catch {
        // Partially written or malformed transcripts must not break a scan.
      }
    }
    return threads
  }

  return {
    id: 'codex-cli',
    name: 'Codex',
    detect: async () => await exists(sessionsDir),
    scanThreads,
    openThread: (ref) => {
      if (!SESSION_ID_RE.test(ref?.sessionId || '')) {
        return { ok: false, error: 'This Codex session does not have a valid thread ID.' }
      }
      if (!String(ref?.originator || '').startsWith('codex_vscode')) {
        return { ok: false, error: 'No verified opener is available for this Codex session origin.' }
      }
      return {
        ok: true,
        url: `openai-codex://route/local/${ref.sessionId}`,
        cwd: ref.cwd && path.isAbsolute(ref.cwd) ? ref.cwd : '',
      }
    },
    newSession: () => ({ ok: false, error: 'Codex has no verified desktop deep link. Start it in a terminal from the project folder.' }),
    setArchived: async () => ({ ok: false, error: 'Codex does not expose a native session archive operation.' }),
  }
}

export default createCodexHarness()

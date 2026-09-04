/**
 * Harness adapter: Codex (OpenAI) — the desktop app and CLI share one local session store.
 *
 * Codex writes append-only JSONL transcripts under ~/.codex/sessions. The first records hold
 * stable session metadata and the tail holds the current turn state, so neither side requires
 * reading a whole transcript on every poll. User-facing names and unread state are best-effort
 * additions from the two small files the desktop app maintains alongside those transcripts.
 */
import fsp from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { exists, jsonLines, readHead } from '../lib/fsutil.mjs'

const execFileAsync = promisify(execFile)
const HOME = os.homedir()
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex')
const SESSIONS = path.join(CODEX_HOME, 'sessions')
const SESSION_INDEX = path.join(CODEX_HOME, 'session_index.jsonl')
const APP_STATE = path.join(CODEX_HOME, '.codex-global-state.json')
const DESKTOP_APPS = [
  '/Applications/ChatGPT.app',
  '/Applications/Codex.app',
  path.join(HOME, 'Applications', 'ChatGPT.app'),
  path.join(HOME, 'Applications', 'Codex.app'),
]

const HEAD_BYTES = 192 * 1024
const TAIL_BYTES = 512 * 1024
const MAX_ACTIVE_TAIL_BYTES = 2 * 1024 * 1024
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function firstText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') return part
      if (part && typeof part.text === 'string' && ['text', 'input_text'].includes(part.type)) {
        return part.text
      }
    }
  }
  return ''
}

/** Drop UI context injected ahead of the prompt; it is not the title a person gave the task. */
function cleanPrompt(value) {
  const text = String(value || '')
    .replace(/<(in-app-browser-context|environment_context)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  const request = text.lastIndexOf('## My request:')
  return (request === -1 ? text : text.slice(request + '## My request:'.length))
    .replace(/\s+/g, ' ')
    .trim()
}

function shortTitle(prompt) {
  if (prompt.length <= 120) return prompt
  const cut = prompt.slice(0, 117)
  const boundary = cut.lastIndexOf(' ')
  return (boundary > 72 ? cut.slice(0, boundary) : cut).trimEnd() + '…'
}

function readTranscriptMeta(records) {
  const out = { id: '', cwd: '', source: '', startedAt: 0, firstPrompt: '', gitBranch: '' }
  for (const record of records) {
    const payload = record?.payload || {}
    if (record.type === 'session_meta' && !out.id) {
      out.id = typeof payload.id === 'string' ? payload.id : ''
      out.cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
      out.source = typeof payload.source === 'string' ? payload.source : ''
      out.startedAt = Date.parse(payload.timestamp || record.timestamp || '') || 0
      out.gitBranch = typeof payload.git?.branch === 'string' ? payload.git.branch : ''
    }
    if (out.firstPrompt) continue
    if (record.type === 'event_msg' && payload.type === 'user_message') {
      out.firstPrompt = cleanPrompt(payload.message)
    } else if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      out.firstPrompt = cleanPrompt(firstText(payload.content))
    }
  }
  return out
}

function readTailMeta(records) {
  const out = { model: '', effort: '', lifecycle: null }
  for (const record of records) {
    const payload = record?.payload || {}
    if (record.type === 'turn_context') {
      if (typeof payload.model === 'string') out.model = payload.model
      if (typeof payload.effort === 'string') out.effort = payload.effort
    }
    if (
      record.type === 'event_msg' &&
      ['task_started', 'task_complete', 'turn_aborted'].includes(payload.type)
    ) {
      out.lifecycle = { type: payload.type, error: Boolean(payload.error) }
    }
  }
  return out
}

async function listTranscripts(root) {
  const files = []
  const pending = [root]
  while (pending.length) {
    const dir = pending.pop()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) pending.push(file)
      // session-map tools can project another machine's transcript into this picker. Those
      // imported-*.jsonl files duplicate the real session and must not become two astronauts.
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('imported-')) {
        files.push(file)
      }
    }
  }
  return files
}

async function transcriptEntries() {
  const entries = []
  for (const file of await listTranscripts(SESSIONS)) {
    try {
      const stat = await fsp.stat(file)
      entries.push({ file, size: stat.size, mtime: stat.mtimeMs })
    } catch {
      /* archived between readdir and stat — it will be gone on the next pass */
    }
  }
  return entries
}

async function readTail(file, size, bytes) {
  const length = Math.min(size, bytes)
  const start = Math.max(0, size - length)
  const handle = await fsp.open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    let text = buffer.subarray(0, bytesRead).toString('utf8')
    if (start) text = text.slice(text.indexOf('\n') + 1)
    // A live task may be halfway through its final JSON record.
    if (!text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1)
    return text
  } finally {
    await handle.close()
  }
}

/** The immutable head is cached forever; Codex only appends to a rollout while it is active. */
const headCache = new Map()
async function transcriptMeta(entry) {
  const cached = headCache.get(entry.file)
  if (cached) return cached
  let meta
  try {
    meta = readTranscriptMeta(jsonLines(await readHead(entry.file, HEAD_BYTES)))
  } catch {
    meta = readTranscriptMeta([])
  }
  // A brand-new rollout can be observed before its first record is complete. Do not make that
  // empty read permanent; the next poll should get another chance.
  if (meta.id) headCache.set(entry.file, meta)
  return meta
}

/** The tail changes during a turn, so cache it only until the file mtime or size moves. */
const tailCache = new Map()
async function transcriptTail(entry) {
  const cached = tailCache.get(entry.file)
  if (cached && cached.mtime === entry.mtime && cached.size === entry.size) return cached.meta

  let meta = readTailMeta(jsonLines(await readTail(entry.file, entry.size, TAIL_BYTES)))
  // A very chatty active turn can push task_started out of the first tail window. Widen only
  // for a recently changing file, and only when an earlier pass cannot supply the lifecycle.
  if (!meta.lifecycle && !cached?.meta.lifecycle && Date.now() - entry.mtime < ACTIVE_WINDOW_MS) {
    meta = readTailMeta(jsonLines(await readTail(entry.file, entry.size, MAX_ACTIVE_TAIL_BYTES)))
  }
  if (!meta.model && cached?.meta.model) meta.model = cached.meta.model
  if (!meta.effort && cached?.meta.effort) meta.effort = cached.meta.effort
  if (!meta.lifecycle && cached?.meta.lifecycle) meta.lifecycle = cached.meta.lifecycle
  tailCache.set(entry.file, { mtime: entry.mtime, size: entry.size, meta })
  return meta
}

async function threadNames() {
  const names = new Map()
  let records
  try {
    records = jsonLines(await fsp.readFile(SESSION_INDEX, 'utf8'))
  } catch {
    return names
  }
  for (const record of records) {
    if (UUID.test(record.id || '') && typeof record.thread_name === 'string' && record.thread_name.trim()) {
      names.set(record.id, record.thread_name.trim())
    }
  }
  return names
}

/** The desktop app owns unread state. CLI-only installs simply report no unread sessions. */
async function unreadThreadIds() {
  try {
    const state = JSON.parse(await fsp.readFile(APP_STATE, 'utf8'))
    const ids = state?.['electron-persisted-atom-state']?.['unread-thread-ids-by-host-v1']?.local
    return new Set(Array.isArray(ids) ? ids.filter((id) => UUID.test(id)) : [])
  } catch {
    return new Set()
  }
}

/** Map a Git worktree back to the repo whose zone it belongs on, without spawning git per task. */
async function projectOf(cwd) {
  let projectPath = cwd || ''
  let worktree = ''
  if (cwd) {
    try {
      const dotGit = path.join(cwd, '.git')
      if ((await fsp.stat(dotGit)).isFile()) {
        const match = (await fsp.readFile(dotGit, 'utf8')).match(/^gitdir:\s*(.+)$/m)
        if (match) {
          const gitDir = path.resolve(cwd, match[1])
          const marker = path.sep + '.git' + path.sep + 'worktrees' + path.sep
          const index = gitDir.indexOf(marker)
          if (index !== -1) {
            projectPath = gitDir.slice(0, index)
            worktree = path.basename(cwd)
          }
        }
      }
    } catch {
      /* not a Git worktree, or the folder has since moved */
    }
  }
  return { projectPath, project: path.basename(projectPath) || projectPath || 'unknown', worktree }
}

let codexBinaryPromise
async function codexBinary() {
  if (codexBinaryPromise) return codexBinaryPromise
  codexBinaryPromise = (async () => {
    const candidates = [
      'codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
    ]
    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['--version'], { timeout: 5000 })
        return candidate
      } catch {
        /* try the next documented or bundled location */
      }
    }
    return ''
  })()
  return codexBinaryPromise
}

async function scanThreads() {
  const [entries, names, unread, binary] = await Promise.all([
    transcriptEntries(),
    threadNames(),
    unreadThreadIds(),
    codexBinary(),
  ])
  const byId = new Map()
  const canOpen = DESKTOP_APPS.some((app) => existsSync(app))
  for (const entry of entries) {
    const meta = await transcriptMeta(entry)
    // Codex stores spawned subagents beside user-facing tasks. Its own thread/list defaults to
    // these two interactive sources, and the colony should make the same distinction.
    if (!UUID.test(meta.id) || !['cli', 'vscode'].includes(meta.source)) continue

    const tail = await transcriptTail(entry)
    const lifecycle = tail.lifecycle
    const { projectPath, project, worktree } = await projectOf(meta.cwd)
    const firstPrompt = meta.firstPrompt || ''
    const thread = {
      id: meta.id,
      title: names.get(meta.id) || shortTitle(firstPrompt) || 'Untitled thread',
      preview: firstPrompt.slice(0, 240),
      project,
      projectPath,
      worktree,
      cwd: meta.cwd,
      gitBranch: meta.gitBranch,
      model: tail.model,
      effort: tail.effort,
      createdAt: meta.startedAt || entry.mtime,
      lastActivityAt: entry.mtime,
      lastFocusedAt: 0,
      running:
        lifecycle?.type === 'task_started' && Date.now() - entry.mtime < ACTIVE_WINDOW_MS,
      unread: unread.has(meta.id),
      hasError: lifecycle?.type === 'task_complete' && lifecycle.error,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes: entry.size,
      source: meta.source === 'vscode' ? 'desktop' : 'cli',
      canOpen,
      canArchive: Boolean(binary),
      ref: { sessionId: meta.id },
    }
    const existing = byId.get(thread.id)
    if (!existing || thread.lastActivityAt > existing.lastActivityAt) byId.set(thread.id, thread)
  }
  return [...byId.values()]
}

function openThread(ref) {
  const id = ref?.sessionId || ''
  if (!UUID.test(id)) return { ok: false, error: 'No openable Codex session id on that thread' }
  return { ok: true, url: 'codex://threads/' + id }
}

function newSession(dir) {
  return { ok: true, url: 'codex://threads/new?' + new URLSearchParams({ path: dir }) }
}

async function setArchived(ref, archived) {
  const id = ref?.sessionId || ''
  if (!UUID.test(id)) return { ok: false, error: 'No archivable Codex session id on that thread' }
  const binary = await codexBinary()
  if (!binary) return { ok: false, error: 'The Codex CLI is not available on this machine' }
  try {
    await execFileAsync(binary, [archived ? 'archive' : 'unarchive', id], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    })
    return { ok: true, archived: Boolean(archived) }
  } catch (error) {
    const detail = String(error?.stderr || error?.message || '').trim().split('\n').pop()
    return { ok: false, error: detail || 'Codex could not update that session' }
  }
}

export default {
  id: 'codex',
  name: 'Codex',
  detect: async () => await exists(SESSIONS),
  scanThreads,
  openThread,
  newSession,
  setArchived,
  paths: { SESSIONS, SESSION_INDEX, APP_STATE },
}

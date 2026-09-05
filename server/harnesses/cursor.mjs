/**
 * Harness adapter: Cursor (the IDE, and cursor-agent).
 *
 * Cursor does not publish a session API. Two local stores, merged:
 *   - composerHeaders in Cursor's global state.vscdb — title, workspace, unread,
 *     whether a run is still going, archive flag. This is what the sidebar itself
 *     reads, so it is the source of truth when sqlite3 can open it.
 *   - ~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl — the
 *     transcript the IDE writes alongside. Size is how finished a building looks,
 *     and this fills in chats the composer index missed.
 *
 * Subagents (Task / explore / Bugbot children) are skipped: they are not threads
 * the user started, and including them would drown the colony in helpers.
 *
 * Cursor has no public per-chat deep link analogous to Claude's epitaxy URL.
 * The command that takes a composer id is `composer.focusComposer`, but
 * `command:` URIs are swallowed from the CLI, and sending a keystroke needs
 * macOS Accessibility which a viewer app should not ask for. Open therefore
 * installs a tiny UI extension through Cursor's CLI. The helper watches
 * `~/.cursor/bot-crossing-open.json`, runs that command, and acknowledges the
 * request. New session still uses the documented prompt deeplink.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { exists, jsonLines, listDirs, readHead } from '../lib/fsutil.mjs'

const execFileAsync = promisify(execFile)
const HOME = os.homedir()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
const HEAD_BYTES = 64 * 1024
const ID_PREFIX = 'cursor:'

const PROJECTS = path.join(HOME, '.cursor', 'projects')

/**
 * Cursor's VS Code–style user data. The composer index lives in globalStorage.
 * Layout is the same as VS Code's, just under Cursor's own app name.
 */
function userDataDir() {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Cursor')
    case 'linux':
      return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Cursor')
    default:
      return path.join(HOME, 'Library', 'Application Support', 'Cursor')
  }
}

const STATE_DB = path.join(userDataDir(), 'User', 'globalStorage', 'state.vscdb')

/** `/Users/greg/nph` → `Users-greg-nph`, which is how ~/.cursor/projects is keyed. */
function projectSlug(absPath) {
  return String(absPath || '')
    .replace(/^[\\/]+/, '')
    .replace(/[:\\/]+/g, '-')
}

/**
 * Best-effort reverse of the slug. Ambiguous whenever a path segment itself
 * contained a dash — same compromise the Claude adapter makes for encoded cwds.
 */
function decodeProjectSlug(name) {
  if (/^[0-9]+$/.test(name)) return ''
  const drive = /^([A-Za-z])-(.*)$/.exec(name)
  if (drive) return `${drive[1]}:\\${drive[2].replace(/-/g, '\\')}`
  return name ? '/' + name.replace(/-/g, '/') : ''
}

const WORKTREE = /[\\/](?:\.cursor[\\/]worktrees|\.wt)[\\/]([^\\/]+)/
function splitWorktree(cwd) {
  const m = WORKTREE.exec(cwd || '')
  if (!m) return { root: cwd || '', worktree: '' }
  return { root: cwd.slice(0, m.index), worktree: m[1] }
}

function workspacePathOf(header) {
  const uri = header?.workspaceIdentifier?.uri
  const p = uri?.fsPath || uri?.path || ''
  return typeof p === 'string' && p ? p : ''
}

function activeRepoOf(header) {
  let best = null
  for (const repo of Array.isArray(header?.trackedGitRepos) ? header.trackedGitRepos : []) {
    if (typeof repo?.repoPath !== 'string' || !path.isAbsolute(repo.repoPath)) continue
    const branches = Array.isArray(repo.branches) ? repo.branches : []
    const branch = branches.reduce((a, b) => (
      !a || Number(b?.lastInteractionAt) > Number(a?.lastInteractionAt) ? b : a
    ), null)
    const at = Number(branch?.lastInteractionAt) || 0
    if (!best || at > best.at) best = { path: repo.repoPath, branch: branch?.branchName || '', at }
  }
  return best
}

/**
 * Read composerHeaders with Node's built-in SQLite binding. It is portable,
 * opens the 36GB live store read-only, and avoids requiring sqlite3.exe on
 * Windows. WAL readers may run while Cursor writes.
 */
let lastHeaderRows = null
async function queryComposerHeaders() {
  if (!(await exists(STATE_DB))) return null
  let db
  try {
    db = new DatabaseSync(STATE_DB, { readOnly: true, timeout: 2000 })
    // Subagent rows are only ever needed as ids to skip, and their blobs are well over
    // half the bytes this query would otherwise pull out of a 36GB store on every poll.
    const rows = db.prepare(`
      SELECT composerId, isSubagent, createdAt, lastUpdatedAt, isArchived, recency,
             CASE WHEN isSubagent THEN NULL ELSE value END AS value
        FROM composerHeaders
    `).all()
    lastHeaderRows = rows
    return rows
  } catch {
    return lastHeaderRows
  } finally {
    try {
      db?.close()
    } catch {
      /* failed open */
    }
  }
}

function parseHeaderRow(row) {
  let header = {}
  try {
    header = typeof row.value === 'string' ? JSON.parse(row.value) : row.value || {}
  } catch {
    header = {}
  }
  if (!header || typeof header !== 'object') header = {}
  const composerId = row.composerId || header.composerId || ''
  if (!UUID.test(composerId)) return null
  if (header.isDraft === true || header.isSubagent === true || row.isSubagent === 1) return null

  const createdAt = Number(header.createdAt || row.createdAt) || 0
  const lastActivityAt = Math.max(
    Number(header.lastUpdatedAt) || 0,
    Number(header.conversationCheckpointLastUpdatedAt) || 0,
    Number(row.lastUpdatedAt) || 0,
    Number(row.recency) || 0,
    createdAt,
  )
  const unfinishedAt = Number(header.unfinishedRunAt) || 0
  const cwd = workspacePathOf(header)
  const activeRepo = activeRepoOf(header)
  const location = activeRepo?.path || cwd
  const { root, worktree } = splitWorktree(location)
  const projectPath = root || location
  const project = path.basename(projectPath) || projectPath || 'cursor'
  const archived = row.isArchived === 1 || row.isArchived === true || header.isArchived === true
  const mode = header.unifiedMode || header.forceMode || ''
  const now = Date.now()

  return {
    composerId,
    title: header.name || header.subtitle || '',
    preview: header.subtitle || '',
    project,
    projectPath,
    worktree,
    cwd,
    gitBranch: activeRepo?.branch || '',
    model: mode,
    createdAt,
    lastActivityAt,
    archived,
    unread: header.hasUnreadMessages === true || header.hasBlockingPendingActions === true,
    running: Boolean(unfinishedAt) && now - lastActivityAt < ACTIVE_WINDOW_MS,
    hasError: false,
  }
}

function transcriptFile(slug, composerId) {
  return path.join(PROJECTS, slug, 'agent-transcripts', composerId, `${composerId}.jsonl`)
}

const sizeCache = new Map()
const CACHE_LIMIT = 2048
function cacheSet(cache, key, value) {
  if (!cache.has(key) && cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
  cache.set(key, value)
}

async function transcriptSize(workspacePath, composerId) {
  const slug = projectSlug(workspacePath)
  if (!slug || !UUID.test(composerId)) return 0
  const file = transcriptFile(slug, composerId)
  const cached = sizeCache.get(file)
  try {
    const stat = await fsp.stat(file)
    if (cached && cached.mtime === stat.mtimeMs) return cached.size
    cacheSet(sizeCache, file, { mtime: stat.mtimeMs, size: stat.size })
    return stat.size
  } catch {
    return 0
  }
}

/** First user prompt, used only when composerHeaders had no title. */
const metaCache = new Map()
async function transcriptMeta(file, mtime) {
  const cached = metaCache.get(file)
  if (cached && cached.mtime === mtime) return cached.meta
  let meta = { title: '', preview: '' }
  try {
    for (const rec of jsonLines(await readHead(file, HEAD_BYTES))) {
      if (rec.role !== 'user' || !rec.message) continue
      const parts = rec.message.content
      const text = Array.isArray(parts)
        ? parts.map((p) => (p && p.type === 'text' ? p.text : '')).join('\n')
        : typeof parts === 'string'
          ? parts
          : ''
      const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
      const cleaned = (query ? query[1] : text).replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '').trim()
      if (!cleaned) continue
      meta = { title: cleaned.split('\n')[0].slice(0, 80), preview: cleaned.slice(0, 240) }
      break
    }
  } catch {
    /* mid-write */
  }
  cacheSet(metaCache, file, { mtime, meta })
  return meta
}

function toThread(t) {
  const { composerId, ...rest } = t
  return {
    ...rest,
    id: ID_PREFIX + composerId,
    title: rest.title || 'Untitled thread',
    canOpen: true,
    canArchive: rest.source === 'composer',
    hasTranscript: rest.sizeBytes > 0,
    source: rest.source || 'composer',
    lastFocusedAt: 0,
    effort: '',
    starred: false,
    routine: '',
    prState: '',
    ref: {
      composerId,
      projectPath: rest.projectPath || '',
      workspacePath: rest.cwd || rest.projectPath || '',
    },
  }
}

/**
 * Walk ~/.cursor/projects for parent transcripts. Used as the whole scan when
 * sqlite3 cannot open the DB, and as a fill-in for chats the index missed.
 */
async function scanTranscripts(skipIds = new Set()) {
  const out = []
  for (const projectDir of await listDirs(PROJECTS)) {
    const slug = path.basename(projectDir)
    const decoded = decodeProjectSlug(slug)
    const transcripts = path.join(projectDir, 'agent-transcripts')
    if (!(await exists(transcripts))) continue
    for (const dir of await listDirs(transcripts)) {
      const id = path.basename(dir)
      if (!UUID.test(id) || skipIds.has(id)) continue
      const file = path.join(dir, `${id}.jsonl`)
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      const meta = await transcriptMeta(file, stat.mtimeMs)
      const { root, worktree } = splitWorktree(decoded)
      const projectPath = root || decoded
      out.push({
        composerId: id,
        title: meta.title,
        preview: meta.preview,
        project: path.basename(projectPath) || projectPath || slug,
        projectPath,
        worktree,
        cwd: decoded,
        gitBranch: '',
        model: '',
        createdAt: stat.birthtimeMs || stat.mtimeMs,
        lastActivityAt: stat.mtimeMs,
        archived: false,
        unread: false,
        running: Date.now() - stat.mtimeMs < ACTIVE_WINDOW_MS,
        hasError: false,
        sizeBytes: stat.size,
        source: 'transcript',
      })
    }
  }
  return out
}

async function scanThreads() {
  const byId = new Map()
  const add = (thread) => {
    const existing = byId.get(thread.composerId)
    if (!existing) {
      byId.set(thread.composerId, thread)
      return
    }
    // Headers win on title/unread/running; transcripts win on size if the header had none.
    byId.set(thread.composerId, {
      ...thread,
      ...existing,
      title: existing.title || thread.title,
      preview: existing.preview || thread.preview,
      projectPath: existing.projectPath || thread.projectPath,
      project: existing.projectPath ? existing.project : thread.project,
      sizeBytes: existing.sizeBytes || thread.sizeBytes,
      source: existing.source === 'composer' ? 'composer' : thread.source,
    })
  }

  const rows = await queryComposerHeaders()
  if (rows) {
    for (const row of rows) {
      const parsed = parseHeaderRow(row)
      if (!parsed) continue
      parsed.sizeBytes = await transcriptSize(parsed.cwd, parsed.composerId)
      parsed.source = 'composer'
      add(parsed)
    }
  }

  // Without headers there is no reliable way to distinguish parent transcripts
  // from subagents. Return no Cursor threads rather than flooding the colony.
  if (!rows) return []

  const skip = new Set(byId.keys())
  for (const row of rows) {
    const id = row.composerId
    if (!UUID.test(id || '')) continue
    if (row.isSubagent === 1 || row.isSubagent === true) {
      skip.add(id)
      continue
    }
    // Older rows carry the flag only inside the blob.
    try {
      const value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value || {}
      if (value?.isSubagent === true) skip.add(id)
    } catch {
      /* malformed row */
    }
  }
  for (const t of await scanTranscripts(skip)) add(t)

  return [...byId.values()].map(toThread)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const OPEN_REQUEST = path.join(HOME, '.cursor', 'bot-crossing-open.json')
const OPEN_ACK = path.join(HOME, '.cursor', 'bot-crossing-open-ack.json')
const EXT_PUBLISHER = 'bot-crossing'
const EXT_NAME = 'cursor-open'
const EXT_VERSION = '0.0.3'
const EXT_ID = `${EXT_PUBLISHER}.${EXT_NAME}`
const EXT_DIRNAME = `${EXT_ID}-${EXT_VERSION}`

const EXT_PACKAGE = `{
  "name": "${EXT_NAME}",
  "displayName": "Bot Crossing Open",
  "description": "Lets Bot Crossing focus a specific Cursor agent thread.",
  "version": "${EXT_VERSION}",
  "publisher": "${EXT_PUBLISHER}",
  "engines": { "vscode": "^1.80.0" },
  "categories": ["Other"],
  "activationEvents": ["*"],
  "main": "./extension.js",
  "extensionKind": ["ui"]
}
`

// Watches ~/.cursor/bot-crossing-open.json and runs composer.focusComposer.
// Kept as a string so the adapter stays one file; we materialize it on Open.
const EXT_MAIN = `const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const os = require('os')
const FILE = path.join(os.homedir(), '.cursor', 'bot-crossing-open.json')
const ACK = path.join(os.homedir(), '.cursor', 'bot-crossing-open-ack.json')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A request is only ever meant for the window that is open when it lands. Anything
// older is a leftover from a click nobody is waiting on any more, and honouring it
// would steal focus in an unrelated window minutes or days later.
const MAX_AGE_MS = 30000
function writeAck(value) {
  const tmp = ACK + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value) + '\\n', { mode: 0o600 })
  fs.renameSync(tmp, ACK)
}
function activate(context) {
  let lastRequestId = ''
  const tryFocus = async () => {
    let req
    try { req = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return }
    if (!req || !UUID.test(req.composerId || '') || typeof req.requestId !== 'string'
        || req.requestId === lastRequestId) return
    if (!Number(req.at) || Date.now() - Number(req.at) > MAX_AGE_MS) return
    if (req.workspacePath) {
      const normalize = value => {
        const resolved = path.resolve(String(value))
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved
      }
      const wanted = normalize(req.workspacePath)
      const folders = vscode.workspace.workspaceFolders || []
      if (!folders.some(folder => normalize(folder.uri.fsPath) === wanted)) return
    }
    lastRequestId = req.requestId
    // Consume it here, not just in the server: whichever window handles the request
    // is the one that knows it is spent, and a window that never got the ack back
    // (server gone, machine slept) must not find it again on the next activation.
    try { fs.unlinkSync(FILE) } catch {}
    try {
      await vscode.commands.executeCommand('composer.focusComposer', req.composerId)
      writeAck({ requestId: req.requestId, composerId: req.composerId, ok: true })
    } catch (err) {
      writeAck({ requestId: req.requestId, composerId: req.composerId, ok: false,
        error: err instanceof Error ? err.message : String(err) })
    }
  }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    const watcher = fs.watch(path.dirname(FILE), { persistent: false }, (_e, name) => {
      if (name === 'bot-crossing-open.json') tryFocus()
    })
    context.subscriptions.push({ dispose: () => watcher.close() })
  } catch {}
  // fs.watch above is the fast path on every platform we support; this is only a
  // safety net for the cases where it drops events, so it can afford to be slow.
  const interval = setInterval(tryFocus, 2000)
  context.subscriptions.push({ dispose: () => clearInterval(interval) })
  tryFocus()
}
function deactivate() {}
module.exports = { activate, deactivate }
`

const VSIX_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${EXT_NAME}" Version="${EXT_VERSION}" Publisher="${EXT_PUBLISHER}" />
    <DisplayName>Bot Crossing Open</DisplayName>
    <Description xml:space="preserve">Lets Bot Crossing focus a specific Cursor agent thread.</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`

const VSIX_CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="xml" ContentType="text/xml" />
</Types>
`

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zipStore(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const [name, contents] of entries) {
    const nameBytes = Buffer.from(name)
    const data = Buffer.from(contents)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    localParts.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const central = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, central, end])
}

function runCursor(bin, args, options = {}) {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(bin)) {
    return execFileAsync(bin, args, options)
  }
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`
  const command = [bin, ...args].map(quote).join(' ')
  return execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], options)
}

let installedVersion = ''
async function installOpenExtension(bin) {
  if (installedVersion === EXT_VERSION) return false
  try {
    const { stdout } = await runCursor(bin, ['--list-extensions', '--show-versions'], { timeout: 15000 })
    if (stdout.split(/\r?\n/).includes(`${EXT_ID}@${EXT_VERSION}`)) {
      installedVersion = EXT_VERSION
      return false
    }
  } catch {
    /* install below gives the useful error */
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-vsix-'))
  const vsix = path.join(tmp, `${EXT_DIRNAME}.vsix`)
  try {
    const archive = zipStore([
      ['extension.vsixmanifest', VSIX_MANIFEST],
      ['[Content_Types].xml', VSIX_CONTENT_TYPES],
      ['extension/package.json', EXT_PACKAGE],
      ['extension/extension.js', EXT_MAIN],
    ])
    await fsp.writeFile(vsix, archive, { mode: 0o600 })
    await runCursor(bin, ['--install-extension', vsix, '--force'], { timeout: 30000 })
    installedVersion = EXT_VERSION
    return true
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

async function writeOpenRequest(composerId, workspacePath) {
  const requestId = randomUUID()
  const payload = JSON.stringify({
    requestId,
    composerId,
    workspacePath: workspacePath || '',
    at: Date.now(),
  }) + '\n'
  await fsp.mkdir(path.dirname(OPEN_REQUEST), { recursive: true })
  const tmp = `${OPEN_REQUEST}.${process.pid}.${requestId}.tmp`
  await fsp.writeFile(tmp, payload, { mode: 0o600 })
  await fsp.rename(tmp, OPEN_REQUEST)
  return requestId
}

async function waitForOpenAck(requestId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const ack = JSON.parse(await fsp.readFile(OPEN_ACK, 'utf8'))
      if (ack?.requestId === requestId) return ack
    } catch {
      /* helper has not acknowledged yet */
    }
    await sleep(60)
  }
  return null
}

function cursorBinaries() {
  const out = []
  if (process.env.CURSOR_CLI) out.push(process.env.CURSOR_CLI)
  if (process.platform === 'darwin') {
    out.push('/Applications/Cursor.app/Contents/Resources/app/bin/cursor')
    out.push(path.join(HOME, 'Applications/Cursor.app/Contents/Resources/app/bin/cursor'))
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')
    out.push(path.join(local, 'Programs', 'cursor', 'Cursor.exe'))
    out.push(path.join(local, 'Programs', 'Cursor', 'Cursor.exe'))
    out.push(path.join(local, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'))
    out.push(path.join(local, 'Programs', 'Cursor', 'resources', 'app', 'bin', 'cursor.cmd'))
  } else {
    out.push(path.join(HOME, '.local', 'bin', 'cursor'))
    out.push(path.join(HOME, '.cursor', 'bin', 'cursor'))
    out.push('/usr/local/bin/cursor')
    out.push('/usr/share/cursor/resources/app/bin/cursor')
    out.push('/usr/lib/cursor/bin/cursor')
  }
  return out
}

let cursorBinCache = { checked: false, path: '' }
async function findCursorBin() {
  if (cursorBinCache.path) return cursorBinCache.path
  for (const candidate of cursorBinaries()) {
    if (candidate && (await exists(candidate))) {
      cursorBinCache = { checked: true, path: candidate }
      return candidate
    }
  }
  try {
    const command = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileAsync(command, ['cursor'], { timeout: 3000 })
    const candidate = stdout.split(/\r?\n/).find(Boolean) || ''
    if (candidate) {
      cursorBinCache = { checked: true, path: candidate }
      return candidate
    }
  } catch {
    /* not on PATH */
  }
  cursorBinCache = { checked: true, path: '' }
  return ''
}

async function isDirectory(p) {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Hands the thread back to Cursor. `cursor://file/…` only focuses the workspace.
 * The helper extension is installed through Cursor's CLI and acknowledges the
 * focus command. A first install may require one Cursor window reload.
 */
async function openThreadNow(ref) {
  const composerId = ref?.composerId
  if (!UUID.test(composerId || '')) return { ok: false, error: 'No openable Cursor chat id on that thread' }
  const workspacePath = typeof ref?.workspacePath === 'string' && path.isAbsolute(ref.workspacePath)
    ? ref.workspacePath
    : typeof ref?.projectPath === 'string' && path.isAbsolute(ref.projectPath) ? ref.projectPath : ''
  const bin = await findCursorBin()
  if (!bin) return { ok: false, error: 'Cursor CLI not found; install the cursor shell command and retry' }
  // Threads outlive their checkouts — deleted worktrees and /tmp dirs are common, and a
  // transcript-only thread's path is a lossy slug decode. Handing Cursor a folder that is
  // not there opens a window on nothing, so fall back to focusing by composer id alone.
  const folder = workspacePath && (await isDirectory(workspacePath)) ? workspacePath : ''
  try {
    await installOpenExtension(bin)
    if (folder) await runCursor(bin, [folder], { timeout: 15000 })
    const requestId = await writeOpenRequest(composerId, folder)
    const ack = await waitForOpenAck(requestId)
    if (ack?.ok) return { ok: true }
    if (ack) return { ok: false, error: ack.error || 'Cursor could not focus that agent thread' }
    return { ok: false, error: 'Reload the Cursor window once to activate Bot Crossing Open, then retry' }
  } catch (err) {
    return { ok: false, error: err?.message || 'Could not open that Cursor thread' }
  } finally {
    // The helper unlinks what it consumes; this covers the case where no window ever did.
    await fsp.unlink(OPEN_REQUEST).catch(() => {})
  }
}

let openQueue = Promise.resolve()
function openThread(ref) {
  const next = openQueue.then(() => openThreadNow(ref), () => openThreadNow(ref))
  openQueue = next.catch(() => {})
  return next
}

/**
 * Prefill a new agent chat, routed to a window whose folder name matches.
 * Cursor's deeplink matches on basename, not the full path — two checkouts
 * called `nph` would collide, which is the same ambiguity the colony already
 * has to disambiguate on the map.
 */
function newSession(dir) {
  const workspace = encodeURIComponent(path.basename(dir))
  return { ok: true, url: `cursor://anysphere.cursor-deeplink/prompt?text=%20&workspace=${workspace}&mode=agent` }
}

async function setArchived(ref, archived) {
  const composerId = ref?.composerId
  if (!UUID.test(composerId || '')) return { ok: false, error: 'No Cursor chat id on that thread' }
  if (!(await exists(STATE_DB))) return { ok: false, error: 'Cursor has no session database on this machine' }

  const flag = archived ? 1 : 0
  const jsonFlag = archived ? 'true' : 'false'
  let db
  try {
    db = new DatabaseSync(STATE_DB, { timeout: 5000 })
    db.exec('PRAGMA busy_timeout = 5000')
    const result = db.prepare(`
      UPDATE composerHeaders
      SET isArchived = ?,
          value = CASE WHEN json_valid(value) THEN json_set(value, '$.isArchived', json(?)) ELSE value END
      WHERE composerId = ?
    `).run(flag, jsonFlag, composerId)
    return result.changes > 0
      ? { ok: true, archived: Boolean(archived) }
      : { ok: false, error: 'No Cursor composer record for that thread' }
  } catch (err) {
    return { ok: false, error: err?.message || 'Could not update Cursor archive flag' }
  } finally {
    try {
      db?.close()
    } catch {
      /* failed open */
    }
  }
}

let appStartCache = { at: 0, checkedAt: 0 }
async function appStartedAt() {
  const now = Date.now()
  if (now - appStartCache.checkedAt < 15000) return appStartCache.at
  let started = 0
  try {
    if (process.platform === 'win32') started = await windowsAppStartedAt()
    else if (process.platform === 'darwin') started = await darwinAppStartedAt()
    else if (process.platform === 'linux') started = await linuxAppStartedAt()
  } catch {
    /* no process listing */
  }
  appStartCache = { at: started, checkedAt: now }
  return started
}

async function darwinAppStartedAt() {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,lstart=,command='], { maxBuffer: 8 * 1024 * 1024 })
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*\d+\s+(\w{3} \w{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(\/.*)$/)
    if (!m) continue
    const [, when, command] = m
    if (!command.includes('/Cursor.app/Contents/MacOS/Cursor') || command.includes('--type=')) continue
    const parsed = Date.parse(when)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

async function linuxAppStartedAt() {
  const { stdout } = await execFileAsync('ps', ['-eo', 'lstart=,args='], { maxBuffer: 8 * 1024 * 1024 })
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\w{3} \w{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/)
    if (!m) continue
    const [, when, command] = m
    if (!/(?:^|\/)cursor(?:\s|$)/i.test(command) || command.includes('--type=')) continue
    const parsed = Date.parse(when)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

async function windowsAppStartedAt() {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='Cursor.exe'\" | ForEach-Object {",
    "  if ($_.CreationDate) { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId,",
    "    $_.CreationDate.ToUniversalTime().ToString('o'), $_.CommandLine } }",
  ].join(' ')
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    maxBuffer: 8 * 1024 * 1024,
  })
  const rows = stdout
    .split(/\r?\n/)
    .map((line) => line.split('|'))
    .filter((parts) => parts.length >= 4)
    .map(([pid, ppid, when, ...command]) => ({
      pid,
      ppid,
      when: Date.parse(when),
      command: command.join('|'),
    }))
  const helperParents = new Set(rows.filter((r) => r.command.includes('--type=')).map((r) => r.ppid))
  const main = rows.find((r) => helperParents.has(r.pid) && !r.command.includes('--type='))
  return main && !Number.isNaN(main.when) ? main.when : 0
}

export default {
  id: 'cursor',
  name: 'Cursor',
  detect: async () => (await exists(PROJECTS)) || (await exists(STATE_DB)),
  scanThreads,
  openThread,
  newSession,
  setArchived,
  appStartedAt,
  paths: { PROJECTS, STATE_DB },
}

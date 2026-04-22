import './style.css'
import * as monaco from 'monaco-editor'
import { io } from 'socket.io-client'

// ── CONFIG ──────────────────────────────────────────────
// Fallback to localhost so the exact same file works locally AND on Vercel.
// On Vercel, set VITE_API_URL and VITE_SOCKET_URL as environment variables.
const API        = import.meta.env.VITE_API_URL    || 'http://localhost:3001'
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3002'
const LS_KEY     = 'execlab_history'
const MAX_HIST   = 50

const LANGS = {
  python:     { emoji: '🐍', tab: 'main.py',   lang: 'python',     code: 'print("Hello from ExecLab!")' },
  javascript: { emoji: '🟨', tab: 'main.js',   lang: 'javascript', code: 'console.log("Hello from ExecLab!")' },
  cpp: {
    emoji: '⚙️', tab: 'main.cpp', lang: 'cpp',
    code: '#include <iostream>\nusing namespace std;\nint main() {\n    cout << "Hello from ExecLab!" << endl;\n    return 0;\n}'
  },
  java: {
    emoji: '☕', tab: 'Main.java', lang: 'java',
    code: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello from ExecLab!");\n    }\n}'
  },
}

// ── STATE ───────────────────────────────────────────────
let editor       = null
let curLang      = 'python'
let isRunning    = false
let histOpen     = false
let currentJobId = null   // tracks active job for cancel

// ── DOM REFS ─────────────────────────────────────────────
const $ = id => document.getElementById(id)

const langSelect  = $('language')
const langEmoji   = $('langEmoji')
const fileTab     = $('fileTab')
const runBtn      = $('runBtn')
const runBtnIcon  = $('runBtnIcon')
const runBtnLabel = $('runBtnLabel')
const cancelBtn   = $('cancelBtn')
const stdinInput  = $('stdinInput')
const outputArea  = $('outputArea')
const termCursor  = $('termCursor')
const termSpinner = $('termSpinner')
const statusDot   = $('statusDot')
const statusText  = $('statusText')
const clearBtn    = $('clearBtn')
const exitBadge   = $('exitBadge')
const rtBadge     = $('rtBadge')
const termBody    = $('termBody')
const histSection = $('histSection')
const histBar     = $('histBar')
const histList    = $('histList')
const histCount   = $('histCount')
const modalBg     = $('modalBg')
const modalPre    = $('modalPre')
const modalTitle  = $('modalTitle')
const modalClose  = $('modalClose')

// ── SOCKET ──────────────────────────────────────────────
const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] })
socket.on('connect',    () => console.log('[socket] connected', socket.id))
socket.on('disconnect', () => console.log('[socket] disconnected'))

// ── MONACO INIT ─────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  editor = monaco.editor.create($('editor'), {
    value:    LANGS.python.code,
    language: 'python',
    theme:    'vs-dark',
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontLigatures: true,
    lineHeight: 22,
    minimap:  { enabled: false },
    automaticLayout: true,
    scrollBeyondLastLine: false,
    padding: { top: 14, bottom: 14 },
    renderLineHighlight: 'line',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    scrollbar: { verticalScrollbarSize: 5, horizontalScrollbarSize: 5 },
    suggest: { showIcons: true },
  })

  // Ctrl/Cmd + Enter → run
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
    () => { if (!isRunning) runCode() }
  )

  renderHistory()
})

// ── LANGUAGE SWITCH ─────────────────────────────────────
langSelect.addEventListener('change', () => {
  curLang = langSelect.value
  const meta = LANGS[curLang]
  langEmoji.textContent = meta.emoji
  fileTab.textContent   = meta.tab
  if (editor) {
    monaco.editor.setModelLanguage(editor.getModel(), meta.lang)
    if (!editor.getValue().trim()) editor.setValue(meta.code)
  }
})

// ── RUN ─────────────────────────────────────────────────
runBtn.addEventListener('click',    () => { if (!isRunning) runCode() })
cancelBtn.addEventListener('click', () => {
  if (isRunning && currentJobId) {
    // Tell worker via socket.io to kill the process
    socket.emit('cancel', currentJobId)
    setCancellingUI()
  }
})

async function runCode() {
  const code  = editor?.getValue() ?? ''
  const stdin = stdinInput?.value ?? ''
  if (!code.trim()) return

  isRunning = true
  setRunningUI()
  clearTerminal()
  appendSep(curLang)

  try {
    const res = await fetch(`${API}/run`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code, language: curLang, stdin })
    })

    // ── RATE LIMIT HANDLING ────────────────────────────
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}))
      const msg  = data.message || 'Too many requests. Please wait a moment.'
      appendText(`⚠  Rate limited: ${msg}`, 'stderr')
      setFailedUI('Rate limited')
      return
    }

    if (!res.ok) {
      appendText(`\nServer error: ${res.status}`, 'stderr')
      setFailedUI(`HTTP ${res.status}`)
      return
    }

    const { jobId } = await res.json()
    currentJobId = jobId

    // ── SOCKET LISTENER (fixed: socket.on + manual off) ──
    // socket.once would fire on the FIRST chunk and unregister,
    // so status:"completed" would never be seen → button stuck.
    // socket.on + manual socket.off when terminal status arrives.
    const event   = `job:${jobId}`
    let collected = ''
    const t0      = Date.now()

    const handler = (payload) => {
      // Streaming chunk
      if (payload.chunk !== undefined) {
        collected += payload.chunk
        const streamType = payload.type === 'stderr' ? 'stderr' : 'stdout'
        appendText(payload.chunk, streamType)
      }

      // ── COMPLETED (exit code 0) ──
      if (payload.status === 'completed') {
        socket.off(event, handler)
        currentJobId = null
        const runtime = payload.runtime ?? (Date.now() - t0)
        setDoneUI(runtime)
        storeHistory({
          id: jobId, language: curLang, code, stdin,
          output: collected || payload.output || '',
          runtime, createdAt: new Date().toISOString()
        })
        renderHistory()
      }

      // ── ERROR (exit code != 0, e.g. syntax error, runtime error) ──
      if (payload.status === 'error') {
        socket.off(event, handler)
        currentJobId = null
        const runtime = payload.runtime ?? (Date.now() - t0)
        setErrorUI(runtime, payload.exitCode ?? 1)
        storeHistory({
          id: jobId, language: curLang, code, stdin,
          output: collected || payload.output || '',
          runtime, createdAt: new Date().toISOString()
        })
        renderHistory()
      }

      // ── FAILED (infrastructure error: docker not found, etc.) ──
      if (payload.status === 'failed') {
        socket.off(event, handler)
        currentJobId = null
        const msg = payload.error || 'Execution failed'
        appendText('\n' + msg, 'stderr')
        setFailedUI(msg)
      }

      // ── CANCELLED (user pressed Stop) ──
      if (payload.status === 'cancelled') {
        socket.off(event, handler)
        currentJobId = null
        appendText('\n[cancelled by user]', 'stderr')
        setCancelledUI()
      }
    }

    socket.on(event, handler)

    // ── FALLBACK TIMEOUT (20s) ───────────────────────────
    // In case socket event is missed, poll the result API once.
    setTimeout(async () => {
      if (!isRunning) return   // already resolved
      socket.off(event, handler)
      currentJobId = null

      try {
        const r    = await fetch(`${API}/result/${jobId}`)
        const data = await r.json()

        if (data.status === 'completed') {
          if (data.output) appendText(data.output, 'stdout')
          setDoneUI(data.runtime || 0)
          storeHistory({ id: jobId, language: curLang, code, stdin, output: data.output || '', runtime: data.runtime || 0, createdAt: new Date().toISOString() })
          renderHistory()
          return
        }
        if (data.status === 'failed') {
          appendText('\n' + (data.error || 'failed'), 'stderr')
          setFailedUI(data.error || 'failed')
          return
        }
      } catch (_) {}

      appendText('\n[execution timed out — no response after 20s]', 'stderr')
      setFailedUI('Timeout')
    }, 20000)

  } catch (err) {
    appendText('\nCould not reach server. Is the backend running?', 'stderr')
    setFailedUI('Network error')
  }
}

// ── TERMINAL HELPERS ────────────────────────────────────
function clearTerminal() {
  outputArea.innerHTML  = ''
  exitBadge.className   = 'badge hidden'
  rtBadge.className     = 'badge hidden'
  exitBadge.textContent = ''
  rtBadge.textContent   = ''
}

function appendSep(lang) {
  const el = document.createElement('div')
  el.className   = 'run-sep'
  el.textContent = `${lang}  ${new Date().toLocaleTimeString()}`
  outputArea.appendChild(el)
}

function appendText(text, type = 'stdout') {
  const parts = text.split('\n')
  parts.forEach((part, i) => {
    if (i > 0) outputArea.appendChild(document.createElement('br'))
    if (part !== '') {
      const el = document.createElement('span')
      el.className   = `out-line ${type}`
      el.textContent = part
      outputArea.appendChild(el)
    }
  })
  termBody.scrollTop = termBody.scrollHeight
}

// ── UI STATE MACHINE ────────────────────────────────────
function setRunningUI() {
  runBtn.disabled        = true
  runBtnIcon.textContent  = '◉'
  runBtnLabel.textContent = 'Running'
  cancelBtn.classList.remove('hidden')
  cancelBtn.disabled     = false

  statusDot.className    = 'status-dot running'
  statusText.textContent  = 'running'

  termCursor.classList.add('hidden')
  termSpinner.classList.remove('hidden')
}

function setCancellingUI() {
  cancelBtn.disabled      = true
  runBtnLabel.textContent = 'Stopping…'
  statusText.textContent  = 'stopping'
}

function setDoneUI(runtime) {
  isRunning = false
  runBtn.disabled        = false
  runBtnIcon.textContent  = '▶'
  runBtnLabel.textContent = 'Run'
  cancelBtn.classList.add('hidden')

  statusDot.className    = 'status-dot done'
  statusText.textContent  = 'done'

  termCursor.classList.remove('hidden')
  termSpinner.classList.add('hidden')

  exitBadge.className   = 'badge exit-ok'
  exitBadge.textContent = '✓ exit 0'
  rtBadge.className     = 'badge rt'
  rtBadge.textContent   = `⏱ ${runtime}ms`

  setTimeout(() => {
    if (!isRunning) {
      statusDot.className    = 'status-dot idle'
      statusText.textContent  = 'idle'
    }
  }, 3000)
}

// Non-zero exit code (syntax error, runtime error) — red badges
function setErrorUI(runtime, exitCode) {
  isRunning = false
  runBtn.disabled        = false
  runBtnIcon.textContent  = '▶'
  runBtnLabel.textContent = 'Run'
  cancelBtn.classList.add('hidden')

  statusDot.className    = 'status-dot failed'
  statusText.textContent  = 'error'

  termCursor.classList.remove('hidden')
  termSpinner.classList.add('hidden')

  exitBadge.className   = 'badge exit-err'
  exitBadge.textContent = `✗ exit ${exitCode}`
  rtBadge.className     = 'badge rt'
  rtBadge.textContent   = `⏱ ${runtime}ms`

  setTimeout(() => {
    if (!isRunning) {
      statusDot.className    = 'status-dot idle'
      statusText.textContent  = 'idle'
    }
  }, 3000)
}

function setFailedUI(msg) {
  isRunning = false
  runBtn.disabled        = false
  runBtnIcon.textContent  = '▶'
  runBtnLabel.textContent = 'Run'
  cancelBtn.classList.add('hidden')

  statusDot.className    = 'status-dot failed'
  statusText.textContent  = 'failed'

  termCursor.classList.remove('hidden')
  termSpinner.classList.add('hidden')

  exitBadge.className   = 'badge exit-err'
  exitBadge.textContent = '✗ error'

  setTimeout(() => {
    if (!isRunning) {
      statusDot.className    = 'status-dot idle'
      statusText.textContent  = 'idle'
    }
  }, 3000)
}

function setCancelledUI() {
  isRunning = false
  runBtn.disabled        = false
  runBtnIcon.textContent  = '▶'
  runBtnLabel.textContent = 'Run'
  cancelBtn.classList.add('hidden')

  statusDot.className    = 'status-dot cancelled'
  statusText.textContent  = 'cancelled'

  termCursor.classList.remove('hidden')
  termSpinner.classList.add('hidden')

  exitBadge.className   = 'badge exit-cancel'
  exitBadge.textContent = '◼ cancelled'

  setTimeout(() => {
    if (!isRunning) {
      statusDot.className    = 'status-dot idle'
      statusText.textContent  = 'idle'
    }
  }, 3000)
}

// ── CLEAR BUTTON ────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  if (!isRunning) clearTerminal()
})

// ── LOCAL-STORAGE HISTORY ───────────────────────────────
// History is stored per browser — each user sees only their own runs.
// Survives page refresh, cleared manually or after 50 entries.
function getHistory() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') }
  catch { return [] }
}

function storeHistory(entry) {
  const hist = getHistory().filter(h => h.id !== entry.id)
  hist.unshift(entry)
  if (hist.length > MAX_HIST) hist.pop()
  localStorage.setItem(LS_KEY, JSON.stringify(hist))
}

function timeAgo(iso) {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (s < 5)    return 'just now'
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400)return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderHistory() {
  const hist = getHistory()
  histCount.textContent = hist.length
  histList.innerHTML    = ''

  if (!hist.length) {
    histList.innerHTML = `<div class="hist-empty"><span>○</span><span>No executions yet. Run some code to see history here.</span></div>`
    return
  }

  hist.forEach(item => {
    const firstLine = (item.code || '').split('\n')[0].trim()
    const codePrev  = firstLine.length > 52 ? firstLine.slice(0, 52) + '…' : firstLine
    const outRaw    = (item.output || '').replace(/\n/g, ' ').trim()
    const outShort  = outRaw.length > 58 ? outRaw.slice(0, 58) + '…' : outRaw
    const hasStin   = !!(item.stdin && item.stdin.trim())

    const card = document.createElement('div')
    card.className = 'hist-item'
    card.innerHTML = `
      <span class="lb ${item.language}">${item.language}</span>
      <div class="hist-mid">
        <span class="hist-code-prev">${esc(codePrev)}</span>
        ${outShort ? `<span class="hist-out-prev">→ ${esc(outShort)}</span>` : ''}
      </div>
      <div class="hist-right">
        <span class="hist-ms">${item.runtime ?? 0}ms</span>
        <span class="hist-ago">${timeAgo(item.createdAt)}</span>
        <div class="hist-btns">
          <button class="hbtn" data-id="${item.id}" data-act="code">code</button>
          ${hasStin ? `<button class="hbtn stdin-btn" data-id="${item.id}" data-act="stdin">stdin</button>` : ''}
          <button class="hbtn" data-id="${item.id}" data-act="output">output</button>
        </div>
      </div>
    `
    histList.appendChild(card)
  })

  histList.querySelectorAll('.hbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = getHistory().find(h => h.id === btn.dataset.id)
      if (!item) return
      const act = btn.dataset.act
      if (act === 'code') {
        openModal(`code — ${item.language} · ${timeAgo(item.createdAt)}`, item.code || '')
      } else if (act === 'stdin') {
        openModal(`stdin — ${item.language} · ${timeAgo(item.createdAt)}`, item.stdin || '(empty)')
      } else {
        openModal(`output — ${item.language} · ${item.runtime}ms`, item.output || '(no output)')
      }
    })
  })
}

// ── HISTORY TOGGLE ──────────────────────────────────────
histBar.addEventListener('click', () => {
  histOpen = !histOpen
  histSection.classList.toggle('open', histOpen)
})

// ── MODAL ───────────────────────────────────────────────
function openModal(title, content) {
  modalTitle.textContent = title
  modalPre.textContent   = content
  modalBg.classList.remove('hidden')
}

modalClose.addEventListener('click', () => modalBg.classList.add('hidden'))
modalBg.addEventListener('click',   e => { if (e.target === modalBg) modalBg.classList.add('hidden') })
document.addEventListener('keydown', e => { if (e.key === 'Escape') modalBg.classList.add('hidden') })
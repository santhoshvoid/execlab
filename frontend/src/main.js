import './style.css'
import * as monaco from 'monaco-editor'
import { io } from 'socket.io-client'

// ── CONFIG ──────────────────────────────────────────────
// Same file works locally AND on Vercel.
// On Vercel: set VITE_API_URL and VITE_SOCKET_URL as env vars.
// Locally (docker mode): both default to localhost.
//
// PISTON MODE (Render deployment):
//   VITE_API_URL    = https://your-app.onrender.com
//   VITE_SOCKET_URL = https://your-app.onrender.com   ← same URL! socket on same port
//
// LOCAL DOCKER MODE:
//   VITE_API_URL    = http://localhost:3001
//   VITE_SOCKET_URL = http://localhost:3002            ← worker's socket, different port
//
const API        = import.meta.env.VITE_API_URL    || 'http://localhost:3001'
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3002'

const LS_KEY  = 'execlab_history'
const MAX_HIST = 50

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
let currentJobId = null

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

// Cancel: in piston mode, we can't truly stop remote execution,
// but we detach the listener so the UI resets immediately.
cancelBtn.addEventListener('click', () => {
  if (!isRunning) return
  if (currentJobId) {
    socket.emit('cancel', currentJobId)       // for local docker mode
    socket.off(`job:${currentJobId}`)         // detach listener now
    currentJobId = null
  }
  setCancelledUI()
})

async function runCode() {
  const code  = editor?.getValue() ?? ''
  const stdin = stdinInput?.value  ?? ''
  if (!code.trim()) return

  isRunning = true
  setRunningUI()
  clearTerminal()
  appendSep(curLang)

  try {
    const res = await fetch(`${API}/run`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code, language: curLang, stdin }),
    })

    // ── RATE LIMIT ───────────────────────────────────────
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}))
      appendText(`⚠  Rate limited: ${data.message || 'Too many requests. Wait a moment.'}`, 'stderr')
      setFailedUI('Rate limited')
      return
    }

    if (!res.ok) {
      appendText(`\nServer error: ${res.status}`, 'stderr')
      setFailedUI(`HTTP ${res.status}`)
      return
    }

    const { jobId } = await res.json()
    currentJobId    = jobId

    // ── SOCKET LISTENER ──────────────────────────────────
    const event   = `job:${jobId}`
    let collected = ''
    const t0      = Date.now()

    const handler = (payload) => {
      // Streaming chunk (stdout green / stderr red)
      if (payload.chunk !== undefined) {
        collected += payload.chunk
        appendText(payload.chunk, payload.type === 'stderr' ? 'stderr' : 'stdout')
      }

      if (payload.status === 'completed') {
        socket.off(event, handler)
        currentJobId = null
        setDoneUI(payload.runtime ?? (Date.now() - t0))
        storeHistory({ id: jobId, language: curLang, code, stdin, output: collected || payload.output || '', runtime: payload.runtime ?? 0, createdAt: new Date().toISOString() })
        renderHistory()
      }

      if (payload.status === 'error') {
        socket.off(event, handler)
        currentJobId = null
        setErrorUI(payload.runtime ?? (Date.now() - t0), payload.exitCode ?? 1)
        storeHistory({ id: jobId, language: curLang, code, stdin, output: collected || payload.output || '', runtime: payload.runtime ?? 0, createdAt: new Date().toISOString() })
        renderHistory()
      }

      if (payload.status === 'failed') {
        socket.off(event, handler)
        currentJobId = null
        appendText('\n' + (payload.error || 'Execution failed'), 'stderr')
        setFailedUI(payload.error || 'failed')
      }

      if (payload.status === 'cancelled') {
        socket.off(event, handler)
        currentJobId = null
        appendText('\n[cancelled]', 'stderr')
        setCancelledUI()
      }
    }

    socket.on(event, handler)

    // ── HARD CLIENT TIMEOUT (45s — matches Piston's timeout) ──
    setTimeout(() => {
      if (!isRunning) return
      socket.off(event, handler)
      currentJobId = null
      appendText('\n[no response after 45s — execution may have timed out]', 'stderr')
      setFailedUI('Timeout')
    }, 46_000)

  } catch (err) {
    appendText('\nCould not reach server.', 'stderr')
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
  text.split('\n').forEach((part, i, arr) => {
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
  runBtn.disabled         = true
  runBtnIcon.textContent  = '◉'
  runBtnLabel.textContent = 'Running'
  cancelBtn.classList.remove('hidden')
  cancelBtn.disabled      = false
  statusDot.className     = 'status-dot running'
  statusText.textContent  = 'running'
  termCursor.classList.add('hidden')
  termSpinner.classList.remove('hidden')
}

function _resetRunBtn() {
  isRunning = false
  runBtn.disabled         = false
  runBtnIcon.textContent  = '▶'
  runBtnLabel.textContent = 'Run'
  cancelBtn.classList.add('hidden')
  termCursor.classList.remove('hidden')
  termSpinner.classList.add('hidden')
  setTimeout(() => {
    if (!isRunning) {
      statusDot.className   = 'status-dot idle'
      statusText.textContent = 'idle'
    }
  }, 3000)
}

function setDoneUI(runtime) {
  _resetRunBtn()
  statusDot.className    = 'status-dot done'
  statusText.textContent  = 'done'
  exitBadge.className   = 'badge exit-ok'
  exitBadge.textContent = '✓ exit 0'
  rtBadge.className     = 'badge rt'
  rtBadge.textContent   = `⏱ ${runtime}ms`
}

function setErrorUI(runtime, exitCode) {
  _resetRunBtn()
  statusDot.className    = 'status-dot failed'
  statusText.textContent  = 'error'
  exitBadge.className   = 'badge exit-err'
  exitBadge.textContent = `✗ exit ${exitCode}`
  rtBadge.className     = 'badge rt'
  rtBadge.textContent   = `⏱ ${runtime}ms`
}

function setFailedUI(_msg) {
  _resetRunBtn()
  statusDot.className    = 'status-dot failed'
  statusText.textContent  = 'failed'
  exitBadge.className   = 'badge exit-err'
  exitBadge.textContent = '✗ error'
}

function setCancelledUI() {
  _resetRunBtn()
  statusDot.className    = 'status-dot cancelled'
  statusText.textContent  = 'cancelled'
  exitBadge.className   = 'badge exit-cancel'
  exitBadge.textContent = '◼ cancelled'
}

// ── CLEAR ───────────────────────────────────────────────
clearBtn.addEventListener('click', () => { if (!isRunning) clearTerminal() })

// ── LOCAL HISTORY (localStorage — per browser, per user) ─
function getHistory() {
  try   { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') }
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
  if (s < 5)     return 'just now'
  if (s < 60)    return `${s}s ago`
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

function renderHistory() {
  const hist = getHistory()
  histCount.textContent = hist.length
  histList.innerHTML    = ''

  if (!hist.length) {
    histList.innerHTML = `<div class="hist-empty"><span>○</span><span>No executions yet.</span></div>`
    return
  }

  hist.forEach(item => {
    const firstLine  = (item.code || '').split('\n')[0].trim()
    const codePrev   = firstLine.length > 52 ? firstLine.slice(0, 52) + '…' : firstLine
    const outRaw     = (item.output || '').replace(/\n/g, ' ').trim()
    const outShort   = outRaw.length > 58 ? outRaw.slice(0, 58) + '…' : outRaw
    const hasStin    = !!(item.stdin && item.stdin.trim())

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
      if (act === 'code')        openModal(`code — ${item.language} · ${timeAgo(item.createdAt)}`,     item.code || '')
      else if (act === 'stdin')  openModal(`stdin — ${item.language}`,                                 item.stdin || '(empty)')
      else                       openModal(`output — ${item.language} · ${item.runtime}ms`,            item.output || '(no output)')
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
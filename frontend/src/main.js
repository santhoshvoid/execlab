import './style.css'
import * as monaco from 'monaco-editor'
import { io } from 'socket.io-client'

// ── CONFIG ──────────────────────────────────────────────
const API        = 'http://localhost:3001'
const SOCKET_URL = 'http://localhost:3002'
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
let editor    = null
let curLang   = 'python'
let isRunning = false
let histOpen  = false

// ── DOM ─────────────────────────────────────────────────
const $ = id => document.getElementById(id)

const langSelect  = $('language')
const langEmoji   = $('langEmoji')
const fileTab     = $('fileTab')
const runBtn      = $('runBtn')
const runBtnIcon  = $('runBtnIcon')
const runBtnLabel = $('runBtnLabel')
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
const histChevron = $('histChevron')
const modalBg     = $('modalBg')
const modalPre    = $('modalPre')
const modalTitle  = $('modalTitle')
const modalClose  = $('modalClose')

// ── SOCKET ──────────────────────────────────────────────
const socket = io(SOCKET_URL)
socket.on('connect', () => console.log('[socket] connected', socket.id))
socket.on('disconnect', () => console.log('[socket] disconnected'))

// ── MONACO INIT ─────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  editor = monaco.editor.create($('editor'), {
    value: LANGS.python.code,
    language: 'python',
    theme: 'vs-dark',
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontLigatures: true,
    lineHeight: 22,
    minimap: { enabled: false },
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

  // Ctrl/Cmd+Enter to run
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
runBtn.addEventListener('click', () => { if (!isRunning) runCode() })

async function runCode() {
  const code = editor?.getValue() ?? ''
  if (!code.trim()) return

  isRunning = true
  setRunningUI()
  clearTerminal()
  appendSep(curLang)

  try {
    const res  = await fetch(`${API}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, language: curLang })
    })
    const { jobId } = await res.json()

    // ── THE FIX: socket.on + manual socket.off ──────────
    //
    // BEFORE (broken): socket.once fires on the FIRST chunk event,
    //   unregisters itself, and never sees status:"completed".
    //   Result: button stays "Running..." forever.
    //
    // AFTER (fixed): socket.on listens to ALL events for this job.
    //   We call socket.off manually only when we receive the terminal
    //   status event (completed or failed).
    //
    const event = `job:${jobId}`
    let collected = ''
    const t0 = Date.now()

    const handler = (payload) => {
      // Streaming chunk (stdout/stderr)
      if (payload.chunk) {
        collected += payload.chunk
        appendText(payload.chunk, payload.type === 'stderr' ? 'stderr' : 'stdout')
      }

      // Job finished successfully
      if (payload.status === 'completed') {
        socket.off(event, handler)
        const runtime = payload.runtime ?? (Date.now() - t0)
        setDoneUI(runtime)
        storeHistory({ id: jobId, language: curLang, code, output: collected || payload.output || '', runtime })
        renderHistory()
      }

      // Job failed / timeout
      if (payload.status === 'failed') {
        socket.off(event, handler)
        const msg = payload.error || 'Execution failed'
        appendText('\n' + msg, 'stderr')
        setFailedUI(msg)
      }
    }

    socket.on(event, handler)

    // Hard client-side timeout in case worker dies silently
    setTimeout(() => {
      if (isRunning) {
        socket.off(event, handler)
        appendText('\n[no response from worker after 20s]', 'stderr')
        setFailedUI('Timeout')
      }
    }, 20000)

  } catch (err) {
    appendText('\nCould not reach server.', 'stderr')
    setFailedUI('Network error')
  }
}

// ── TERMINAL HELPERS ────────────────────────────────────
function clearTerminal() {
  outputArea.innerHTML = ''
  exitBadge.className  = 'badge hidden'
  rtBadge.className    = 'badge hidden'
  exitBadge.textContent = ''
  rtBadge.textContent   = ''
}

function appendSep(lang) {
  const el = document.createElement('div')
  el.className = 'run-sep'
  el.textContent = `${lang}  ${new Date().toLocaleTimeString()}`
  outputArea.appendChild(el)
}

function appendText(text, type = 'stdout') {
  // Preserve newlines by splitting and inserting <br>s
  const parts = text.split('\n')
  parts.forEach((part, i) => {
    if (i > 0) outputArea.appendChild(document.createElement('br'))
    if (part) {
      const el = document.createElement('span')
      el.className = `out-line ${type}`
      el.textContent = part
      outputArea.appendChild(el)
    }
  })
  termBody.scrollTop = termBody.scrollHeight
}

// ── UI STATE TRANSITIONS ────────────────────────────────
function setRunningUI() {
  runBtn.disabled       = true
  runBtnIcon.textContent = '◉'
  runBtnLabel.textContent = 'Running'

  statusDot.className   = 'status-dot running'
  statusText.textContent = 'running'

  termCursor.classList.add('hidden')
  termSpinner.classList.remove('hidden')
}

function setDoneUI(runtime) {
  isRunning = false
  runBtn.disabled        = false
  runBtnIcon.textContent  = '▶'
  runBtnLabel.textContent = 'Run'

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

function setFailedUI(msg) {
  isRunning = false
  runBtn.disabled        = false
  runBtnIcon.textContent  = '▶'
  runBtnLabel.textContent = 'Run'

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

// ── CLEAR BUTTON ────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  if (isRunning) return
  clearTerminal()
})

// ── LOCAL HISTORY ───────────────────────────────────────
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
  const s = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (s < 60)  return `${s}s ago`
  if (s < 3600) return `${Math.floor(s/60)}m ago`
  if (s < 86400) return `${Math.floor(s/3600)}h ago`
  return `${Math.floor(s/86400)}d ago`
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
}

function renderHistory() {
  const hist = getHistory()
  histCount.textContent = hist.length
  histList.innerHTML = ''

  if (!hist.length) {
    histList.innerHTML = `<div class="hist-empty"><span>○</span><span>No executions yet. Run some code to see history here.</span></div>`
    return
  }

  hist.forEach(item => {
    const firstLine   = (item.code   || '').split('\n')[0].trim()
    const codePrev    = firstLine.length > 52 ? firstLine.slice(0,52)+'…' : firstLine
    const outPrev     = (item.output || '').replace(/\n/g,' ').trim()
    const outShort    = outPrev.length > 58 ? outPrev.slice(0,58)+'…' : outPrev
    const timeAgoStr  = item.createdAt ? timeAgo(item.createdAt) : ''

    const card = document.createElement('div')
    card.className = 'hist-item'
    card.innerHTML = `
      <span class="lb ${item.language}">${item.language}</span>
      <div class="hist-mid">
        <span class="hist-code-prev">${esc(codePrev)}</span>
        ${outShort ? `<span class="hist-out-prev">→ ${esc(outShort)}</span>` : ''}
      </div>
      <div class="hist-right">
        <span class="hist-ms">${item.runtime}ms</span>
        <span class="hist-ago">${timeAgoStr}</span>
        <div class="hist-btns">
          <button class="hbtn" data-id="${item.id}" data-act="code">code</button>
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
      openModal(
        btn.dataset.act === 'code'
          ? `code — ${item.language} · ${timeAgo(item.createdAt)}`
          : `output — ${item.language} · ${item.runtime}ms`,
        btn.dataset.act === 'code' ? item.code : (item.output || '(no output)')
      )
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
modalBg.addEventListener('click', e => { if (e.target === modalBg) modalBg.classList.add('hidden') })
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') modalBg.classList.add('hidden')
})
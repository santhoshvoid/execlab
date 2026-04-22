import './style.css'
import * as monaco from 'monaco-editor'
import { io } from "socket.io-client"
let editor

window.addEventListener('DOMContentLoaded', () => {
  editor = monaco.editor.create(document.getElementById('editor'), {
    value: 'print("hello from UI")',
    language: 'python',
    theme: 'vs-dark',
    fontSize: 14,
    minimap: { enabled: false },
    automaticLayout: true   // ✅ THIS FIXES HALF YOUR ISSUES
  })
})
const socket = io("http://localhost:3002")
const button = document.querySelector('#runBtn')
const status = document.querySelector('#status')
const output = document.querySelector('#outputBox')
const languageSelect = document.querySelector('#language')

languageSelect.addEventListener('change', () => {
  const lang = languageSelect.value

  const map = {
    python: 'python',
    javascript: 'javascript',
    cpp: 'cpp',
    java: 'java'
  }

  if (editor) {
    monaco.editor.setModelLanguage(editor.getModel(), map[lang])
  }
})

button.onclick = async () => {
  output.innerText = ''
  status.innerText = 'Status: running...'
  status.className = 'running'
  button.disabled = true
  button.innerText = 'Running...'

  try {
    const res = await fetch('http://localhost:3001/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: editor ? editor.getValue() : '',
        language: languageSelect.value
      })
    })

    const data = await res.json()
    const jobId = data.jobId
    socket.once(`job:${jobId}`, (data) => {
      // 🔥 STREAMING OUTPUT
      if (data.chunk) {
        output.innerText += data.chunk
      }

      // 🔥 FINAL RESULT
      if (data.status === "completed") {
        status.innerText = "Status: completed"
        status.className = "completed"

        if (!data.chunk && data.output) {
          output.innerText = data.output
        }

        // Optional: show runtime
        if (data.runtime) {
          output.innerText += `\n\n⏱ Runtime: ${data.runtime} ms`
        }

        button.disabled = false
        button.innerText = "Run Code"

        refreshHistoryAfterRun()
      }

      // 🔥 HANDLE ERROR
      if (data.status === "failed") {
        status.innerText = "Status: failed"
        status.className = "failed"

        output.innerText += `\n${data.error || "Execution failed"}`

        button.disabled = false
        button.innerText = "Run Code"
      }
    })


  } catch (err) {
    status.innerText = 'Status: error'
    status.className = 'failed'
    output.innerText = 'Something went wrong'
    button.disabled = false
  }
}

// ================= HISTORY =================

const historyDiv = document.getElementById("history")

async function loadHistory() {
  try {
    const res = await fetch("http://localhost:3001/history")
    const data = await res.json()

    historyDiv.innerHTML = ""

    data.forEach(item => {
      const card = document.createElement("div")

      card.style.background = "#111"
      card.style.padding = "15px"
      card.style.marginBottom = "10px"
      card.style.borderRadius = "10px"
      card.style.color = "white"

      card.innerHTML = `
        <p><strong>Language:</strong> ${item.language}</p>
        <p><strong>Output:</strong> ${item.output}</p>
        <p><strong>Runtime:</strong> ${item.runtime} ms</p>
        <pre style="background:#222;padding:10px;">${item.code}</pre>
        <p style="font-size:12px;color:gray;">
          ${new Date(item.created_at).toLocaleString()}
        </p>
      `

      historyDiv.appendChild(card)
    })

  } catch (err) {
    console.error(err)
    historyDiv.innerHTML = "<p style='color:red'>Failed to load history</p>"
  }
}

// load on page start
loadHistory()

// reload after each run completes
function refreshHistoryAfterRun() {
  setTimeout(loadHistory, 1000)
}
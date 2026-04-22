import './style.css'

const textarea = document.querySelector('#code')
const button = document.querySelector('#runBtn')
const status = document.querySelector('#status')
const output = document.querySelector('#outputBox')
const languageSelect = document.querySelector('#language')

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
        code: textarea.value,
        language: languageSelect.value
      })
    })

    const data = await res.json()
    const jobId = data.jobId

    const interval = setInterval(async () => {
      const resultRes = await fetch(`http://localhost:3001/result/${jobId}`)
      const result = await resultRes.json()

      // ✅ ALWAYS update status
      status.innerText = `Status: ${result.status}`

      // ✅ SAFE OUTPUT HANDLING (THIS IS THE FIX)
      output.innerText = `${result.output || ''}\n\n⏱ Runtime: ${result.runtime || 0} ms`

      if (result.status === 'completed') {
        clearInterval(interval)
        status.className = 'completed'
        button.disabled = false
        button.innerText = 'Run Code'

        refreshHistoryAfterRun()
      }

      if (result.status === 'failed') {
        clearInterval(interval)
        status.className = 'failed'
        output.innerText = result.error || 'Execution failed'
        button.disabled = false
        button.innerText = 'Run Code'
      }

    }, 1000)

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
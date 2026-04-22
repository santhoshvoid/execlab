import './style.css'

const textarea = document.querySelector('#code')
const button = document.querySelector('#runBtn')
const status = document.querySelector('#status')
const output = document.querySelector('#outputBox')

button.onclick = async () => {
  output.innerText = ''
  status.innerText = 'Status: running...'
  status.className = 'running'
  button.disabled = true
  button.innerText = 'Running...'
  button.disabled = false
  button.innerText = 'Run Code'

  try {
    const res = await fetch('http://localhost:3001/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: textarea.value,
        language: 'python'
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
      output.innerText = result.output || ''

      if (result.status === 'completed') {
        clearInterval(interval)
        status.className = 'completed'
        button.disabled = false
      }

      if (result.status === 'failed') {
        clearInterval(interval)
        status.className = 'failed'
        output.innerText = result.error || 'Execution failed'
        button.disabled = false
      }

    }, 1000)

  } catch (err) {
    status.innerText = 'Status: error'
    status.className = 'failed'
    output.innerText = 'Something went wrong'
    button.disabled = false
  }
}
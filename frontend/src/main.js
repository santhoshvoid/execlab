const textarea = document.querySelector('textarea')
const button = document.querySelector('button')
const status = document.querySelector('#status')
const output = document.querySelector('#output')

button.onclick = async () => {
  status.innerText = 'running...'

  const res = await fetch('http://localhost:3001/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      code: textarea.value,
      language: 'python'
    })
  })

  const data = await res.json()

  const jobId = data.jobId

  // poll result
  const interval = setInterval(async () => {
    const resultRes = await fetch(`http://localhost:3001/result/${jobId}`)
    const result = await resultRes.json()

    if (result.status === 'completed') {
      clearInterval(interval)
      status.innerText = 'completed'
      output.innerText = result.result.output
    }

    if (result.status === 'failed') {
      clearInterval(interval)
      status.innerText = 'failed'
      output.innerText = result.failedReason
    }

  }, 1000)
}
# ⚡ ExecLab

<div align="center">

**A distributed code execution engine that safely runs untrusted code in isolated containers with real-time streaming output.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Containerized-2496ED?style=flat-square&logo=docker)](https://docker.com/)
[![Redis](https://img.shields.io/badge/Redis-BullMQ-DC382D?style=flat-square&logo=redis)](https://redis.io/)
[![Fastify](https://img.shields.io/badge/Fastify-4.x-000000?style=flat-square&logo=fastify)](https://fastify.dev/)

[Live Demo](https://execlab.vercel.app/) · [Report a Bug](https://github.com/santhoshvoid/execlab/issues) · [Architecture Breakdown](#system-architecture)

</div>

---


## What is this, actually

ExecLab lets you write and run code in the browser — Python, JavaScript, C++, Java — with output that streams to you in real time, the same way a local terminal would.


That part sounds simple. The interesting part is what's happening underneath.

When you hit **Run**, your code doesn't just get handed to some black-box API. Locally, it goes into a **Redis-backed job queue**, gets picked up by a **dedicated worker process**, which then spawns an **isolated Docker container** with hard limits (memory, CPU, network, PIDs), pipes your stdin in, and streams every byte of stdout/stderr back to your browser over a WebSocket — as it happens, not after it finishes.

This project focuses on backend system design rather than just UI — simulating how real execution platforms handle concurrency, isolation, and streaming.

You can cancel mid-execution. Compilation errors for C++ and Java stream back live. The engine handles stdin properly (not as an afterthought). Rate limiting, timeouts, exit codes, runtime — it's all tracked.

Designed to handle concurrent executions safely with minimal resource usage and clear isolation guarantees.

That's what ExecLab is.

---

## Features

- **Real-time output streaming** — stdout and stderr pipe directly from the container to your browser over Socket.io. No polling, no waiting for the process to finish. You see output as the program produces it.

- **Proper stdin support** — there's a dedicated input panel for programs that call `input()`, `Scanner`, or `cin`. The engine pipes it into the container before execution starts.

- **Job cancellation** — hit Stop at any time. The worker sends `SIGTERM` to the running container. The UI resets immediately. This required maintaining a live process registry (`activePids` map) keyed by job ID.

- **Sandboxed execution** — every run gets a fresh Docker container with `--network=none`, `--memory=128m`, `--cpus=0.5`, and `--pids-limit=64`. Containers can't talk to the internet, can't fork-bomb the host, can't eat all your RAM.

- **Language-aware timeouts** — Python and JavaScript time out at 15 seconds. C++ and Java get 30 seconds because compilation can take 10–15 seconds on limited CPU. This distinction matters in practice.

- **Per-IP rate limiting** — 10 executions per minute per IP. In local mode this runs through Redis (persistent, exact). In the demo deployment it falls back to an in-memory sliding window.

- **Execution history** — every run is stored in localStorage (client-side, up to 50 entries). Server-side persistence to PostgreSQL via a `submissions` table. You can review past code, stdin, and output at any time.

- **Monaco Editor** — the same editor engine that powers VS Code. Syntax highlighting, keyboard shortcuts, smooth scrolling, the works. `Cmd/Ctrl+Enter` runs your code.

- **Exit code + runtime display** — the terminal footer shows whether execution succeeded (`exit 0`) or failed (`exit 1+`) along with the exact runtime in milliseconds.

---

## System Architecture

### Local (Full) Architecture

This is how ExecLab runs when you clone it and spin it up with Docker Compose. Every component is real — nothing is faked.

```
                            ┌─────────────────────────────────────┐
                            │           Browser (Frontend)         │
                            │                                      │
                            │   Monaco Editor  +  Terminal UI      │
                            │   Socket.io client (port 3002)       │
                            └────────┬──────────────┬─────────────┘
                                     │  POST /run   │  WebSocket
                                     ▼              │  (live chunks)
                            ┌────────────────┐      │
                            │  Fastify API   │      │
                            │  (port 3001)   │      │
                            │                │      │
                            │  Rate Limiter  │      │
                            │  (Redis-based) │      │
                            └───────┬────────┘      │
                                    │ enqueue job    │
                                    ▼               │
                            ┌────────────────┐      │
                            │  Redis + BullMQ│      │
                            │  Job Queue     │      │
                            └───────┬────────┘      │
                                    │ dequeue        │
                                    ▼               │
                            ┌────────────────┐      │
                            │    Worker      ├──────┘
                            │  (port 3002)   │  emits socket events
                            │  activePids{}  │  (chunks + status)
                            └───────┬────────┘
                                    │ docker run
                                    ▼
                  ┌─────────────────────────────────────┐
                  │         Docker Container             │
                  │   Alpine Linux + language runtime    │
                  │                                      │
                  │   --memory=128m  --cpus=0.5          │
                  │   --network=none  --pids-limit=64    │
                  │                                      │
                  │   run.py (wrapper) → actual program  │
                  └──────────────────────────────────────┘
                                    │
                                    ▼
                            ┌────────────────┐
                            │  PostgreSQL     │
                            │  (submissions) │
                            └────────────────┘
```

**Data flow for a single execution:**
1. Browser sends `POST /run` with `{ code, language, stdin }`
2. Fastify checks rate limit (Redis), enqueues job in BullMQ, returns `{ jobId }`
3. Browser opens a Socket.io listener for `job:<jobId>`
4. Worker dequeues the job, spawns `docker run` with the appropriate image
5. Worker streams stdout/stderr chunks to Socket.io in real time
6. On exit: worker emits `{ status, exitCode, runtime }` and saves to DB

---

### Demo (Deployed) Architecture

The deployed version on Render uses [Judge0 CE](https://github.com/judge0/judge0) (via RapidAPI) instead of local Docker. This keeps the infrastructure serverless-friendly — no Docker socket, no separate worker process needed.

```
                            ┌─────────────────────────────────────┐
                            │           Browser (Frontend)         │
                            │   Socket.io client (same port)       │
                            └────────┬──────────────┬─────────────┘
                                     │  POST /run   │  WebSocket
                                     ▼              │  (polled result)
                            ┌────────────────────────────────────┐
                            │       Fastify API (port 3001)       │
                            │                                      │
                            │   Rate Limiter (in-memory map)       │
                            │   Socket.io server (same port!)      │
                            └──────────────┬─────────────────────┘
                                           │ POST to Judge0 API
                                           ▼
                            ┌──────────────────────────────────┐
                            │     Judge0 CE (RapidAPI)          │
                            │  Remote sandboxed execution       │
                            │  Polling until result is ready    │
                            └──────────────────────────────────┘
```

---

## Production vs Demo: The Honest Breakdown

This section exists because the two deployments genuinely behave differently, and I'd rather be upfront about why.

| What | Local (Docker) | Demo (Render) |
|------|---------------|---------------|
| Execution engine | Custom Docker containers | Judge0 CE API |
| Output delivery | True real-time streaming | Polled result (pseudo-streaming) |
| Job queue | BullMQ + Redis | No queue — async function |
| Worker process | Dedicated `worker.ts` | Runs inside server directly |
| Cancellation | Real `SIGTERM` to container | UI-only detach (execution keeps running remotely) |
| Rate limiting | Redis sliding window | In-memory map |
| Socket.io | Port 3002 (worker's server) | Port 3001 (same as HTTP) |

**Why the difference?**

Running Docker containers on cloud platforms like Render or Railway requires either mounting the Docker socket (`/var/run/docker.sock`) on a persistent server or using Docker-in-Docker — both of which cost real money for an always-on instance (typically $25–$50/month minimum for the memory and socket access you need).

The demo runs on a free Render tier. Free tier = no persistent Docker socket = no local container spawning.

So for the demo, the backend switches to Judge0 CE — a public sandboxed execution API that handles the containerization on their end. The frontend looks identical. The Socket.io architecture is slightly different (same port, polling-based results rather than true streaming), but the user experience is close enough to demonstrate the concept.

**The full local setup is the real thing.** Four custom Docker images, a Redis queue, a live worker, real cancellation, real streaming. If you want to see that running, clone the repo and follow the local setup below. It runs perfectly fine with Docker Compose.

---

## Tech Stack

**Frontend**
- Vite (build tool)
- Vanilla JavaScript — no framework, intentional
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — VS Code's editor engine
- Socket.io client
- JetBrains Mono font

**Backend**
- Node.js 20 + TypeScript
- [Fastify](https://fastify.dev/) — significantly faster than Express, proper TypeScript support
- [BullMQ](https://bullmq.io/) — Redis-backed job queue (local mode)
- [ioredis](https://github.com/redis/ioredis) — Redis client
- Socket.io server
- `node:child_process` for spawning Docker containers

**Infrastructure (Local)**
- Docker + Docker Compose
- Redis 7 (Alpine)
- PostgreSQL (via `pg` pool)
- Custom Docker images: `execlab-python-runner`, `execlab-node-runner`, `execlab-cpp-runner`, `execlab-java-runner`

**Infrastructure (Demo)**
- Render (backend hosting)
- Judge0 CE via RapidAPI (remote execution)
- Supabase or any PostgreSQL-compatible DB

---

## Project Structure

```
execlab/
├── frontend/
│   ├── index.html          # Main shell — Monaco editor + terminal UI
│   ├── src/
│   │   ├── main.js         # Socket.io, Monaco setup, run/cancel logic, history
│   │   └── style.css       # Terminal aesthetics, dark theme
│   └── vite.config.js
│
├── backend/
│   ├── src/
│   │   ├── server.ts       # Fastify routes, rate limiter, execution mode switch
│   │   ├── worker.ts       # BullMQ worker, Docker spawner, streaming, cancellation
│   │   ├── socket.ts       # Socket.io server instance (port 3002, local mode)
│   │   ├── services/
│   │   │   ├── queue.ts    # BullMQ queue definition
│   │   │   ├── redis.ts    # ioredis singleton
│   │   │   ├── db.ts       # PostgreSQL pool
│   │   │   └── saveSubmission.ts  # Persist runs to DB
│   │   └── routes/
│   │       └── history.ts  # GET /history — last 20 runs from DB
│   ├── tsconfig.json
│   └── .env
│
├── runners/                # One folder per language
│   ├── python/
│   │   ├── Dockerfile      # Alpine + python3
│   │   └── run.py          # Parses code+stdin, runs python3 -u
│   ├── node/
│   │   ├── Dockerfile      # Alpine + node
│   │   └── run.js
│   ├── cpp/
│   │   ├── Dockerfile      # Alpine + g++
│   │   └── run.py          # Compiles with g++, then runs binary
│   └── java/
│       ├── Dockerfile      # Alpine + OpenJDK
│       └── run.py
│
└── docker-compose.yml      # Backend + Redis
```

---

## Getting Started

### Prerequisites

- Docker + Docker Compose (for local execution mode)
- Node.js 20+
- A PostgreSQL database (Supabase free tier works fine)
- Redis (handled by Docker Compose, no manual install needed)

### 1. Clone and install

```bash
git clone https://github.com/yourusername/execlab.git
cd execlab
```

Install backend dependencies:
```bash
cd backend && npm install
```

Install frontend dependencies:
```bash
cd ../frontend && npm install
```

### 2. Build the runner Docker images

Each language gets its own isolated image. Build them all:

```bash
docker build -t execlab-python-runner ./runners/python
docker build -t execlab-node-runner   ./runners/node
docker build -t execlab-cpp-runner    ./runners/cpp
docker build -t execlab-java-runner   ./runners/java
```

This step is only needed once (or when you modify the runner scripts).

### 3. Configure environment variables

Create `backend/.env`:

```env
# Execution mode — 'docker' for local, 'piston' for deployed
EXECUTION_MODE=docker

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/execlab

# Redis (used automatically by Docker Compose)
REDIS_URL=redis://localhost:6379

# Judge0 (only needed if EXECUTION_MODE=piston)
JUDGE0_API_KEY=your_rapidapi_key_here

# JWT (for future auth — set anything locally)
JWT_SECRET=dev_secret_change_me_in_prod
```

Create `frontend/.env`:

```env
VITE_API_URL=http://localhost:3001
VITE_SOCKET_URL=http://localhost:3002
```

### 4. Set up the database

Run this in your PostgreSQL instance:

```sql
CREATE TABLE submissions (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL,
  language    VARCHAR(20) NOT NULL,
  output      TEXT,
  runtime     INTEGER,
  created_at  TIMESTAMP DEFAULT NOW()
);
```

### 5. Start everything

**Start Redis + backend API** (via Docker Compose):
```bash
cd backend
docker-compose up -d
```

**Start the worker** (in a separate terminal):
```bash
cd backend
npx ts-node src/worker.ts
```

**Start the frontend dev server**:
```bash
cd frontend
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) — you're running.

### Running in demo mode (no Docker required)

Set `EXECUTION_MODE=piston` in your backend `.env` and add your `JUDGE0_API_KEY`. Then:

```bash
cd backend && npm run dev
cd frontend && npm run dev
```

No Docker images needed. No worker process needed. Useful for quick testing or cloud deployments without Docker socket access.

---

## API Reference

### `POST /run`

Submit code for execution.

**Request body:**
```json
{
  "code": "print('hello world')",
  "language": "python",
  "stdin": "optional input here"
}
```

**Response:**
```json
{ "jobId": "1704067200000-ab3f7" }
```

**Rate limit:** 10 requests/minute per IP. Returns `429` with a `retryAfter` field if exceeded.

After receiving `jobId`, listen on Socket.io for `job:<jobId>` events:

```js
socket.on(`job:${jobId}`, (payload) => {
  // During execution:
  // { chunk: "output text", type: "stdout" | "stderr" }

  // On completion:
  // { status: "completed" | "error" | "cancelled" | "failed",
  //   exitCode: 0,  runtime: 1234,  output: "full output" }
})
```

### `GET /history`

Returns the last 20 executions from the database.

```json
[
  {
    "id": 42,
    "code": "print('hello')",
    "language": "python",
    "output": "hello\n",
    "runtime": 312,
    "created_at": "2024-01-01T12:00:00.000Z"
  }
]
```

### `GET /health`

```json
{ "status": "ok", "mode": "docker" }
```

---

## Supported Languages

| Language | Image | Timeout | Notes |
|----------|-------|---------|-------|
| Python 3 | `execlab-python-runner` | 15s | Runs with `-u` (unbuffered) for true streaming |
| JavaScript | `execlab-node-runner` | 15s | Node.js runtime |
| C++ | `execlab-cpp-runner` | 30s | Compiled with `g++`, extra time for compilation |
| Java | `execlab-java-runner` | 30s | `javac` + `java`, extra time for JVM startup + compilation |

All containers run as a non-root `sandbox` user. Network access is completely disabled (`--network=none`).

---

## A Few Design Decisions Worth Noting

One of the key challenges was implementing true real-time streaming from Docker containers without buffering — solved using inherited stdout/stderr streams and Socket.io.

**Why separate ports for API (3001) and Socket.io (3002) locally?**

In local mode, the Socket.io server lives inside the worker process — not the API server. This means the worker can emit events directly without hopping through the API. In demo mode, both run on the same port because Render only exposes one.

**Why BullMQ instead of just spawning directly from the API?**

Decoupling the HTTP handler from the execution means the API is never blocked waiting for a container. More importantly, if the worker crashes and restarts, BullMQ jobs are persisted in Redis — nothing gets lost. The queue also makes it trivial to scale to multiple workers later.

**Why a custom `run.py` wrapper inside each container instead of running the language directly?**

The wrapper handles the `<<<STDIN>>>` separator protocol — splitting the incoming stdin stream into "user code" and "program input." This lets the worker send both pieces over a single stdin pipe instead of needing a more complex IPC mechanism. It also means compilation (for C++ and Java) and execution are both handled inside the same container, with compilation errors streaming out the same stderr channel.

**Why `--network=none`?**

Any code runner that doesn't disable networking is one `requests.get('http://evil.com')` away from being a botnet node. This is non-negotiable for a public execution environment.

---

## Known Limitations

- **Cancellation in demo mode** is UI-only — once a job is submitted to Judge0, it runs to completion remotely. The frontend just detaches its socket listener and resets the UI.
- **No persistent stdin replay** — stdin is stored in execution history but not re-populated into the input panel when you click into a past run (not hard to add, just not done yet).
- **History resets across devices** — client-side history lives in localStorage. The DB-backed `/history` endpoint exists but isn't yet surfaced in the UI as a server-synced view.
- **No authentication** — any IP can run code, protected only by rate limiting. Good enough for a portfolio project, not for production.

---

## Roadmap

- [ ] Persistent server-side history panel (replace localStorage with DB-backed view)
- [ ] Add more languages — Go, Rust, Ruby
- [ ] WebSocket-based stdin (interactive programs, not just pre-supplied input)
- [ ] Metrics dashboard — executions per language, average runtime, error rates
- [ ] Authentication (JWT) so users can see their own history across devices

---

## Local Architecture, Visualized (minimal)

If you want a dead-simple mental model:

```
Browser ──POST──► API ──enqueue──► Redis Queue ──dequeue──► Worker ──spawn──► Docker
  ▲                                                              │
  └────────────────── Socket.io (live chunks) ──────────────────┘
```

The whole system is event-driven. The API returns in milliseconds. The worker does the heavy lifting asynchronously.

---

## License

MIT — do whatever you want with it. If it helps you understand distributed systems or lands you a job, that's the point.

---

<div align="center">
  <sub>Built by hand. No Copilot shortcuts on the architecture. Just a lot of Docker logs and Redis CLI.</sub>
</div>

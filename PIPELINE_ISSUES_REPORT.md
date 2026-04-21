# Forge Pipeline Issues — Remediation Report

**Scope:** Pipeline correctness, concurrency, and lifecycle issues across the orchestrator, gateway WebSocket/proxy plumbing, and frontend pipeline hooks/components. Security findings are intentionally excluded per user instruction.

**Audience:** An automated coding agent. Each issue is self-contained: file path, line numbers, exact problem, root cause, and prescribed fix with code. Apply in the listed order; later fixes assume earlier ones are in place.

**Repo root:** `/Users/manideepboddu/Library/Mobile Documents/com~apple~CloudDocs/Forge`

---

## Architecture Recap (for context)

```
forge-web (React/TS, :3000)
    └── forge-gateway (Go chi, :8080)        ← JWT auth, WS fanout via Redis pub/sub
            └── forge-orchestrator (FastAPI, :8090)
                    └── LangGraph pipeline: classify → requirements → architect →
                        codegen → review ⇄ test → hitl → cicd → complete
                    └── ContextManager (Redis hash, 24h TTL, pubsub channel ws:{pipeline_id})
                    └── OllamaClient (local + :cloud fallback)
```

WebSocket events flow: orchestrator → Redis `ws:{pipeline_id}` → gateway hub subscriber → browser clients.

---

## Issue Index

| # | Severity | File | Summary |
|---|---|---|---|
| 1 | HIGH | `forge-orchestrator/main.py` | `_running_tasks` unsynchronized, per-user quota counts globally, tasks not pruned |
| 2 | HIGH | `forge-orchestrator/models/schemas.py` | Naive `datetime.utcnow()` crashes against `timestamptz` columns |
| 3 | HIGH | `forge-orchestrator/services/context_manager.py`, `services/ollama_client.py` | Lazy-init race creates duplicate Redis pools / HTTP clients |
| 4 | HIGH | `forge-orchestrator/services/ollama_client.py` | Retry/fallback only applied to `:cloud` models; local models fail on first transient error |
| 5 | MEDIUM | `forge-orchestrator/main.py` | `import asyncio` scattered inside request handlers instead of module top |
| 6 | HIGH | `forge-gateway/websocket/hub.go` | Single client per pipeline; second subscriber force-closes first. Double `conn.Close()` in pumps |
| 7 | MEDIUM | `forge-gateway/handlers/pipeline.go` | `io.Copy` error in `relayResponse` swallowed; `CreatePipeline` body unbounded |
| 8 | HIGH | `forge-web/src/components/IDELayout.tsx` | `useState(() => { fetchPipelines(); })` misused as effect — runs in render phase |
| 9 | MEDIUM | `forge-web/src/components/ChatPanel.tsx` | `setTimeout(…, 2000)` used to clear `modifying` state; leaks on unmount, lies about completion |

---

## Issue 1 — `_running_tasks` concurrency & lifecycle bugs

**File:** `forge-orchestrator/main.py`

**Problems:**
1. Module-level `_running_tasks: dict[str, asyncio.Task]` mutated from multiple coroutines with no lock. Check-then-insert race in `create_pipeline` (lines ~104–138) can admit more than `MAX_PIPELINES_PER_USER` concurrent pipelines.
2. The "per-user" quota at lines 104–112 counts **all** in-flight pipelines globally — there is no `user_id` association stored, so one user can block everyone.
3. `_pipeline_task_done` callback only logs; it does **not** pop entries from `_running_tasks`, so the dict grows unbounded across the process lifetime.
4. Same unsafe insert pattern is duplicated in `retry_pipeline`, `modify_pipeline`, `fork_pipeline`, and `_create_pipeline_from_schedule`.

**Fix:**

Add at module top (near other module globals, after `import` block):

```python
import asyncio

_running_tasks: dict[str, asyncio.Task] = {}
_task_users: dict[str, str] = {}        # pipeline_id -> user_id
_tasks_lock = asyncio.Lock()
```

Replace `_pipeline_task_done` with a factory that closes over `pipeline_id`:

```python
def _make_task_done_callback(pipeline_id: str):
    def _callback(task: asyncio.Task) -> None:
        _running_tasks.pop(pipeline_id, None)
        _task_users.pop(pipeline_id, None)
        if task.cancelled():
            logger.warning("pipeline_task_cancelled", pipeline_id=pipeline_id)
        elif task.exception():
            logger.error(
                "pipeline_task_exception",
                pipeline_id=pipeline_id,
                error=str(task.exception()),
            )
    return _callback
```

In `create_pipeline`, wrap the quota check + task registration inside the lock:

```python
async with _tasks_lock:
    user_active = sum(
        1 for pid, t in _running_tasks.items()
        if not t.done() and _task_users.get(pid) == request.user_id
    )
    if user_active >= MAX_PIPELINES_PER_USER:
        raise HTTPException(
            status_code=429,
            detail=f"Per-user pipeline limit ({MAX_PIPELINES_PER_USER}) reached",
        )
    # … existing context init + DB insert …
    task = asyncio.create_task(_run_pipeline(pipeline_id, initial_state))
    task.add_done_callback(_make_task_done_callback(pipeline_id))
    _running_tasks[pipeline_id] = task
    _task_users[pipeline_id] = request.user_id
```

Apply the same lock + registration pattern (and use `_make_task_done_callback(pipeline_id)`) to every other place a pipeline task is created: `retry_pipeline`, `modify_pipeline`, `fork_pipeline`, `_create_pipeline_from_schedule`.

**Verification:** (a) Stress-test 20 concurrent `POST /api/pipeline` with same `user_id` and confirm HTTP 429 returns once the limit is reached. (b) Run a pipeline to completion and assert `pipeline_id not in _running_tasks`.

---

## Issue 2 — Naive `datetime.utcnow()` in schemas

**File:** `forge-orchestrator/models/schemas.py:142`

**Problem:** `timestamp: datetime = Field(default_factory=datetime.utcnow)` produces a tz-naive datetime. Postgres columns are `timestamptz`; asyncpg raises `DataError: can't compare offset-naive and offset-aware datetimes` on insert/compare.

**Fix:**

At top of file:
```python
from datetime import datetime, timezone
```

Replace line 142 (and any other `datetime.utcnow` in the file — grep the file to be sure):
```python
timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
```

Then grep the whole `forge-orchestrator/` tree for remaining `datetime.utcnow(` and `datetime.utcnow\b` usages; replace each with `datetime.now(timezone.utc)`.

**Verification:** Start a pipeline end-to-end and confirm no asyncpg timezone errors in `docker compose logs forge-orchestrator`.

---

## Issue 3 — Lazy singleton init race

**Files:**
- `forge-orchestrator/services/context_manager.py` — `_get_redis` at lines 24–27
- `forge-orchestrator/services/ollama_client.py` — `client` property at lines 19–22

**Problem:** Both do `if self._X is None: self._X = make()`. Two coroutines can both observe `None` and create two pools/clients; the first is leaked and connections multiply.

**Fix — ContextManager:**

Add `self._redis_lock = asyncio.Lock()` in `__init__`. Rewrite `_get_redis`:

```python
async def _get_redis(self):
    if self._redis is not None:
        return self._redis
    async with self._redis_lock:
        if self._redis is None:
            self._redis = redis.from_url(self.redis_url, decode_responses=True)
    return self._redis
```

**Fix — OllamaClient:** `client` is currently a sync `@property`. Convert to an async accessor (rename to `_get_client()`), or eagerly construct the `httpx.AsyncClient` in `__init__` / a single `async def startup()`. Option A (async accessor) requires updating all call sites inside the class to `await self._get_client()`. Option B (eager init) is simpler:

```python
def __init__(self, …):
    …
    self._client = httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout)

@property
def client(self) -> httpx.AsyncClient:
    return self._client

async def close(self) -> None:
    await self._client.aclose()
```

Call `await ollama_client.close()` from the FastAPI shutdown handler.

**Verification:** Run `pytest` / start orchestrator and ensure no duplicate "creating redis pool" log lines on first request.

---

## Issue 4 — Retry only on `:cloud` models

**File:** `forge-orchestrator/services/ollama_client.py:47–50` (inside `generate`)

**Problem:** Current `models_to_try` logic appends a cloud fallback for `:cloud` model names but does not retry local models. A single transient 503 from Ollama fails the agent step permanently.

**Fix:** Wrap each model attempt in a retry loop with exponential backoff; preserve existing fallback-to-alternate-model behavior.

```python
MAX_ATTEMPTS_PER_MODEL = 3
BASE_BACKOFF_S = 1.0

async def generate(self, model: str, prompt: str, …):
    models_to_try = self._resolve_models(model)    # existing helper
    last_error: Exception | None = None
    for candidate in models_to_try:
        for attempt in range(MAX_ATTEMPTS_PER_MODEL):
            try:
                return await asyncio.wait_for(
                    self._generate_once(candidate, prompt, …),
                    timeout=self.timeout,
                )
            except (httpx.HTTPError, asyncio.TimeoutError) as e:
                last_error = e
                if attempt == MAX_ATTEMPTS_PER_MODEL - 1:
                    logger.warning(
                        "ollama_model_exhausted",
                        model=candidate, attempts=attempt + 1, error=str(e),
                    )
                    break
                await asyncio.sleep(BASE_BACKOFF_S * (2 ** attempt))
    raise RuntimeError(f"All models failed: {last_error}") from last_error
```

**Verification:** Temporarily stop the Ollama container for 2 seconds during a pipeline run; pipeline should succeed after retries instead of failing the agent node.

---

## Issue 5 — Scattered `import asyncio`

**File:** `forge-orchestrator/main.py` — imports inside handlers at lines ~138, 465, 529, 612, 680

**Fix:** Remove the inner `import asyncio` statements. Ensure `import asyncio` is present exactly once at the top of the module (already required by Issue 1).

**Verification:** `ruff check forge-orchestrator/main.py` (or `python -m pyflakes`) reports no issues; `grep -n "import asyncio" forge-orchestrator/main.py` returns one line.

---

## Issue 6 — WebSocket hub: single-client per pipeline + double close

**File:** `forge-gateway/websocket/hub.go`

**Problems:**
1. `clients map[string]*client` (line 159) — map value is a single `*client`. Registering a second subscriber for the same `pipeline_id` force-closes the first (lines 190–193). Multiple browser tabs / reconnects clobber each other.
2. `writePump` has `defer c.conn.Close()` (line 338); `readPump` also calls `c.conn.Close()` in its defer (line 349). The same connection is closed twice when either pump exits.

**Fix — multi-subscriber:**

Change the map:
```go
clients map[string]map[*client]struct{}
```

`register` handler: create the inner set lazily; add the client; do **not** close existing clients.
```go
case c := <-h.register:
    set, ok := h.clients[c.pipelineID]
    if !ok {
        set = make(map[*client]struct{})
        h.clients[c.pipelineID] = set
    }
    set[c] = struct{}{}
```

`unregister` handler: remove from the set; delete the set (and unsubscribe from Redis) only when it becomes empty.
```go
case c := <-h.unregister:
    if set, ok := h.clients[c.pipelineID]; ok {
        if _, present := set[c]; present {
            delete(set, c)
            close(c.send)
            if len(set) == 0 {
                delete(h.clients, c.pipelineID)
                h.unsubscribeRedis(c.pipelineID)   // keep existing teardown
            }
        }
    }
```

Broadcast path (Redis → hub → client): fan out to every client in the set.
```go
for c := range h.clients[pipelineID] {
    select {
    case c.send <- msg:
    default:
        // slow client — drop and close
        close(c.send)
        delete(h.clients[pipelineID], c)
    }
}
```

**Fix — double close:** Remove the `defer c.conn.Close()` from **`writePump`** only (keep it in `readPump`). `readPump` owns the connection lifetime; `writePump` exits via the `send` channel closing and should not also close the socket.

**Verification:** Open two browser tabs on the same `pipeline_id`, start a pipeline, and confirm both tabs receive every status event. Gateway logs should contain no "use of closed network connection" errors.

---

## Issue 7 — Proxy error handling & unbounded body

**File:** `forge-gateway/handlers/pipeline.go`

**Problems:**
1. `relayResponse` (lines 328–332): `io.Copy(w, resp.Body)` return value discarded — truncated responses are silent.
2. `CreatePipeline` (line 57): `io.ReadAll(r.Body)` with no size cap — a client can OOM the gateway.

**Fix:**

```go
// relayResponse
if _, err := io.Copy(w, resp.Body); err != nil {
    log.Warn().Err(err).Str("upstream", resp.Request.URL.String()).Msg("relay_response_copy_failed")
}
```

```go
// CreatePipeline, before io.ReadAll
const maxBodyBytes = 1 << 20 // 1 MiB
r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
body, err := io.ReadAll(r.Body)
if err != nil {
    http.Error(w, "request body too large or unreadable", http.StatusRequestEntityTooLarge)
    return
}
```

**Verification:** `curl` with a >1 MiB body returns 413; truncation mid-relay is logged.

---

## Issue 8 — `useState` misused as effect

**File:** `forge-web/src/components/IDELayout.tsx:37`

**Problem:**
```tsx
useState(() => { fetchPipelines(); });
```
The `useState` initializer runs during render, its return value (`undefined`) is stored as state and never read. Re-renders may re-invoke it; fetch side effects in render are a React footgun.

**Fix:**
```tsx
useEffect(() => {
    fetchPipelines();
}, [fetchPipelines]);
```

Ensure `fetchPipelines` is wrapped in `useCallback` with a stable dep list (likely `[]` or `[userId]`). If `fetchPipelines` comes from a hook, confirm it is already memoized; otherwise memoize at the call site.

**Verification:** React DevTools Profiler shows `fetchPipelines` called once on mount, not on every render.

---

## Issue 9 — `setTimeout` lies about completion

**File:** `forge-web/src/components/ChatPanel.tsx:186–189` and `:387`

**Problem:** After calling `onModify(...)`, the component does `setTimeout(() => setModifying(false), 2000)`. This (a) leaks on unmount, and (b) clears the spinner whether or not the modification actually finished.

**Fix:** Lift `modifying` state to the parent (`IDELayout.tsx`) and reset it when `pipeline.id` changes (i.e., when the modify produces a new pipeline) or when the pipeline status transitions out of a modifying state. Drop the `setTimeout` entirely.

Rough shape:
```tsx
// IDELayout.tsx
const [modifying, setModifying] = useState(false);
const prevPipelineId = useRef(pipeline?.id);

useEffect(() => {
    if (pipeline?.id !== prevPipelineId.current) {
        setModifying(false);
        prevPipelineId.current = pipeline?.id;
    }
}, [pipeline?.id]);

<ChatPanel modifying={modifying} onModifyStart={() => setModifying(true)} … />
```

```tsx
// ChatPanel.tsx
// Remove local `modifying` state and both setTimeout calls.
// Call onModifyStart() before onModify(); parent owns the flag.
```

**Verification:** Submit a modify request on a slow network; spinner remains until the new pipeline actually arrives. Unmount mid-request; no "state update on unmounted component" warning.

---

## Execution Order

1. Issue 5 (import hoist) — mechanical, enables Issue 1.
2. Issue 1 (task lock + per-user accounting + cleanup).
3. Issue 2 (datetime).
4. Issue 3 (singleton lock).
5. Issue 4 (retry).
6. Issue 6 (WS hub).
7. Issue 7 (proxy).
8. Issue 8 (useEffect).
9. Issue 9 (lift modifying state).

After all edits, run in this order:
- `cd forge-orchestrator && python -m pytest` (if tests exist) and `ruff check .`
- `cd forge-gateway && go build ./... && go vet ./...`
- `cd forge-web && npm run typecheck && npm run build`
- `docker compose up -d --build` and exercise: create pipeline, open two WS tabs, submit modify, reach HITL, approve, reach complete. No errors in `docker compose logs`.

---

## Out of Scope (noted, not fixed here)

- Security: `ValidateJWT` returning `("", nil)` when `JWT_SECRET` unset; `user_id` default on Pydantic schema; missing `http.MaxBytesReader` on other endpoints. User explicitly deferred.
- `BaseAgent.run` mutating `result.duration_ms` post-construction (minor; Pydantic allows it).
- `monitor.py` hardcoded `asyncio.sleep(8)` stabilization wait (design choice, not a bug).
- `forge-orchestrator/db.py` pool sizing tuning.

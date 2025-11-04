"""Mini‑Colab backend service.

Core capabilities:
    * Per‑user ephemeral Docker containers with mounted workspaces
    * Authentication & image selection workflow (auth -> start container)
    * File CRUD + upload/download + quota enforcement
    * Interactive terminal via WebSocket (one shell per user)
    * Admin panel: resource stats, job/process enumeration, job termination, quota management
    * Stateless HMAC admin token (no DB state for tokens)

Design notes:
    * All Docker SDK calls are offloaded with asyncio.to_thread to keep the event loop responsive.
    * Process / job listing is container‑internal using ps; the root interactive shell PID is cached.
    * Quotas are enforced optimistically by size delta before writes / uploads.
    * Logout and kill operations are scheduled in background tasks to avoid blocking the request path.
"""

import os
import io
import zipfile
import docker
import shutil
import asyncio
import time
import uuid
import hmac
import hashlib
import base64
import re
from collections import defaultdict, deque
from starlette.websockets import WebSocketState
from datetime import datetime, timedelta
from fastapi import FastAPI, Form, WebSocket, WebSocketDisconnect, HTTPException, Header
from fastapi import BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, Column, String, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from sqlalchemy.exc import SQLAlchemyError
import bcrypt

app = FastAPI()

# ---- Database bootstrap (PostgreSQL preferred, fallback to SQLite) ----
DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    # Probe PostgreSQL then fallback silently to SQLite for local dev
    try:
        DATABASE_URL = "postgresql://postgres:password@localhost:5432/minicolab"
        test_engine = create_engine(DATABASE_URL)
        test_engine.connect()
        test_engine.dispose()
    except Exception:
        DATABASE_URL = "sqlite:///./minicolab.db"

try:
    if DATABASE_URL.startswith("sqlite"):
        engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
    else:
        engine = create_engine(DATABASE_URL)
    
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base = declarative_base()
    
    print(f"Using database: {DATABASE_URL}")
    
except Exception as e:
    print(f"Database connection failed: {e}")
    DATABASE_URL = "sqlite:///./minicolab.db"
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base = declarative_base()
    print(f"Fallback to SQLite: {DATABASE_URL}")

# ---- ORM Models ----
class UserContainer(Base):
    __tablename__ = "user_containers"
    
    username = Column(String, primary_key=True, index=True)
    container_id = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    # Per-login session identifier to disambiguate concurrent/rapid re-logins
    try:
        session_id = Column(String, index=True, nullable=True)
    except Exception:
        pass
    # Per-user storage quota in bytes (default 50MB). Added retroactively for legacy DBs.
    try:
        from sqlalchemy import Integer
        quota_bytes = Column(Integer, default=50 * 1024 * 1024)
    except Exception:
        pass

# Create tables if absent
Base.metadata.create_all(bind=engine)

from sqlalchemy import inspect, text

def _ensure_quota_column():  # idempotent
    try:
        insp = inspect(engine)
        if 'user_containers' not in insp.get_table_names():
            return
        cols = [c['name'] for c in insp.get_columns('user_containers')]
        if 'quota_bytes' in cols:
            # Backfill NULLs just in case
            with engine.begin() as conn:
                conn.execute(text("UPDATE user_containers SET quota_bytes = 52428800 WHERE quota_bytes IS NULL"))
            return
        with engine.begin() as conn:
            if engine.dialect.name == 'sqlite':
                conn.execute(text("ALTER TABLE user_containers ADD COLUMN quota_bytes INTEGER DEFAULT 52428800"))
            else:  # PostgreSQL / others
                conn.execute(text("ALTER TABLE user_containers ADD COLUMN quota_bytes BIGINT DEFAULT 52428800"))
            conn.execute(text("UPDATE user_containers SET quota_bytes = 52428800 WHERE quota_bytes IS NULL"))
        print("Quota column ensured/migrated successfully.")
    except Exception as e:
        print(f"[QuotaMigrationWarning] Could not ensure quota column: {e}")

_ensure_quota_column()

def _ensure_session_column():  # idempotent
    try:
        insp = inspect(engine)
        if 'user_containers' not in insp.get_table_names():
            return
        cols = [c['name'] for c in insp.get_columns('user_containers')]
        if 'session_id' in cols:
            return
        with engine.begin() as conn:
            # session_id is a nullable string column used to track per-login sessions
            if engine.dialect.name == 'sqlite':
                conn.execute(text("ALTER TABLE user_containers ADD COLUMN session_id VARCHAR"))
            else:
                conn.execute(text("ALTER TABLE user_containers ADD COLUMN session_id VARCHAR"))
        print("Session column ensured/migrated successfully.")
    except Exception as e:
        print(f"[SessionMigrationWarning] Could not ensure session_id column: {e}")

_ensure_session_column()

# ---- Admin authentication model (single admin user) ----
from sqlalchemy import Integer as _IntType

class AdminAuth(Base):
    __tablename__ = "admin_auth"
    username = Column(String, primary_key=True)
    password_hash = Column(String, nullable=False)
    failed_count = Column(_IntType, default=0)
    window_start = Column(DateTime, nullable=True)
    locked_until = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

# Ensure new tables are created (idempotent)
Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ---- DB helpers ----
def get_user_container(db: Session, username: str):
    return db.query(UserContainer).filter(UserContainer.username == username).first()

def create_user_container(db: Session, username: str, container_id: str, session_id: str | None = None):
    # Default quota 50MB
    sid = session_id or uuid.uuid4().hex
    db_user = UserContainer(username=username, container_id=container_id, quota_bytes=50 * 1024 * 1024, session_id=sid)
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    return db_user

def update_user_container(db: Session, username: str, container_id: str, session_id: str | None = None):
    db_user = db.query(UserContainer).filter(UserContainer.username == username).first()
    if db_user:
        db_user.container_id = container_id
        db_user.updated_at = datetime.utcnow()
        # Rotate session on container change
        try:
            db_user.session_id = session_id or uuid.uuid4().hex
        except Exception:
            pass
        # Leave quota unchanged
        db.commit()
        db.refresh(db_user)
    return db_user

def delete_user_container(db: Session, username: str):
    db_user = db.query(UserContainer).filter(UserContainer.username == username).first()
    if db_user:
        db.delete(db_user)
        db.commit()
        return True
    return False

# ---- CORS ----
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = docker.from_env()

BASE_WORKDIR = "./user_code"
os.makedirs(BASE_WORKDIR, exist_ok=True)

SHELL_PIDS: dict[str, dict[str, int | str]] = {}
SHELL_PIDS_LOCK = asyncio.Lock()

# Active terminal WebSocket connections (for forced closure on logout)
TERMINAL_CONNECTIONS: dict[str, set[WebSocket]] = {}
TERMINAL_CONNECTIONS_LOCK = asyncio.Lock()


def _sanitize_username_for_pid(username: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", username)


def _pid_file_path(username: str) -> str:
    return f"/tmp/mc_shell_{_sanitize_username_for_pid(username)}.pid"

# ---- Admin token (stateless HMAC) ----
# Format: b64(expiry).b64(random16).b64(HMAC_SHA256(expiry.random16))
# Keeps validation O(1) with no storage.

ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")
ADMIN_TOKEN_TTL = 60 * 60 * 8  # 8 hours
ADMIN_SECRET = os.getenv("ADMIN_SECRET") or uuid.uuid4().hex  # ephemeral secret if not provided

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

def _b64url_decode(data: str) -> bytes:
    pad = '=' * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)

def _issue_admin_token() -> str:
    expiry = int(time.time()) + ADMIN_TOKEN_TTL
    rid = uuid.uuid4().hex[:16]
    unsigned = f"{expiry}.{rid}"
    sig = hmac.new(ADMIN_SECRET.encode(), unsigned.encode(), hashlib.sha256).digest()
    token = f"{_b64url(str(expiry).encode())}.{_b64url(rid.encode())}.{_b64url(sig)}"
    return token

def _validate_admin(token: str | None):
    if not token:
        raise HTTPException(status_code=401, detail="Missing admin token")
    try:
        parts = token.split('.')
        if len(parts) != 3:
            raise ValueError("bad parts")
        expiry_s = _b64url_decode(parts[0]).decode()
        rid = _b64url_decode(parts[1]).decode()  # not used except for signature binding
        sig_supplied = _b64url_decode(parts[2])
        unsigned = f"{expiry_s}.{rid}".encode()
        sig_expected = hmac.new(ADMIN_SECRET.encode(), unsigned, hashlib.sha256).digest()
        if not hmac.compare_digest(sig_supplied, sig_expected):
            raise ValueError("signature mismatch")
        expiry = int(expiry_s)
        if time.time() > expiry:
            raise HTTPException(status_code=401, detail="Expired admin token")
    except HTTPException:
        # Re-raise explicitly set HTTPException
        raise
    except Exception as e:  # noqa: BLE001
        print(f"[ADMIN_AUTH] Invalid token structure/reason: {e}")
        raise HTTPException(status_code=401, detail="Invalid admin token")

# Seed admin credentials in DB if missing
def _ensure_admin_seed():
    db = None
    try:
        db = SessionLocal()
        rec = db.query(AdminAuth).filter(AdminAuth.username == 'admin').first()
        if rec is None:
            # Hash ADMIN_PASSWORD env value
            pw_bytes = (os.getenv("ADMIN_PASSWORD", "admin123")).encode("utf-8")
            pw_hash = bcrypt.hashpw(pw_bytes, bcrypt.gensalt(rounds=12)).decode("utf-8")
            admin = AdminAuth(username='admin', password_hash=pw_hash, failed_count=0, window_start=None, locked_until=None)
            db.add(admin)
            db.commit()
            print("[AdminSeed] Admin credentials seeded from ADMIN_PASSWORD env.")
    except Exception as e:
        print(f"[AdminSeedWarning] Failed to seed admin credentials: {e}")
    finally:
        try:
            if db:
                db.close()
        except Exception:
            pass

_ensure_admin_seed()

async def _container_stats_safe(container):
    """Return container (cpu%, mem_usage, mem_limit, mem%, status); tolerate transient errors."""
    cpu_percent = 0.0
    mem_usage = 0
    mem_limit = 0
    mem_percent = 0.0
    status = "unknown"
    try:
        await asyncio.to_thread(container.reload)
        status = container.status
        raw = await asyncio.to_thread(container.stats, stream=False)
        # Memory
        mem_usage = int(raw.get('memory_stats', {}).get('usage') or 0)
        mem_limit = int(raw.get('memory_stats', {}).get('limit') or 0)
        if mem_limit > 0:
            mem_percent = (mem_usage / mem_limit) * 100.0
        # CPU calculation (docker formula simplified)
        cpu_stats = raw.get('cpu_stats', {})
        precpu_stats = raw.get('precpu_stats', {})
        total_usage = cpu_stats.get('cpu_usage', {}).get('total_usage', 0)
        pre_total_usage = precpu_stats.get('cpu_usage', {}).get('total_usage', 0)
        system_cpu = cpu_stats.get('system_cpu_usage', 0)
        pre_system_cpu = precpu_stats.get('system_cpu_usage', 0)
        cpu_delta = total_usage - pre_total_usage
        system_delta = system_cpu - pre_system_cpu
        online_cpus = cpu_stats.get('online_cpus') or len(cpu_stats.get('cpu_usage', {}).get('percpu_usage') or []) or 1
        if cpu_delta > 0 and system_delta > 0:
            cpu_percent = (cpu_delta / system_delta) * online_cpus * 100.0
    except Exception:
        pass
    return cpu_percent, mem_usage, mem_limit, mem_percent, status

def _dir_size(path: str) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                fp = os.path.join(root, f)
                total += os.path.getsize(fp)
            except OSError:
                continue
    return total


async def _store_shell_pid(container, username: str, container_id: str) -> int | None:
    pid_file = _pid_file_path(username)
    # NOTE (performance fix): Previously we retried 40 times regardless of exit_code, causing
    # ~60s delays in admin stats when no terminal (and thus no pid file) existed. We now break
    # immediately if the pid file is missing (exit_code != 0). This makes the "no terminal yet"
    # path O(1) instead of O(N * exec_run latency).
    for _ in range(8):  # a few quick retries only when file might be about to appear
        try:
            res = await asyncio.to_thread(container.exec_run, ["bash", "-lc", f"cat {pid_file}"], demux=False)
        except Exception:
            break
        output = getattr(res, "output", b"")
        exit_code = getattr(res, "exit_code", 1)
        if exit_code != 0:
            # File absent; no interactive shell has started. Abort early.
            break
        if isinstance(output, (bytes, bytearray)):
            text = output.decode("utf-8", errors="ignore").strip()
            if text:
                try:
                    pid = int(text.splitlines()[-1].strip())
                except ValueError:
                    pid = None
                if pid and pid > 0:
                    async with SHELL_PIDS_LOCK:
                        SHELL_PIDS[username] = {"pid": pid, "pid_file": pid_file, "container_id": container_id}
                    return pid
        await asyncio.sleep(0.1)
    return None


async def _ensure_shell_pid(container, username: str, container_id: str) -> int | None:
    async with SHELL_PIDS_LOCK:
        entry = SHELL_PIDS.get(username)
        if entry and entry.get("container_id") == container_id:
            pid_val = entry.get("pid")
            if isinstance(pid_val, int) and pid_val > 0:
                return pid_val
    # Attempt pid file read (supports app restarts)
    pid = await _store_shell_pid(container, username, container_id)
    return pid


async def _collect_jobs(container, username: str, container_id: str):
    shell_pid = await _ensure_shell_pid(container, username, container_id)
    if not shell_pid:
        return None, [], {}, {}
    try:
        res = await asyncio.to_thread(
            container.exec_run,
            ["bash", "-lc", "ps -eo pid,ppid,pcpu,pmem,etimes,cmd --no-headers"],
            demux=False,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error listing jobs: {e}") from e
    output = getattr(res, "output", b"")
    exit_code = getattr(res, "exit_code", 1)
    if exit_code != 0 or not isinstance(output, (bytes, bytearray)):
        raise HTTPException(status_code=500, detail="Failed to read process table")
    lines = output.decode("utf-8", errors="ignore").splitlines()
    proc_map: dict[int, dict[str, object]] = {}
    children: dict[int, list[int]] = defaultdict(list)
    for line in lines:
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        try:
            pid = int(parts[0])
            ppid = int(parts[1])
            cpu = float(parts[2]) if parts[2] != 'nan' else 0.0
            mem = float(parts[3]) if parts[3] != 'nan' else 0.0
            elapsed = int(parts[4])
            cmd = parts[5].strip()
        except Exception:
            continue
        proc_map[pid] = {
            "ppid": ppid,
            "cpu": round(cpu, 2),
            "mem": round(mem, 2),
            "elapsed": elapsed,
            "cmd": cmd,
        }
        children[ppid].append(pid)

    jobs: list[dict[str, object]] = []
    visited: set[int] = set()
    queue: deque[int] = deque(children.get(shell_pid, []))
    while queue:
        current = queue.popleft()
        if current in visited:
            continue
        visited.add(current)
        info = proc_map.get(current)
        if not info:
            continue
        jobs.append({
            "pid": current,
            "command": info["cmd"],
            "cpu_percent": info["cpu"],
            "mem_percent": info["mem"],
            "elapsed_seconds": info["elapsed"],
        })
        queue.extend(children.get(current, []))

    # Hide idle base shell; include only if the user replaced it (exec python, node, etc.).
    shell_info = proc_map.get(shell_pid)
    base_shell_names = {"bash", "/bin/bash", "sh", "/bin/sh"}
    if shell_info:
        cmd_text = str(shell_info.get("cmd", "")).strip()
        leading = cmd_text.split()[0] if cmd_text else ""
        if leading and leading not in base_shell_names:
            jobs.append({
                "pid": shell_pid,
                "command": f"{cmd_text} (shell)",
                "cpu_percent": shell_info.get("cpu", 0.0),
                "mem_percent": shell_info.get("mem", 0.0),
                "elapsed_seconds": shell_info.get("elapsed", 0),
            })

    return shell_pid, jobs, proc_map, children

@app.post("/admin/login")
async def admin_login(password: str = Form(...)):
    """Admin login backed by DB-stored bcrypt hash and lockout policy.
    Allow up to 5 failed attempts within a 1-hour window; on the 5th failure,
    lock login for 1 hour.
    """
    db = next(get_db())
    try:
        rec = db.query(AdminAuth).filter(AdminAuth.username == 'admin').first()
        # If somehow missing, seed from env
        if rec is None:
            pw_hash = bcrypt.hashpw(ADMIN_PASSWORD.encode('utf-8'), bcrypt.gensalt(rounds=12)).decode('utf-8')
            rec = AdminAuth(username='admin', password_hash=pw_hash, failed_count=0, window_start=None, locked_until=None)
            db.add(rec)
            db.commit()
            db.refresh(rec)

        now = datetime.utcnow()
        if rec.locked_until and now < rec.locked_until:
            minutes = max(1, int((rec.locked_until - now).total_seconds() // 60))
            raise HTTPException(status_code=429, detail=f"Too many failed attempts. Try again in {minutes} minute(s).")

        ok = False
        try:
            ok = bcrypt.checkpw(password.encode('utf-8'), rec.password_hash.encode('utf-8'))
        except Exception:
            ok = False

        if ok:
            rec.failed_count = 0
            rec.window_start = None
            rec.locked_until = None
            rec.updated_at = now
            db.commit()
            token = _issue_admin_token()
            return {"token": token, "ttl_seconds": ADMIN_TOKEN_TTL}
        else:
            one_hour = timedelta(hours=1)
            if (rec.window_start is None) or (now - rec.window_start > one_hour):
                rec.window_start = now
                rec.failed_count = 1
            else:
                rec.failed_count = (rec.failed_count or 0) + 1
            if rec.failed_count >= 5:
                rec.locked_until = now + one_hour
            rec.updated_at = now
            db.commit()
            if rec.locked_until and now < rec.locked_until:
                minutes = max(1, int((rec.locked_until - now).total_seconds() // 60))
                raise HTTPException(status_code=429, detail=f"Account locked due to too many failed attempts. Try again in {minutes} minute(s).")
            raise HTTPException(status_code=401, detail="Invalid password")
    finally:
        db.close()

@app.get("/admin/stats")
async def admin_stats(x_admin_token: str | None = Header(default=None)):
    _validate_admin(x_admin_token)
    return await _gather_admin_stats()


async def _gather_admin_stats():
    """Aggregate per‑user container stats + jobs for admin HTTP / WS paths."""
    db = next(get_db())
    try:
        users = db.query(UserContainer).all()
        user_rows = []
        total_cpu = 0.0
        total_mem_usage = 0
        total_mem_limit = 0
        for uc in users:
            try:
                container = await asyncio.to_thread(client.containers.get, uc.container_id)
            except Exception:
                user_rows.append({
                    "username": uc.username,
                    "container_id": uc.container_id,
                    "status": "missing",
                    "cpu_percent": 0.0,
                    "mem_usage": 0,
                    "mem_percent": 0.0,
                    "workspace_size": _dir_size(os.path.join(BASE_WORKDIR, uc.session_id)) if getattr(uc, 'session_id', None) and os.path.exists(os.path.join(BASE_WORKDIR, uc.session_id)) else 0,
                    "quota_bytes": getattr(uc, 'quota_bytes', 50 * 1024 * 1024),
                    "shell_pid": None,
                    "jobs": []
                })
                continue
            cpu_percent, mem_usage, mem_limit, mem_percent, status = await _container_stats_safe(container)
            total_cpu += cpu_percent
            total_mem_usage += mem_usage
            total_mem_limit += mem_limit
            size = 0
            if getattr(uc, 'session_id', None):
                workspace_dir = os.path.join(BASE_WORKDIR, uc.session_id)
                size = await asyncio.to_thread(_dir_size, workspace_dir) if os.path.exists(workspace_dir) else 0
            shell_pid = None
            jobs: list[dict[str, object]] = []
            if status == "running":
                try:
                    shell_pid, jobs, _, _ = await _collect_jobs(container, uc.username, uc.container_id)
                except Exception:
                    # Non-fatal; leave jobs empty
                    shell_pid = None
            user_rows.append({
                "username": uc.username,
                "container_id": uc.container_id,
                "status": status,
                "cpu_percent": round(cpu_percent, 2),
                "mem_usage": mem_usage,
                "mem_percent": round(mem_percent, 2),
                "workspace_size": size,
                "quota_bytes": getattr(uc, 'quota_bytes', 50 * 1024 * 1024),
                "shell_pid": shell_pid,
                "jobs": jobs
            })
        overall = {
            "containers": len(users),
            "total_cpu_percent": round(total_cpu, 2),
            "total_mem_usage": total_mem_usage,
            "total_mem_percent": round((total_mem_usage / total_mem_limit) * 100.0, 2) if total_mem_limit > 0 else 0.0
        }
        return {"overall": overall, "users": user_rows}
    finally:
        db.close()


@app.websocket("/admin/ws/stats")
async def admin_stats_ws(websocket: WebSocket):
    # Accept token via query ?token=... or header x-admin-token
    token = websocket.query_params.get("token") or websocket.headers.get("x-admin-token")
    print(f"[WS_STATS] Incoming connection token={token}")
    try:
        _validate_admin(token)
    except HTTPException:
        # Need to accept before close in FastAPI
        await websocket.accept()
        await websocket.close(code=4401)
        print(f"[WS_STATS] Closed unauthorized connection token={token}")
        return
    await websocket.accept()
    print(f"[WS_STATS] Authorized WebSocket token={token}")
    update_interval = 2
    try:
        while True:
            try:
                # Re-validate token (no silent refresh)
                _validate_admin(token)
                if websocket.application_state == WebSocketState.DISCONNECTED or websocket.client_state == WebSocketState.DISCONNECTED:
                    break
                data = await _gather_admin_stats()
                try:
                    await websocket.send_json(data)
                except RuntimeError as re:  # Starlette raises if send after close
                    if 'close message has been sent' in str(re):
                        print("[WS_STATS] Suppressed send after close (graceful)")
                        break
                    raise
            except HTTPException:
                # Auth expired / invalid mid-stream
                await websocket.close(code=4401)
                return
            except Exception as e:  # noqa: BLE001 broad for resilience
                # Log server-side for diagnostics
                print(f"[WS_STATS_ERROR] {e}")
                # Attempt to notify client (non-fatal) – ignore if send fails
                try:
                    await websocket.send_json({"error": "stats_error", "detail": str(e)})
                except Exception:
                    pass
            await asyncio.sleep(update_interval)
    except (WebSocketDisconnect, asyncio.CancelledError):
        print("[WS_STATS] Client disconnected or server shutdown")
        return

@app.post("/admin/stop-user")
async def admin_stop_user(username: str = Form(...), x_admin_token: str | None = Header(default=None)):
    _validate_admin(x_admin_token)
    db = next(get_db())
    try:
        uc = get_user_container(db, username)
        if not uc:
            raise HTTPException(status_code=404, detail="User not found")
    # Attempt container removal
        try:
            container = await asyncio.to_thread(client.containers.get, uc.container_id)
            await asyncio.to_thread(container.stop)
            await asyncio.to_thread(container.remove)
        except docker.errors.NotFound:
            pass
        except Exception as e:
            print(f"Admin stop warning for {username}: {e}")
    # Delete workspace directory
        # Prefer session-based directory if record exists
        sess_based = None
        try:
            uc_rec = get_user_container(db, username)
            sess_based = getattr(uc_rec, 'session_id', None)
        except Exception:
            sess_based = None
        user_dir = os.path.join(BASE_WORKDIR, sess_based or username)
        if os.path.exists(user_dir):
            try:
                shutil.rmtree(user_dir)
            except Exception as e:
                print(f"Admin delete dir warning for {username}: {e}")
        delete_user_container(db, username)
        async with SHELL_PIDS_LOCK:
            SHELL_PIDS.pop(username, None)
        return {"message": f"User {username} resources removed"}
    finally:
        db.close()

@app.get("/admin/list-users")
async def admin_list_users(x_admin_token: str | None = Header(default=None)):
    _validate_admin(x_admin_token)
    db = next(get_db())
    try:
        users = db.query(UserContainer).all()
        return {"users": [{"username": u.username, "container_id": u.container_id, "created_at": u.created_at.isoformat(), "quota_bytes": getattr(u,'quota_bytes', 50*1024*1024)} for u in users]}
    finally:
        db.close()


@app.get("/admin/jobs")
async def admin_list_jobs(username: str, x_admin_token: str | None = Header(default=None)):
    _validate_admin(x_admin_token)
    db = next(get_db())
    try:
        uc = get_user_container(db, username)
        if not uc:
            raise HTTPException(status_code=404, detail="User not found")
        try:
            container = await asyncio.to_thread(client.containers.get, uc.container_id)
        except docker.errors.NotFound:
            raise HTTPException(status_code=404, detail="Container not found")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error accessing container: {e}") from e

        shell_pid, jobs, _, _ = await _collect_jobs(container, username, uc.container_id)
        return {
            "username": username,
            "shell_pid": shell_pid,
            "jobs": jobs
        }
    finally:
        db.close()


@app.post("/admin/kill-job")
async def admin_kill_job(
    background_tasks: BackgroundTasks,
    username: str = Form(...),
    pid: int = Form(...),
    signal_name: str = Form("TERM"),
    x_admin_token: str | None = Header(default=None)
):
    """Schedule a signal to a user process (non-blocking)."""
    _validate_admin(x_admin_token)
    allowed_signals = {"TERM", "KILL", "INT", "HUP"}
    sig = signal_name.upper()
    if sig not in allowed_signals:
        raise HTTPException(status_code=400, detail=f"Unsupported signal {signal_name}")
    db = next(get_db())
    try:
        uc = get_user_container(db, username)
        if not uc:
            raise HTTPException(status_code=404, detail="User not found")
        try:
            container = await asyncio.to_thread(client.containers.get, uc.container_id)
        except docker.errors.NotFound:
            raise HTTPException(status_code=404, detail="Container not found")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error accessing container: {e}") from e

        shell_pid, jobs, _, _ = await _collect_jobs(container, username, uc.container_id)
        if not shell_pid:
            raise HTTPException(status_code=404, detail="User terminal inactive")
        valid_pids = {job["pid"] for job in jobs}
        if pid not in valid_pids:
            raise HTTPException(status_code=404, detail="Process not found or not shell-managed")

        kill_cmd = f"kill -s {sig} {pid} 2>/dev/null || kill -{sig} {pid} 2>/dev/null"

        def _do_kill(container_id: str, cmd: str):  # runs in thread via BackgroundTasks
            try:
                cont = client.containers.get(container_id)
                cont.exec_run(["bash", "-lc", cmd], demux=False)
            except Exception as e:  # noqa: BLE001
                print(f"[KILL_JOB_WARN] Failed to send signal {sig} to {pid} in {container_id}: {e}")

        background_tasks.add_task(_do_kill, uc.container_id, kill_cmd)
        return {"message": f"Signal SIG{sig} scheduled for PID {pid}", "pid": pid, "signal": sig, "scheduled": True}
    finally:
        db.close()

@app.post("/admin/set-quota")
async def admin_set_quota(username: str = Form(...), quota_mb: int = Form(...), x_admin_token: str | None = Header(default=None)):
    """Set a user's storage quota (in MB). Minimum 50MB."""
    _validate_admin(x_admin_token)
    if quota_mb < 50:
        raise HTTPException(status_code=400, detail="Minimum quota is 50MB")
    db = next(get_db())
    try:
        uc = get_user_container(db, username)
        if not uc:
            raise HTTPException(status_code=404, detail="User not found")
        bytes_val = quota_mb * 1024 * 1024
        setattr(uc, 'quota_bytes', bytes_val)
        uc.updated_at = datetime.utcnow()
        db.commit()
        return {"message": f"Quota updated to {quota_mb}MB", "quota_bytes": bytes_val}
    finally:
        db.close()


@app.get("/quota-usage/{username}")
async def quota_usage(username: str):
    """Return storage usage & quota (frontend friendly)."""
    db = next(get_db())
    try:
        user_container = get_user_container(db, username)
        if not user_container:
            raise HTTPException(status_code=404, detail="User not logged in")
        if not getattr(user_container, 'session_id', None):
            raise HTTPException(status_code=409, detail="No active session. Please login/start container again")
        user_workdir = os.path.join(BASE_WORKDIR, user_container.session_id)
        used = _dir_size(user_workdir) if os.path.exists(user_workdir) else 0
        quota_bytes = getattr(user_container, 'quota_bytes', 50 * 1024 * 1024)
        percent = (used / quota_bytes * 100.0) if quota_bytes > 0 else 0.0
        return {
            "username": username,
            "used_bytes": used,
            "quota_bytes": quota_bytes,
            "percent_used": round(percent, 2)
        }
    finally:
        db.close()

@app.post("/auth")
async def auth(username: str = Form(...)):
    """Auth only; does NOT start container. Returns presence / running info."""
    # Do NOT create the user directory here; defer until container start so no files/dirs exist pre-image selection
    if not username or not username.strip():
        raise HTTPException(status_code=400, detail="Invalid username")

    uname = username.strip()
    db = next(get_db())
    try:
        existing = get_user_container(db, uname)
        container_running = False
        container_id = None
        if existing:
            container_id = existing.container_id
            # Check if container actually running (non-blocking via thread)
            try:
                container = await asyncio.to_thread(client.containers.get, existing.container_id)
                await asyncio.to_thread(container.reload)
                if container.status == "running":
                    container_running = True
                else:
                    # stale record, treat as not running
                    pass
            except docker.errors.NotFound:
                # Container removed externally; treat as not running
                pass
            except Exception as e:
                # Log and continue without failing auth
                print(f"Auth check warning for {uname}: {e}")
        return {
            "message": f"User {uname} authenticated",
            "username": uname,
            "has_container": container_running,
            "container_id": container_id if container_running else None
        }
    finally:
        db.close()


@app.post("/login")
async def login(username: str = Form(...)):
    """Start container if absent or stopped (legacy entrypoint)."""
    db = next(get_db())
    
    try:
        # Check if user already has a container
        existing_user = get_user_container(db, username)
        if existing_user:
            # Check if container is still running (offload docker SDK calls)
            try:
                container = await asyncio.to_thread(client.containers.get, existing_user.container_id)
                # docker-py container.status may be stale; call reload in thread
                await asyncio.to_thread(container.reload)
                if container.status == "running":
                    return {"message": f"Container already running for {username}", "container_id": existing_user.container_id, "session_id": getattr(existing_user, 'session_id', None)}
                else:
                    # Container exists but not running, remove it and create new one
                    await asyncio.to_thread(container.remove, True)
            except docker.errors.NotFound:
                # Container not found, will create new one
                pass
        # Determine session directory (use existing session_id if present, else create new)
        session_id = getattr(existing_user, 'session_id', None) if existing_user else uuid.uuid4().hex
        user_workdir = os.path.join(BASE_WORKDIR, session_id)
        os.makedirs(user_workdir, exist_ok=True)

        container = await asyncio.to_thread(
            client.containers.run,
            "mini-colab",
            tty=True,
            stdin_open=True,
            volumes={os.path.abspath(user_workdir): {"bind": "/app", "mode": "rw"}},
            detach=True,
        )

        # Store or update in database with session_id
        if existing_user:
            db_obj = update_user_container(db, username, container.id, session_id=session_id)
        else:
            db_obj = create_user_container(db, username, container.id, session_id=session_id)

        return {"message": f"Container started for {username}", "container_id": container.id, "session_id": getattr(db_obj, 'session_id', session_id)}
    
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error starting container: {str(e)}")
    finally:
        db.close()


@app.get("/images")
async def list_images():
    """List local Docker images (first tag + size + derived description)."""
    try:
        images_info = []
        images = await asyncio.to_thread(client.images.list)

        def derive_description(lbls: dict) -> str | None:
            if not lbls:
                return None
            # Common OCI / label-schema / generic keys
            preferred_keys = [
                'org.opencontainers.image.description',
                'description',
                'org.label-schema.description',
                'summary',
            ]
            for k in preferred_keys:
                if k in lbls and lbls[k]:
                    return str(lbls[k])[:280]
            # Fallback: combine title + version if available
            title_keys = [
                'org.opencontainers.image.title',
                'org.label-schema.name',
                'name'
            ]
            title = None
            for k in title_keys:
                if k in lbls and lbls[k]:
                    title = lbls[k]
                    break
            version = lbls.get('org.opencontainers.image.version') or lbls.get('version')
            if title and version:
                return f"{title} (version {version})"
            return title

        for img in images:
            tags = img.tags or ["<none>:<none>"]
            tag = tags[0]
            # docker-py sometimes exposes labels in attrs.Config.Labels or via .labels
            labels = None
            try:
                labels = getattr(img, 'labels', None) or img.attrs.get('Config', {}).get('Labels') or {}
            except Exception:
                labels = {}
            description = derive_description(labels) if labels else None
            images_info.append({
                "tag": tag,
                "id": img.short_id.split(":")[1] if ":" in img.short_id else img.short_id,
                "size": getattr(img, 'attrs', {}).get('Size', None),
                "description": description,
                "labels": labels or {}
            })
        images_info.sort(key=lambda x: x["tag"])  # deterministic order
        return {"images": images_info}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error listing images: {e}")


@app.post("/start-container")
async def start_container(username: str = Form(...), image: str = Form(...)):
    """Start (or replace) user container with selected image."""
    db = next(get_db())
    try:
        existing_user = get_user_container(db, username)
        # Remove existing container if present (allow switching images)
        if existing_user:
            try:
                old_container = await asyncio.to_thread(client.containers.get, existing_user.container_id)
                await asyncio.to_thread(old_container.remove, True)
            except docker.errors.NotFound:
                pass
            except Exception as e:
                # Non-fatal; log and continue
                print(f"Warning removing old container for {username}: {e}")

        # Determine session directory (use existing session_id if present, else create new)
        session_id = getattr(existing_user, 'session_id', None) if existing_user else uuid.uuid4().hex
        user_workdir = os.path.join(BASE_WORKDIR, session_id)
        os.makedirs(user_workdir, exist_ok=True)

        try:
            container = await asyncio.to_thread(
                client.containers.run,
                image,
                tty=True,
                stdin_open=True,
                volumes={os.path.abspath(user_workdir): {"bind": "/app", "mode": "rw"}},
                detach=True,
            )
        except docker.errors.ImageNotFound:
            raise HTTPException(status_code=404, detail=f"Image not found: {image}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error starting container from {image}: {e}")

        if existing_user:
            db_obj = update_user_container(db, username, container.id, session_id=session_id)
        else:
            db_obj = create_user_container(db, username, container.id, session_id=session_id)

        return {"message": f"Container started for {username} using {image}", "container_id": container.id, "image": image, "session_id": getattr(db_obj, 'session_id', session_id)}
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    finally:
        db.close()


@app.post("/save-file")
async def save_file(username: str = Form(...), filename: str = Form(...), code: str = Form(...)):
    """Persist file content with quota enforcement (normalized newlines)."""
    db = next(get_db())
    
    try:
        # Check if user is logged in
        user_container = get_user_container(db, username)
        if not user_container:
            raise HTTPException(status_code=404, detail="User not logged in")

        # Save code to user's directory
        user_workdir = os.path.join(BASE_WORKDIR, getattr(user_container, 'session_id', None) or username)
        os.makedirs(user_workdir, exist_ok=True)
        
        # Normalize line endings to prevent doubling
        # Replace \r\n with \n, then \r with \n to normalize all line endings
        normalized_code = code.replace('\r\n', '\n').replace('\r', '\n')
        
        filepath = os.path.join(user_workdir, filename)
        # Quota enforcement (estimate delta)
        existing_size = 0
        if os.path.exists(filepath):
            try:
                existing_size = os.path.getsize(filepath)
            except OSError:
                existing_size = 0
        new_size = len(normalized_code.encode('utf-8'))
        delta = new_size - existing_size
        # Only check if growing
        if delta > 0:
            # Get quota
            quota_bytes = getattr(user_container, 'quota_bytes', 50 * 1024 * 1024)
            current_total = _dir_size(user_workdir)
            if current_total + delta > quota_bytes:
                raise HTTPException(status_code=403, detail=f"Quota exceeded. Limit {quota_bytes} bytes")
        def _write():
            with open(filepath, "w", encoding="utf-8", newline='\n') as f:
                f.write(normalized_code)
        await asyncio.to_thread(_write)

        return {"message": f"File {filename} saved successfully"}
    
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving file: {str(e)}")
    finally:
        db.close()


@app.get("/files/{username}")
async def list_files(username: str):
    """List workspace file tree (recursive)."""
    db = next(get_db())
    
    try:
        # Check if user is logged in
        user_container = get_user_container(db, username)
        if not user_container:
            raise HTTPException(status_code=404, detail="User not logged in")
        if not getattr(user_container, 'session_id', None):
            raise HTTPException(status_code=409, detail="No active session. Please login/start container again")
        user_workdir = os.path.join(BASE_WORKDIR, user_container.session_id)
        if not os.path.exists(user_workdir):
            os.makedirs(user_workdir, exist_ok=True)
            return {"files": []}

        def build_file_tree(directory, relative_path=""):
            items = []
            try:
                for item in sorted(os.listdir(directory)):
                    item_path = os.path.join(directory, item)
                    relative_item_path = os.path.join(relative_path, item).replace("\\", "/")
                    
                    if os.path.isdir(item_path):
                        folder_item = {
                            "name": item,
                            "type": "folder",
                            "path": relative_item_path,
                            "children": build_file_tree(item_path, relative_item_path)
                        }
                        items.append(folder_item)
                    else:
                        file_item = {
                            "name": item,
                            "type": "file",
                            "path": relative_item_path,
                            "size": os.path.getsize(item_path)
                        }
                        items.append(file_item)
            except PermissionError:
                pass
            
            return items

        files = build_file_tree(user_workdir)
        return {"files": files}
    
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error listing files: {str(e)}")
    finally:
        db.close()


@app.post("/create-file")
async def create_file(username: str = Form(...), filepath: str = Form(...), file_type: str = Form(...)):
    """Create empty file or folder (path normalized)."""
    db = next(get_db())
    
    try:
        # Check if user is logged in
        user_container = get_user_container(db, username)
        if not user_container:
            raise HTTPException(status_code=404, detail="User not logged in")
        if not getattr(user_container, 'session_id', None):
            raise HTTPException(status_code=409, detail="No active session. Please login/start container again")
        user_workdir = os.path.join(BASE_WORKDIR, user_container.session_id)
        # Normalize to forward slashes and strip leading slash
        safe_rel = filepath.replace("\\", "/").lstrip("/")
        full_path = os.path.join(user_workdir, safe_rel)
        
        # Security check: ensure path is within user directory
        if not os.path.abspath(full_path).startswith(os.path.abspath(user_workdir)):
            raise HTTPException(status_code=400, detail="Invalid file path")

        if file_type == "folder":
            os.makedirs(full_path, exist_ok=True)
            return {"message": f"Folder created: {filepath}"}
        else:
            # Create parent directories if they don't exist
            parent_dir = os.path.dirname(full_path)
            os.makedirs(parent_dir, exist_ok=True)

            # Create empty file
            with open(full_path, "w", encoding="utf-8") as f:
                f.write("")

            return {"message": f"File created: {filepath}"}
    
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error creating {file_type}: {str(e)}")
    finally:
        db.close()


@app.post("/rename-file")
async def rename_file(username: str = Form(...), old_path: str = Form(...), new_path: str = Form(...)):
    """Rename file / folder (safe path checks)."""
    db = next(get_db())
    
    try:
        # Check if user is logged in
        user_container = get_user_container(db, username)
        if not user_container:
            raise HTTPException(status_code=404, detail="User not logged in")
        if not getattr(user_container, 'session_id', None):
            raise HTTPException(status_code=409, detail="No active session. Please login/start container again")
        user_workdir = os.path.join(BASE_WORKDIR, user_container.session_id)
        old_full_path = os.path.join(user_workdir, old_path.lstrip("/"))
        new_full_path = os.path.join(user_workdir, new_path.lstrip("/"))
        
        # Security check: ensure paths are within user directory
        if not (os.path.abspath(old_full_path).startswith(os.path.abspath(user_workdir)) and 
                os.path.abspath(new_full_path).startswith(os.path.abspath(user_workdir))):
            raise HTTPException(status_code=400, detail="Invalid file path")

        if not os.path.exists(old_full_path):
            raise HTTPException(status_code=404, detail="File or folder not found")

        if os.path.exists(new_full_path):
            raise HTTPException(status_code=400, detail="File or folder already exists")

        os.rename(old_full_path, new_full_path)
        return {"message": f"Renamed {old_path} to {new_path}"}
    
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error renaming: {str(e)}")
    finally:
        db.close()


@app.post("/delete-file")
async def delete_file(username: str = Form(...), filepath: str = Form(...)):
    """Delete file / folder recursively if directory."""
    db = next(get_db())
    
    try:
        # Check if user is logged in
        user_container = get_user_container(db, username)
        if not user_container:
            raise HTTPException(status_code=404, detail="User not logged in")
        if not getattr(user_container, 'session_id', None):
            raise HTTPException(status_code=409, detail="No active session. Please login/start container again")
        user_workdir = os.path.join(BASE_WORKDIR, user_container.session_id)
        full_path = os.path.join(user_workdir, filepath.lstrip("/"))
        
        # Security check: ensure path is within user directory
        if not os.path.abspath(full_path).startswith(os.path.abspath(user_workdir)):
            raise HTTPException(status_code=400, detail="Invalid file path")

        if not os.path.exists(full_path):
            raise HTTPException(status_code=404, detail="File or folder not found")

        if os.path.isdir(full_path):
            shutil.rmtree(full_path)
            return {"message": f"Folder deleted: {filepath}"}
        else:
            os.remove(full_path)
            return {"message": f"File deleted: {filepath}"}
    
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error deleting: {str(e)}")
    finally:
        db.close()


from fastapi import UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse


@app.post("/upload-files")
async def upload_files(username: str = Form(...), files: list[UploadFile] = File(...), target_path: str = Form("/")):
    """Upload multiple files with aggregate quota check."""
    db = next(get_db())
    
    try:
        # Check if user is logged in
        user_container = get_user_container(db, username)
        if not user_container:
            raise HTTPException(status_code=404, detail="User not logged in")
        if not getattr(user_container, 'session_id', None):
            raise HTTPException(status_code=409, detail="No active session. Please login/start container again")
        user_workdir = os.path.join(BASE_WORKDIR, user_container.session_id)
        target_dir = os.path.join(user_workdir, target_path.lstrip("/"))
        
        # Security check: ensure path is within user directory
        if not os.path.abspath(target_dir).startswith(os.path.abspath(user_workdir)):
            raise HTTPException(status_code=400, detail="Invalid target path")

        os.makedirs(target_dir, exist_ok=True)
        uploaded_files = []

        # Quota check: pre-read all sizes first
        quota_bytes = getattr(user_container, 'quota_bytes', 50 * 1024 * 1024)
        current_total = _dir_size(user_workdir)
        incoming_total = 0
        file_blobs: list[tuple[str, bytes]] = []
        for file in files:
            if file.filename:
                content = await file.read()
                incoming_total += len(content)
                file_blobs.append((file.filename, content))
        if current_total + incoming_total > quota_bytes:
            raise HTTPException(status_code=403, detail="Quota exceeded by upload")
        # Write after passing check
        for fname, content in file_blobs:
            file_path = os.path.join(target_dir, fname)
            with open(file_path, "wb") as buffer:
                buffer.write(content)
            uploaded_files.append(fname)

        return {"message": f"Uploaded {len(uploaded_files)} files", "files": uploaded_files}
    
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error uploading files: {str(e)}")
    finally:
        db.close()


@app.get("/download-file/{username}")
async def download_file(username: str, filepath: str):
    """Download single file."""
    db = next(get_db())
    
    try:
        # Check if user is logged in
        user_container = get_user_container(db, username)
        if not user_container:
            raise HTTPException(status_code=404, detail="User not logged in")
        if not getattr(user_container, 'session_id', None):
            raise HTTPException(status_code=409, detail="No active session. Please login/start container again")
        user_workdir = os.path.join(BASE_WORKDIR, user_container.session_id)
        full_path = os.path.join(user_workdir, filepath.lstrip("/"))
        
        # Security check: ensure path is within user directory
        if not os.path.abspath(full_path).startswith(os.path.abspath(user_workdir)):
            raise HTTPException(status_code=400, detail="Invalid file path")

        if not os.path.exists(full_path) or os.path.isdir(full_path):
            raise HTTPException(status_code=404, detail="File not found")

        filename = os.path.basename(full_path)
        return FileResponse(
            path=full_path,
            filename=filename,
            media_type='application/octet-stream'
        )
    
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error downloading file: {str(e)}")
    finally:
        db.close()


@app.get("/download-folder/{username}")
async def download_folder(username: str, folderpath: str):
    """Zip + download a folder (or entire workspace if root)."""
    db = next(get_db())

    try:
        # Check if user is logged in
        user_container = get_user_container(db, username)
        if not user_container:
            raise HTTPException(status_code=404, detail="User not logged in")

        user_workdir = os.path.join(BASE_WORKDIR, getattr(user_container, 'session_id', None) or username)
        # If folderpath is empty or root-like, zip the whole user directory
        normalized = (folderpath or '').lstrip("/")
        full_path = os.path.join(user_workdir, normalized)

        # Security check: ensure path is within user directory
        if not os.path.abspath(full_path).startswith(os.path.abspath(user_workdir)):
            raise HTTPException(status_code=400, detail="Invalid folder path")

        if not os.path.exists(full_path) or not os.path.isdir(full_path):
            raise HTTPException(status_code=404, detail="Folder not found")

        # Create an in-memory ZIP of the folder
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk(full_path):
                for file in files:
                    abs_file = os.path.join(root, file)
                    rel_path = os.path.relpath(abs_file, full_path)
                    zipf.write(abs_file, arcname=rel_path)
        zip_buffer.seek(0)

        # Name zip as username if zipping entire workspace, else folder name
        folder_name = username if (normalized == '' or normalized == '.' or normalized == '/') else os.path.basename(full_path.rstrip(os.sep))
        headers = {
            'Content-Disposition': f'attachment; filename="{folder_name}.zip"'
        }
        return StreamingResponse(zip_buffer, media_type='application/zip', headers=headers)

    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error downloading folder: {str(e)}")
    finally:
        db.close()


@app.get("/read-file/{username}")
async def read_file(username: str, filepath: str):
    """Read text file (normalized newlines)."""
    db = next(get_db())
    
    try:
        # Check if user is logged in
        user_container = get_user_container(db, username)
        if not user_container:
            raise HTTPException(status_code=404, detail="User not logged in")

        user_workdir = os.path.join(BASE_WORKDIR, getattr(user_container, 'session_id', None) or username)
        full_path = os.path.join(user_workdir, filepath.lstrip("/"))
        
        # Security check: ensure path is within user directory
        if not os.path.abspath(full_path).startswith(os.path.abspath(user_workdir)):
            raise HTTPException(status_code=400, detail="Invalid file path")

        if not os.path.exists(full_path) or os.path.isdir(full_path):
            raise HTTPException(status_code=404, detail="File not found")

        with open(full_path, "r", encoding="utf-8") as f:
            content = f.read()
            # Normalize line endings when reading to ensure consistency
            content = content.replace('\r\n', '\n').replace('\r', '\n')

        return {"content": content, "filename": os.path.basename(full_path)}
    
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File is not a text file")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error reading file: {str(e)}")
    finally:
        db.close()




@app.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket):
    """Interactive terminal over WebSocket (one bash per user)."""
    await websocket.accept()
    websocket_closed = False
    db = next(get_db())
    container = None
    user_container_record = None
    username: str | None = None
    
    try:
        data = await websocket.receive_json()
        username = data.get("username")

        if not username:
            await websocket.send_text("Error: Username not provided")
            websocket_closed = True
            await websocket.close()
            return

        # Get user container from database
        user_container_record = get_user_container(db, username)
        if not user_container_record:
            await websocket.send_text("Error: User not logged in")
            websocket_closed = True
            await websocket.close()
            return

        container = client.containers.get(user_container_record.container_id)

    # Register WebSocket for forced closure on logout
        async with TERMINAL_CONNECTIONS_LOCK:
            s = TERMINAL_CONNECTIONS.get(username)
            if s is None:
                s = set()
                TERMINAL_CONNECTIONS[username] = s
            s.add(websocket)
        pid_file = _pid_file_path(username)

    # Start interactive bash; record PID asynchronously
        exec_instance = container.client.api.exec_create(
            container.id,
            ["/bin/bash", "-lc", f"echo $$ > {pid_file}; exec bash"],
            stdin=True,
            tty=True,
            environment=["TERM=xterm-256color"],
        )
        sock = container.client.api.exec_start(exec_instance["Id"], tty=True, socket=True)
        asyncio.create_task(_store_shell_pid(container, username, user_container_record.container_id))

        loop = asyncio.get_event_loop()

        async def read_output():
            nonlocal websocket_closed
            while True:
                try:
                    output = await loop.run_in_executor(None, sock.recv, 1024)
                    if not output:
                        break
                    decoded = output.decode("utf-8", errors="ignore")
                    if decoded and not websocket_closed:
                        await websocket.send_text(decoded)
                except Exception:
                    break

        async def write_input():
            nonlocal websocket_closed
            while True:
                try:
                    msg = await websocket.receive_json()
                    if "input" in msg:
                        sock.send(msg["input"].encode("utf-8"))
                except WebSocketDisconnect:
                    websocket_closed = True
                    break
                except Exception:
                    websocket_closed = True
                    break

        await asyncio.gather(read_output(), write_input())

    except WebSocketDisconnect:
        websocket_closed = True
        print("Terminal WebSocket disconnected")
    except Exception as e:
        if not websocket_closed:
            await websocket.send_text(f"Terminal Error: {str(e)}")
    finally:
        # Close database connection
        db.close()
        # Deregister connection
        if username:
            async def _deregister():
                async with TERMINAL_CONNECTIONS_LOCK:
                    s = TERMINAL_CONNECTIONS.get(username)
                    if s and websocket in s:
                        s.discard(websocket)
                        if not s:
                            TERMINAL_CONNECTIONS.pop(username, None)
            asyncio.create_task(_deregister())
    # Remove stored shell PID (best effort)
        if username and container is not None and user_container_record is not None:
            async def _cleanup_pid() -> None:
                async with SHELL_PIDS_LOCK:
                    entry = SHELL_PIDS.get(username)
                    if entry and entry.get("container_id") == user_container_record.container_id:
                        SHELL_PIDS.pop(username, None)
                try:
                    await asyncio.to_thread(container.exec_run, ["bash", "-lc", f"rm -f {_pid_file_path(username)}"], demux=False)
                except Exception:
                    pass
            asyncio.create_task(_cleanup_pid())
        # Only close websocket if not already closed
        if not websocket_closed:
            try:
                await websocket.close()
            except Exception:
                # Ignore errors when closing
                pass


@app.post("/logout")
async def logout(background_tasks: BackgroundTasks, username: str = Form(...)):
    """Logout: schedule container removal + workspace deletion + close terminals."""
    db = next(get_db())

    def do_cleanup(u_name: str, container_id: str | None, session_id: str | None):
        """Background cleanup: stop/remove old container and delete workspace IF the user hasn't re-logged in.
        Safety: If the user logs back in before this runs (with a new container_id), we must NOT delete their record or files.
        """
        # Stop/remove the specific container we knew at logout time (best effort)
        try:
            if container_id:
                try:
                    container = client.containers.get(container_id)
                    container.stop()
                    container.remove()
                except docker.errors.NotFound:
                    pass
                except Exception as e:
                    print(f"Cleanup warning for {u_name}: {e}")
        except Exception as e:
            print(f"Background cleanup (container) error for {u_name}: {e}")

        # DB-aware guard: only delete workspace and/or DB record if no newer session exists
        db2 = None
        try:
            db2 = SessionLocal()
            current = get_user_container(db2, u_name)

            # Regardless of re-login, it's safe to delete the old session's workspace (session-scoped dirs)
            if session_id:
                target_dir = os.path.join(BASE_WORKDIR, session_id)
                if os.path.exists(target_dir):
                    try:
                        shutil.rmtree(target_dir)
                    except Exception as e:
                        print(f"File cleanup warning for {u_name}: {e}")

            # Finally, remove the DB record only if it still points at the old session
            if current is None or (session_id is not None and getattr(current, 'session_id', None) == session_id):
                try:
                    delete_user_container(db2, u_name)
                except Exception:
                    pass
        except Exception as e:
            print(f"Background cleanup (db) error for {u_name}: {e}")
        finally:
            try:
                if db2:
                    db2.close()
            except Exception:
                pass

    try:
        # Idempotent: proceed even if record already missing
        user_container = get_user_container(db, username)
        container_id = user_container.container_id if user_container else None
        session_id = getattr(user_container, 'session_id', None) if user_container else None

        # Remove DB record early so username can be reused quickly
        if user_container:
            delete_user_container(db, username)

        # Schedule cleanup in background
        background_tasks.add_task(do_cleanup, username, container_id, session_id)

        # Close active terminals for this user (best effort)
        async def close_terminals(u_name: str):
            # Snapshot under lock then close outside lock
            conns: list[WebSocket] = []
            async with TERMINAL_CONNECTIONS_LOCK:
                s = TERMINAL_CONNECTIONS.get(u_name)
                if s:
                    conns = list(s)
                    TERMINAL_CONNECTIONS.pop(u_name, None)
            for ws in conns:
                try:
                    if ws.application_state != WebSocketState.DISCONNECTED:
                        await ws.send_text("Logout: terminal connection closing")
                        await ws.close()
                except Exception:
                    pass
        # Fire and forget
        asyncio.create_task(close_terminals(username))

        return {"message": f"Logout scheduled for {username}"}

    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error scheduling logout: {str(e)}")
    finally:
        db.close()


if __name__ == "__main__":
    import uvicorn
    print("Database URL:", DATABASE_URL)
    print("Starting Mini-Colab server...")
    uvicorn.run(app, host="0.0.0.0", port=8000)
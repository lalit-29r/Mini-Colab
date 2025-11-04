# miniColab

A lightweight, container-backed coding environment with a React frontend and a FastAPI backend. Each user gets an isolated Docker container with their own session-scoped workspace mounted into the container. Includes an in-browser editor (Monaco), terminal (WebSocket), file explorer, and an admin dashboard.

## Features
- Per-user Docker container with mounted workspace (`./backend/user_code/<session_id>` → `/app` in the container)
- Monaco-based code editor with:
  - Unsaved-change tracking and save/run confirmation
  - Keyboard shortcuts: Ctrl/Cmd+S (Save), Ctrl/Cmd+Enter (Run)
  - Auto-focus when creating a new file
- File explorer with create/rename/delete, upload/download, Delete-key shortcut, and quota meter
- Terminal via WebSocket (xterm)
- Admin portal:
  - Stats (CPU/Mem/Jobs), stop user, set quota, list/kill jobs
  - Secure admin login (bcrypt hash stored in DB) + lockout policy (3 failures/hour → locked for 1 hour)

## Prerequisites
- Windows 10/11 (others work too) with PowerShell
- Docker Desktop installed and running
- Python 3.10+ (3.11 works)
- Node.js 18 LTS (recommended) and npm 8+
- Optional: PostgreSQL (otherwise SQLite is used automatically)

## Project structure
```
Mini-Colab/
  README.md
  LICENSE
  CONTRIBUTING.md
  .gitignore

  backend/                 # FastAPI server
    app.py
    requirements.txt

  docker/                  # Curated Docker image definitions
    Image_1/
      Dockerfile
      environment.yml
    Image_2/
      Dockerfile
      environment.yml
    Image_3/
      Dockerfile
      environment.yml
    Image_4/
      Dockerfile
      environment.yml

  frontend/                # React app (TypeScript)
    package.json
    tsconfig.json
    public/
      index.html
      manifest.json
      icons/
        filetypes/
    src/
      App.tsx
      App.css
      index.tsx
      index.css
      react-app-env.d.ts
      components/
        AdminDashboard.tsx
        AdminDashboard.css
        AdminLoginForm.tsx
        AdminStatCard.tsx
        CodeEditor.tsx
        CodeEditor.css
        ConfirmDialog.tsx
        ConfirmDialog.css
        FileExplorer.tsx
        FileExplorer.css
        Icons.tsx
        ImageSelection.tsx
        ImageSelection.css
        LoginForm.tsx
        LoginForm.css
        Notifications.tsx
        Notifications.css
        QuotaEditorDialog.tsx
        Terminal.tsx
        Terminal.css
      services/
        api.ts
```

Notes:
- `backend/user_code/` is created at runtime for each session and is ignored by git.
- `frontend/build/` (if present) is a generated production build and is typically not committed.
- If `DATABASE_URL` isn’t set, a local SQLite DB file is created on first run (ignored by git).

## Quick start (local dev)

Open two terminals (one for backend, one for frontend).

### 1) Backend (FastAPI)
```powershell
cd .\backend
# (Optional) Create and activate a virtual environment
python -m venv .venv
. .\.venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt

# Optional: configure environment variables (PowerShell examples)
# $env:DATABASE_URL = "postgresql://<user>:<pass>@localhost:5432/minicolab"
# $env:ADMIN_PASSWORD = "change-me"
# $env:ADMIN_SECRET = "your-random-secret"

# Start the API server
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```
Notes:
- If `DATABASE_URL` isn’t set, the backend will use a local SQLite file `./backend/minicolab.db`.
- On first run, the admin password is seeded from `ADMIN_PASSWORD` (default `admin123`). Change it in production.

### 2) Frontend (React)
```powershell
cd .\frontend
npm install
npm start
```
The app will open at http://localhost:3000 and talk to the backend at http://localhost:8000.

## Docker setup (build provided images)
This repository includes a `docker/` directory with ready-to-build images. Build any (or all) and then select the tag in the app’s Image Selection.

```powershell
# From project root
# Build Image_1
docker build -t minicolab/image1 -f docker/Image_1/Dockerfile docker/Image_1

# Build Image_2
docker build -t minicolab/image2 -f docker/Image_2/Dockerfile docker/Image_2

# Build Image_3
docker build -t minicolab/image3 -f docker/Image_3/Dockerfile docker/Image_3

# Build Image_4
docker build -t minicolab/image4 -f docker/Image_4/Dockerfile docker/Image_4
```

Notes:
- If the Dockerfiles use Conda via `environment.yml`, the build may take longer on first run.
- After building, the images will appear in the frontend’s image list (sorted by tag). Choose e.g. `minicolab/image1`.
- You can also use official images (e.g., `python:3.11-slim`) alongside your custom ones.

## Usage walkthrough
1. Open the app at http://localhost:3000
2. Enter a username and continue. You’ll go to image selection.
3. Pick a local Docker image that contains the tools you need. Examples:
   - Python only: `python:3.11-slim`
   - C/C++ + Python: a custom image with `gcc/g++` and Python installed
4. Once the container starts, use the file explorer to create or open files.
5. Edit, save (Ctrl/Cmd+S), and run (Ctrl/Cmd+Enter) from the editor. Output shows in the terminal.
6. Use the terminal for ad-hoc commands (pip install, gcc, etc.).
7. When done, logout to stop the container and clean up the session workspace.

## Admin portal
- Click “Admin Login” on the login screen.
- Default password comes from `ADMIN_PASSWORD` (default `admin123`). Change it with the env var before first start.
- Security features:
  - Password stored as a bcrypt hash in DB (table `admin_auth`).
  - Lockout: 3 failed attempts within 1 hour locks login for 1 hour.
  - Admin session uses a stateless HMAC token with a fixed TTL.

## Environment variables
- `DATABASE_URL` (optional): PostgreSQL URL (e.g., `postgresql://user:pass@localhost:5432/minicolab`).
- `ADMIN_PASSWORD` (optional): Admin password used to seed the hashed record on first run (default `admin123`).
- `ADMIN_SECRET` (optional): Secret for signing admin tokens (randomized by default; set in production).

## Docker images for runtime
- The app lists local Docker images for users to choose (including those built from `docker/`).
- Ensure you have at least one suitable image pulled or built locally. Examples:
  ```powershell
  docker pull python:3.11-slim
  docker pull gcc:13
  docker images | findstr minicolab
  ```
- The workspace is mounted at `/app`. Your run commands in the editor use `/app/<relative_path>`.

## Common issues & troubleshooting
- Docker not running: Start Docker Desktop before launching the backend.
- Image not found: Pull the image (e.g., `docker pull python:3.11-slim`) or build your own.
- Windows path mounts: Docker Desktop handles Windows paths; ensure the `backend` folder is shared (Docker Desktop → Settings → Resources → File sharing).
- Admin lockout: If locked due to failed attempts, wait 1 hour or reset the DB record (delete or update row in `admin_auth`).
- Port conflicts: Change `--port` for backend or use a different frontend port via `PORT=3001` (set in PowerShell: `$env:PORT=3001; npm start`).

## Production notes (high level)
- Prefer PostgreSQL over SQLite: set `DATABASE_URL`.
- Put FastAPI behind a reverse proxy (Nginx) and serve the React build as static files.
- Configure HTTPS at the proxy, forward `/api` and `/ws` to FastAPI.
- Harden admin credentials and set a strong `ADMIN_SECRET`.

## GitHub: initialize and push
```powershell
# From the project root
git init
git add .
git commit -m "Initial commit: miniColab"
git branch -M main
# Set your GitHub repo as remote (provided by you)
git remote add origin https://github.com/lalit-29r/Mini-Colab.git
git push -u origin main
```

Repository: https://github.com/lalit-29r/Mini-Colab

## Contributing
Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines (branch/PR flow, coding style, and checks).

## License
This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

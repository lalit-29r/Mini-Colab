# Contributing to miniColab

Thanks for your interest in contributing! This guide explains how to set up your environment, propose changes, and follow our conventions.

## Development setup

1. Backend (FastAPI):
   - Python 3.10+
   - From `backend/`:
     ```powershell
     python -m venv .venv
     . .\.venv\Scripts\Activate.ps1
     pip install -r requirements.txt
     uvicorn app:app --reload --port 8000
     ```
2. Frontend (React):
   - Node 18 LTS + npm
   - From `frontend/`:
     ```powershell
     npm install
     npm start
     ```
3. Docker:
   - Docker Desktop running
   - Optionally build local images from `docker/`:
     ```powershell
     docker build -t minicolab/image1 -f docker/Image_1/Dockerfile docker/Image_1
     ```

## Branch & commit style
- Create feature branches from `main`: `feat/<short-name>`, `fix/<short-name>`
- Write clear commits; prefix scope when helpful: `feat(editor): add Ctrl+Enter run`
- Keep PRs focused and small when possible

## Coding conventions
- Frontend: TypeScript, React hooks, ESLint clean (no warnings), small components
- Backend: FastAPI, keep endpoints small, prefer helpers when logic grows
- Security: avoid plaintext secrets; never commit `.env`, DB files, or `backend/user_code/`

## Testing & checks
- Frontend: ensure ESLint passes and app compiles
- Backend: run the server; smoke-test key flows (login, file ops, run, admin login)
- If you add dependencies, pin sensible versions and update docs if needed

## Submitting PRs
1. Fill in a short PR description (what/why, screenshots if UI changes)
2. Link any related issues
3. Ensure:
   - [ ] README updated if behavior changes
   - [ ] No secrets committed
   - [ ] Builds clean (frontend & backend)

## Code of conduct
Be respectful and constructive. We welcome first-time contributors. If behavior is not aligned with a safe, inclusive environment, maintainers may intervene.

## License
By contributing, you agree that your contributions are licensed under the MIT License.

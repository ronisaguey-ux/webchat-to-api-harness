# Handoff Document — Authentication Analysis Phase

## 1. Current Task & Progress

**Task:** Perform a white-box authentication analysis on the Helpotron application (http://host.docker.internal:5173) as part of a pentesting workflow. Identify and document logical flaws in authentication mechanisms, session management, and credential handling. Produce an exploitation queue for the downstream Exploitation phase.

**Current Progress:**
- Reconnaissance deliverables were read but found to have empty sections (no endpoint inventory, no role architecture, no authentication flow details provided).
- Source code analysis has begun: read `server/auth.py` and `server/main.py` (the main FastAPI application).
- Identified several authentication-related components and potential vulnerability areas.
- **Mid-action:** Was preparing to analyze `server/security.py` and `server/ratelimit.py` to complete the authentication picture when context limit was reached.

## 2. Files Created or Changed

**None created or changed.** This is a read-only analysis phase; no files have been modified. The following files have been read:

- `/repos/helpotron/.shannon/deliverables/recon_deliverable.md` — Reconnaissance report (mostly empty placeholders; no useful endpoint/role data provided).
- `/repos/helpotron/server/auth.py` — JWT authentication utilities, token verification, admin dependency.
- `/repos/helpotron/server/main.py` — Main FastAPI application with all routes, session management, rate limiting, and authentication endpoints.

## 3. Key Decisions & Rationale

- **Decision:** Prioritize source code analysis over relying on the reconnaissance report, since the report contained no populated sections. The application's authentication logic must be derived from code inspection.
- **Decision:** Focus on the following authentication mechanisms observed in `main.py`:
  - Session cookie-based authentication with `SESSION_COOKIE_NAME`
  - JWT token generation (`create_jwt_token`)
  - Login endpoint (`/api/login`) with password verification, 2FA support, and rate limiting
  - Signup endpoint (`/api/signup`) with captcha enforcement and password strength validation
  - Logout endpoint (`/api/logout`) with session deletion
  - Admin guard (`require_admin_user`, `require_admin`)
  - CSRF protection middleware
  - Rate limiting middleware (per-IP and per-user)
  - Security headers middleware
  - Memory budget middleware

## 4. Commands Run & Important Results

- `list_dir /repos/helpotron` — Confirmed repository structure; found `server/` directory containing auth-related files.
- `list_dir /repos/helpotron/server` — Listed server modules; identified `auth.py`, `security.py`, `ratelimit.py`, `csrf.py`, `captcha.py`, and main application file.
- `read_file /repos/helpotron/server/auth.py` — Revealed JWT verification using HS256, `require_admin_user` dependency that checks `role == "admin"`.
- `read_file /repos/helpotron/server/main.py` — Revealed full authentication flow:
  - Session cookies with `HttpOnly`, `Secure` (conditional on `request.url.is_secure`), `SameSite=Lax`.
  - Login uses password hashing (`verify_password`), rate limiting (`auth_limiter`), 2FA (TOTP/email/SMS), and ban enforcement.
  - Signup includes captcha, rate limiting (20/hr per IP), password strength validation.
  - Session token is a JWT with 24h expiry? (Need to verify exact expiry in `security.py`).
  - No explicit session rotation observed in login flow (session ID not regenerated on login).
  - Logout invalidates server-side session via `SessionStore.delete_session`.

## 5. Remaining Steps (In Order)

1. **Read `server/security.py`** — Verify session store implementation, JWT expiry, session rotation logic, password hashing details, and admin checks.
2. **Read `server/ratelimit.py`** — Understand rate limiting implementation details (per-IP, per-user, sliding windows) and any bypass possibilities.
3. **Read `server/csrf.py`** — Confirm CSRF protection implementation and token validation.
4. **Read `server/captcha.py`** — Understand Turnstile integration and bypass mechanisms.
5. **Read `server/auth_2fa.py`** — Review 2FA implementation, code generation, and verification.
6. **Systematically analyze each authentication endpoint** against the methodology:
   - Transport & caching (HTTPS enforcement, HSTS, cache headers)
   - Rate limiting / CAPTCHA (login, signup, reset, token endpoints)
   - Session management (cookie flags, rotation, logout, timeouts)
   - Token properties (entropy, expiry, invalidation)
   - Session fixation (pre-login vs post-login session IDs)
   - Password policy (strength, storage, default credentials)
   - Login/signup responses (user enumeration, error messages)
   - Recovery & logout (reset tokens, server-side invalidation)
7. **Document findings** — Classify each vulnerability with confidence rating, source-to-sink trace, and exploitation hypothesis.
8. **Submit deliverables:**
   - `set_findings_summary` (Section 1-2)
   - `set_strategic_intelligence` (Section 3)
   - `set_safe_vectors` (Section 4)
   - `set_blind_spots` (Section 5)
   - `submit_exploitation_queue` (structured vulnerability list)

## 6. Mid-Action Status

**Was about to call:** `read_file /repos/helpotron/server/security.py`

**Preliminary observations from `main.py` that need verification:**
- Session cookie `Secure` flag depends on `request.url.is_secure` — need to confirm this works correctly with reverse proxies (Cloudflared).
- Session expiry appears to be 7 days (`SessionStore._session_expiry`) — need to verify absolute vs sliding window.
- No obvious session ID rotation on login — potential session fixation vector.
- JWT token returned in login response (`create_jwt_token`) — need to verify expiry and algorithm.
- Rate limiting uses in-memory store (`ratelimit.limiter`) — potential race conditions or bypass via IP spoofing headers (`cf-connecting-ip`, `x-forwarded-for`).
- Password hashing uses `hash_password` and `verify_password` from `security.py` — need to verify algorithm (bcrypt? pbkdf2?).
- Admin check in `auth.py` uses `getattr(user, "role", None) != "admin"` — case-sensitive? Potential role enumeration?

## 7. Notes for Next Session

- The reconnaissance report is effectively empty — the analysis must be entirely source-code driven.
- The application is a FastAPI + SQLite stack with JWT + session cookies.
- Focus on the authentication endpoints: `/api/login`, `/api/signup`, `/api/logout`, `/api/me`, `/api/csrf`, `/api/public-config`.
- Check for OAuth/SSO flows (none observed in `main.py` router includes).
- Password reset/recovery flows are in `routes_recovery.py` — need to read that as well.
- 2FA is implemented with TOTP, email, and SMS — need to verify security of code generation and delivery.
- The `captcha_required()` function in `captcha.py` likely toggles based on config — need to understand enforcement logic.

**Critical files to read in order:**
1. `server/security.py`
2. `server/ratelimit.py`
3. `server/csrf.py`
4. `server/captcha.py`
5. `server/auth_2fa.py`
6. `server/routes_recovery.py`
7. `server/config.py` (for auth-related config values)

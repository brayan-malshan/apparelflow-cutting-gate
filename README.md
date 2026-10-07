# ApparelFlow - Cutting Operations & Gatekeeper Verification Terminal

Full-stack implementation of the Webtezza practical challenge. A cutting batch can only reach the
Sewing Queue after a Cutting Verifier has counted every component and none is short. The rule is
enforced on the server, not just in the UI.

- **Backend:** Node.js + Express, SQLite (`better-sqlite3`), JWT auth, bcrypt password hashes
- **Frontend:** React 18 + Vite (served by Express in production, one deployable service)
- **Tests:** Vitest + Supertest (`npm test`)

**Live demo:** https://apparelflow-cutting-gate.onrender.com
(Free hosting: the first load after idle can take about a minute, and demo data resets when the instance restarts. Demo logins are in the table below.)

## Demo credentials

| Role | Email | Password |
|------|-------|----------|
| Cutting Supervisor | `supervisor@apparelflow.demo` | `Cut#Super2026` |
| Cutting Verifier | `verifier@apparelflow.demo` | `Verify#QC2026` |
| Sewing Supervisor | `sewing@apparelflow.demo` | `Sew#Floor2026` |

The login page has a demo credential panel, and a role switcher stays in the top bar after sign-in.

> **Demo-only credentials.** The brief requires a visible credential panel, so these passwords are shipped in the
> client bundle on purpose. They only unlock seeded demo accounts. Never reuse this pattern for real users.

## Run locally

```bash
npm run install:all     # root + client dependencies
npm run build           # builds client/dist
npm start               # http://localhost:4000 (API + UI)
```

Development with hot reload: `npm run dev:server` and `npm run dev:client` (Vite on :5173 proxies `/api`).
Tests: `npm test`.

Environment variables: `PORT` (default 4000), `JWT_SECRET` (**must be set in production**; if it is missing the server
generates a random one and every restart logs everyone out), `DATABASE_FILE` (default `server/data/apparelflow.db`),
`TRUST_PROXY` (proxy hops to trust, default `1`, which is correct for Render, Railway and Fly). The database is created and seeded on first boot (3 users,
2 recipes). Seeding is idempotent.

## Architecture

```
server/src/domain.js   pure rules: traffic light, wastage %, state transitions, input validators
server/src/db.js       schema, constraints, triggers
server/src/seed.js     users + recipes (REC-BL01, REC-CT02)
server/src/app.js      Express app: auth, RBAC middleware, routes (createApp(db) factory for tests)
client/src/views/      Login, Supervisor, Verifier (terminal), Sewing
```

### State machine

```
CUTTING_IN_PROGRESS --submit--> PENDING_VERIFICATION --approve--> VERIFIED --start--> SEWING_STARTED
                                       |  ^
                                    reject |  resubmit after re-cut (counts cleared)
                                       v  |
                                      REJECTED
```

Transitions live in `domain.js` and are checked by every route. Illegal moves return `409`.
SQLite triggers add a second line of defence: a VERIFIED order can only move to SEWING_STARTED,
`verification_logs` rejects UPDATE and DELETE (append-only audit trail), and `verification_items` are frozen once the
batch leaves the QC station.

### Server-side security

| Rule | Where | Response |
|------|-------|----------|
| Role checks on every route | `requireRole(...)` middleware | `403` |
| Role read from the database, never from the JWT claims | `authenticate` | forged claims have no effect |
| Approve with any RED, missing or uncounted component | `evaluateGate` inside the approve transaction | `422` |
| Verifier id and timestamp | `req.user.id` and the server clock; request body is ignored | - |
| Gate recomputes from raw counts, never from stored status flags | `evaluateGate` | tampered flags cannot pass |
| Sewing queue isolation | literal `WHERE o.status = 'VERIFIED'` in SQL, no request parameter reaches it | other statuses unreachable (`404` on direct id access) |
| Reject without a reason (5-500 chars after trim) | reject route | `422` |
| Strict input validation, no coercion | `domain.js` validators | negatives, decimals, strings, empty bodies get `422` |
| Login rate limit: 10 **failed** attempts per minute per client IP + email (successful logins and role switching never count). `trust proxy` is set so each visitor behind the host's proxy has their own IP | `app.js` | `429` |
| Helmet headers, 50 kb body limit | `app.js` | headers / `413` |

### Database schema (SQLite)

| Table | Columns | Notes |
|-------|---------|-------|
| `users` | id, email (unique), password_hash, role (CHECK), full_name, created_at | |
| `recipes` | id, recipe_code (unique), name, category, std_fabric_yards, wastage_cap | |
| `recipe_components` | id, recipe_id -> recipes, component_name, pieces_per_garment, image_url | |
| `cutting_orders` | id, order_no (unique), recipe_id, target_qty, fabric_roll_id, actual_fabric_yds, status (CHECK), rejection_note, created_by -> users, created_at, updated_at | state guard triggers |
| `verification_items` | id, order_id, component_id, expected_qty, actual_qty, status (GREEN/YELLOW/RED) | unique (order, component) |
| `verification_logs` | id, order_id, verifier_id, decision, rejection_note, wastage_pct, variance_json, timestamp | immutable via triggers |

`variance_json` freezes the per-component variance at decision time, so the sewing view always shows
exactly what the verifier saw.

### Business rules

- Expected component count = target qty x pieces per garment.
- Expected fabric = target qty x std yards per piece.
- Fabric wastage % = ((actual - expected) / expected) x 100, rounded to 2 decimals, stored in `verification_logs`.
- Traffic light: GREEN equal, YELLOW excess (batch may proceed), RED shortage (approval blocked).
- Wastage above the recipe cap is flagged in the UI but does not block approval (the brief does not make it a blocker).
- Fabric yards accept up to 2 decimals; all piece counts and quantities are whole numbers only.

## Endpoints

```
POST /api/auth/login              GET  /api/auth/me
GET  /api/recipes                 (supervisor, verifier)
POST /api/orders                  (supervisor)  body: recipe_id, target_qty, fabric_roll_id, actual_fabric_yds, submit?
PUT  /api/orders/:id              (supervisor)  edit a draft (CUTTING_IN_PROGRESS only)
GET  /api/orders, /api/orders/:id (supervisor, verifier - verifier never sees drafts)
POST /api/orders/:id/submit       (supervisor)  submit a draft, or resubmit a rejected batch
PUT  /api/orders/:id/counts       (verifier)    body: { counts: [{ component_id, actual_qty }] }
POST /api/orders/:id/approve      (verifier)
POST /api/orders/:id/reject       (verifier)    body: { note }
GET  /api/sewing/queue            (sewing)      status = 'VERIFIED' only
GET  /api/sewing/in-progress      (sewing)
POST /api/sewing/:id/start        (sewing)
```

### Try the hard stop with cURL

```bash
B=http://localhost:4000
TOKEN=$(curl -s -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"supervisor@apparelflow.demo","password":"Cut#Super2026"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# Supervisor tries to approve -> 403
curl -i -X POST $B/api/orders/1/approve -H "Authorization: Bearer $TOKEN"
```

Log in as the verifier the same way, save a short count, and `POST /api/orders/1/approve` returns `422 GATE_BLOCKED`.

## Deployment

The app is a single Node service (API + built client) with a SQLite file, so it needs **a persistent volume**.
On a host with an ephemeral disk the file is wiped on every restart or redeploy and all orders, counts and audit logs vanish.

### Render (config included)

1. Push this repo to GitHub.
2. In Render choose **New > Blueprint**, select the repo. `render.yaml` creates a web service on the **starter** plan
   with a 1 GB disk mounted at `/var/data`, `DATABASE_FILE=/var/data/apparelflow.db`, a generated `JWT_SECRET`, and a
   health check on `/api/health`. (Persistent disks are not available on the free plan.)
3. When the deploy is live, open the URL, sign in with each demo role, create an order, then trigger a manual
   redeploy and confirm the order is still there.

If the disk is missing or not writable the server does not crash: it logs a warning and falls back to a local file,
which is **not** persistent. Check the deploy logs for `Falling back to` after your first deploy.

### Other hosts

Railway or Fly.io work the same way: attach a volume, mount it (for example at `/data`) and set
`DATABASE_FILE=/data/apparelflow.db`, `JWT_SECRET=<long random string>`. Build with
`npm install && npm install --prefix client && npm run build`, start with `npm start`.

## Pre-submission checklist

- [ ] `npm test` passes and `npm run build` succeeds
- [ ] Live URL opens, all three demo roles sign in
- [ ] Create an order, refresh the page, data is still there; redeploy, data is still there
- [ ] Verifier: enter 98 of 100 cuffs, Approve is disabled; `curl` the approve endpoint and get `422`
- [ ] Supervisor `curl` to approve gets `403`; Sewing sees only verified batches
- [ ] Click every input and dropdown, text is dark and legible; check the verifier screen at 375 px width
- [ ] `AI_OPTIMIZATION_REPORT.md` read through and edited so it matches your own experience

## Accessibility and contrast

Inputs, selects and textareas set explicit dark text (`#111827`) on white, including disabled, focus, autofill and
`<option>` states, with `color-scheme: light` so dark-mode browsers cannot invert them. Errors are shown inline with
`role="alert"`, and status is never conveyed by colour alone (every light has a text label).

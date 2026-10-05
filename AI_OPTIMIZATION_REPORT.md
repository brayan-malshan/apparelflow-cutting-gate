# AI Optimization Report

## 1. Tools & Prompting

- **Claude (Anthropic)** was the only AI tool used. I gave it the full assessment brief and asked it to build the
  complete application. It generated the first version of the SQLite schema and triggers, the Express routes, the
  React views, the stylesheet, the Vitest suite and the README.
- The first version was then reviewed by running the app, calling the API with cURL (including tampered tokens, bad ids
  and malformed bodies), and reading the code against the brief's rubric. The problems found were sent back to Claude with a
  request for fixes, plus tests for each fix.

## 2. Flawed / Broken AI Code

Each item below was found during that review.

1. **Login rate limiter locked out everyone behind the host's proxy.** The server never set `trust proxy`, so on a
   platform like Render every visitor shares one IP. The limiter allowed 15 logins per minute, and it counted
   *successful* logins too, including every click on the demo role switcher. In review, 18 login attempts
   with different `X-Forwarded-For` values returned `429` after 12. One evaluator switching personas could have blocked the
   next evaluator.
2. **Deployment config would have lost data (and might not boot).** `render.yaml` used the free plan and only contained a
   comment about a persistent disk. SQLite on an ephemeral disk is wiped on every restart, which breaks the "data must
   never vanish" requirement. `DATABASE_FILE` also pointed at `/var/data`, which does not exist without a disk, so the
   boot-time `mkdir` could throw and crash the server.
3. **Expired sessions left the user stuck.** The client had no handling for `401` responses. After the 8 hour token expired,
   every screen showed an error but the user was never sent back to the login page.
4. **Screens never refreshed.** The verifier and sewing views loaded data once. A newly submitted batch would not appear
   until a manual page reload, which does not match the brief's "real-time" wording.
5. **Counts were protected only by the API.** The database froze the audit log and the order status, but
   `verification_items` could still be modified by any code path that bypassed the routes.
6. **Drafts could not be corrected.** A saved `CUTTING_IN_PROGRESS` order could only be submitted unchanged, so a typo in the
   roll id or yards meant creating a new order.
7. **Mobile layout was thin.** There was a single `@media` rule, and the verifier table overflowed on a phone.

## 3. Human Refactoring

- **Rate limiting:** set `trust proxy` (configurable with `TRUST_PROXY`), count only failed attempts, and key the limit on
  client IP plus email so one user cannot lock out another.
- **Persistence:** `render.yaml` now declares a disk on a paid plan and the server falls back with a loud warning instead of
  crashing when the configured path is unusable. The README states plainly that a free ephemeral disk loses data.
- **Triggers:** added database triggers that freeze `verification_items` once a batch is decided. This forced a change in
  the resubmit route: the status must be set back to `PENDING_VERIFICATION` *before* the old counts are cleared, otherwise
  the trigger (correctly) blocks the reset.
- **Client:** `401` handling returns to the login page with a notice, an 8 second poll plus a Refresh button on the
  supervisor, verifier and sewing screens, draft editing (endpoint and form), and stacked-card tables below 640 px.
- **Earlier hardening carried over from the first review:** number inputs replaced by text inputs with strict parsing
  (type=number accepts `e`, `+`, `-` and decimals), validators that never coerce (`"10"`, `2.5`, `-1` all get `422`),
  an approve route that ignores the request body, and the user's role being re-read from the database instead of trusted
  from the JWT claim.
- Every fix above has an automated test (20 tests in total).

## 4. Defensive Architecture

- **One state machine:** `TRANSITIONS` in `server/src/domain.js` is the single source of truth and every mutating route
  checks it (`409` on an illegal move).
- **Database as the second line of defence:** triggers stop a VERIFIED order moving backwards, make `verification_logs`
  append-only, and freeze `verification_items` after a decision.
- **Server-side RBAC:** `requireRole` on every route returns `403`; missing or invalid tokens get `401`. Identity and role
  come from the database row, never from the request body or token claims.
- **Approval is one transaction:** re-read the order, recompute every traffic light from the raw counts (stored flags are
  not trusted), reject with `422` if any component is RED or uncounted, then write the audit row and change the status.
  The verifier id and timestamp come from the session and the server clock.
- **Sewing isolation:** the queue SQL contains the literal `status = 'VERIFIED'`; no query parameter can widen it, and
  direct access to a non-verified order returns `404`.
- **Tests:** `server/test/gate.test.js` covers the five required rules plus tampering and validation;
  `server/test/hardening.test.js` covers the rate limit behind a proxy, frozen counts, draft editing, boot fallback and
  the 98-of-100 cuffs shortage case.

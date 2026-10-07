# AI Optimization Report

## 1. Tools & Prompting

- **Claude built and fixed the app. ChatGPT was used once to review the first version.**
- I gave Claude the full assessment brief and asked it to build the application. It produced the first version of the SQLite schema and triggers, the Express routes, the React views, the stylesheet, the Vitest suite and the README.
- I then ran the app and sent Claude a list of problems that ChatGPT found when I asked it to review that first version. I asked Claude to fix each problem and to add an automated test for each fix.
- I used Claude again for deployment: the Render configuration, the build command and the environment variables.

## 2. Flawed / Broken AI Code

1. **Login rate limiter would lock evaluators out behind a proxy.** The server never set `trust proxy`, so on Render all visitors share one IP. The limit was 15 logins a minute and it counted successful logins too, including every click on the demo role switcher. The ChatGPT review reported a `429` after 12 attempts with different `X-Forwarded-For` values.
2. **Deployment config would lose data and might not boot.** The first `render.yaml` used a free plan with only a comment about a persistent disk, and pointed `DATABASE_FILE` at `/var/data`, which does not exist without a disk. SQLite on an ephemeral disk is wiped on restart, which breaks the persistence requirement, and creating the folder at boot could throw.
3. **Expired sessions left the user stuck.** The client had no handling for `401`. After the 8-hour token expired, every screen showed an error and never returned to login.
4. **Screens never refreshed.** The verifier and sewing views loaded once, so newly submitted batches did not appear until a manual reload.
5. **Counts were only protected by the API.** The database froze the audit log and order status, but `verification_items` could still be changed by any code path that bypassed the routes.
6. **Drafts could not be corrected.** A saved draft could only be submitted unchanged, so a typo meant creating a new order.
7. **Mobile layout was thin.** There was one media rule and the verifier table overflowed on a phone.
8. **A security header could break plain-http use.** While checking response headers, Claude noticed Helmet's default Content-Security-Policy includes `upgrade-insecure-requests`, which makes browsers try to load assets over https on `http://localhost`. I did not confirm in a browser that it breaks the page. I removed that one directive and kept the rest of the policy.

## 3. Human Refactoring

Claude wrote the code for these fixes. I reviewed each change, ran the tests, and decided what to fix and how it should behave.

- **Rate limiting:** `trust proxy` is now set (configurable with `TRUST_PROXY`), only failed logins count, and the limit is keyed on client IP plus email.
- **Persistence:** the server no longer crashes if the configured database path is unusable; it logs a loud warning and falls back to a local file. The README states plainly that the free hosting plan loses data on restart.
- **Database triggers:** added triggers that freeze `verification_items` once a batch is decided. This forced a fix in the resubmit route: the status has to move back to `PENDING_VERIFICATION` before the old counts are cleared, otherwise the trigger (correctly) blocks the reset.
- **Client:** a `401` now returns to the login page with a notice; the supervisor, verifier and sewing screens poll every 8 seconds and have a Refresh button; drafts can be edited; tables become stacked cards below 640 px.
- **Inputs:** number inputs were replaced by text inputs with strict parsing, because `type="number"` accepts `e`, `+`, `-` and decimals. The server validators never coerce, so `"10"`, `2.5` and `-1` all return `422`.
- **Deployment:** Render's default build command (`npm install; npm run build`) does not install the client dependencies, so I replaced it with `npm install && npm install --prefix client && npm run build`.
- **Tests:** every fix above has an automated test (20 tests in total).

## 4. Defensive Architecture

- **One state machine:** `TRANSITIONS` in `server/src/domain.js` is the single source of truth. Every mutating route checks it and returns `409` on an illegal move.
- **Database as the second line of defence:** triggers stop a VERIFIED order moving backwards, make `verification_logs` append-only, and freeze `verification_items` after a decision.
- **Server-side RBAC:** `requireRole` is applied to every route and returns `403`; a missing or invalid token returns `401`. User and role are read from the database row, never from the request body or the token claims.
- **Approval is one transaction:** the order is re-read, every traffic light is recomputed from the raw counts (stored flags are not trusted), and `422` is returned if any component is RED or uncounted. Only then is the audit row written and the status changed. The verifier ID and timestamp come from the session and the server clock.
- **Sewing isolation:** the queue SQL contains the literal `status = 'VERIFIED'`. No query parameter can widen it, and direct access to a non-verified order returns `404`.
- **Tests:** `server/test/gate.test.js` covers the five required rules plus tampering and validation. `server/test/hardening.test.js` covers the rate limit behind a proxy, frozen counts, draft editing, the boot fallback and the 98-of-100 cuffs shortage case.
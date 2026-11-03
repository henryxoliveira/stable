# Stable: context for AI agents (Claude Code, Codex, etc.)

Stable is a class prototype for Santa Clara University (two-person team). It lets SCU students find,
compare, and apply as roommate groups for on- and off-campus housing. Landlords manage listings
and review applications, and Stable admins approve landlords and listings. It is **not**
connected to real SCU systems. Listing data is seeded by the team (never scraped). Never use SCU
logos or Bronco marks. The palette (pine `#2F5D50`, hay `#E8B04B`, cream `#F6F1E7`) and the icon are original.

The README is the only project documentation and gets graded. Keep it accurate.

## Rules for AI agents (non-negotiable)

1. **Never commit secrets**, real credentials, `.env`, or service-account keys. Only `.env.example` (placeholders) is tracked.
2. **Every route requires login** unless it is on the public allow-list: `/login`, `/register`,
   static files, `/healthz`. Public routes live ONLY in `src/routes/public.routes.js`. Everything else is mounted after `requireLogin` in `src/app.js`.
3. **Every data access goes through the authorization layer** (`src/middleware/auth.js` for roles/status,
   `src/middleware/authorize.js` for record ownership, plus query-level filters in services). Every new
   feature ships with a test proving an unauthorized user gets 403/404. Unapproved listings are
   filtered **in the query**, not the UI.
4. **Schema changes = a new Prisma migration** (`npm run db:migrate -- --name x`). Never edit an applied
   migration. Never drop or recreate tables. Never run `prisma migrate reset` or `prisma db push` against production.
5. **Never store uploads on the local filesystem** in production: multer memory storage, then GCS.
6. **Plain JavaScript only** (ES modules, no TypeScript). Readable, commented code with JSDoc on non-obvious
   functions. Both team members must be able to explain every line in the presentation.
7. **Small, PR-sized changes.** Run `npm test` and `npm run lint` before finishing. Update README.md when behavior changes.
8. Validate all input with **zod** (`validate()` middleware). Use Prisma only. Raw SQL only via tagged `$queryRaw`
   templates, never string concatenation.

## Commands

```bash
npm install                # also runs `prisma generate`
npm run dev                # local server with reload (reads .env), http://localhost:8080
npm test                   # Vitest + Supertest; migrates DATABASE_URL_TEST first, TRUNCATEs it per test
npm run lint               # ESLint
npm run format             # Prettier (npm run format:check in CI)
npm run db:migrate -- --name <change>   # create + apply a migration (dev DB only)
npm run db:deploy          # apply pending migrations (prod / Cloud Run Job)
npm run db:test:deploy     # apply migrations to the test DB
npm run seed:admin         # create first admin from ADMIN_EMAIL/ADMIN_PASSWORD (idempotent)
npm run seed:demo          # demo listings (placeholder)
```

## Stack

- Node.js 22 LTS, Express 5 (async errors reach the error handler automatically), EJS views + a little vanilla JS.
- Neon Postgres via **Prisma 6** (`prisma-client-js`; v7's generator emits TypeScript, so don't upgrade casually).
- Auth: express-session + connect-pg-simple (`session` table, created by migration), argon2id hashes.
  Session id is regenerated on login. Logout calls `req.session.destroy()` and clears the `stable.sid` cookie.
- Security: helmet (default CSP: scripts from `'self'` only, so vendor Leaflet into `src/public/vendor/`
  or extend the CSP deliberately), csrf-sync (synchronizer token in session: forms send `_csrf`, fetch sends
  `x-csrf-token`), express-rate-limit on login/register, zod validation.
- Cookies: HttpOnly, SameSite=Lax, Secure in production (`trust proxy` is set for Cloud Run).
- Files (planned): multer memory storage → `@google-cloud/storage`, bucket `GCS_BUCKET`, type + size checks.
- Map (planned): Leaflet + OpenStreetMap tiles, fed by a login-protected JSON endpoint.
- Tests: Vitest + Supertest against `DATABASE_URL_TEST` (separate Neon branch, or Postgres in CI).
- Deploy: Dockerfile → Cloud Run. Migrations run as a Cloud Run Job (`npx prisma migrate deploy`) before deploy.

## Layout

```
src/
  app.js            # builds the Express app; middleware ORDER defines the security model
  server.js         # listens on $PORT, graceful SIGTERM shutdown
  config/env.js     # the ONLY place env vars are read (zod-validated)
  db/prisma.js      # shared Prisma client;  db/pool.js: pg pool for the session store only
  routes/           # public.routes.js (allow-list) and protected.routes.js (everything else)
  controllers/      # thin HTTP handlers: read req.valid, call a service, render/redirect/json
  services/         # business logic + state machines, no Express objects (unit-testable)
  middleware/       # session, auth (requireLogin/requireRole/requireActiveAccount), authorize (ownership),
                    # validate (zod), csrf, rateLimit, errors (404 + central handler)
  validation/       # zod schemas
  utils/            # HttpError helpers, wantsJson
  views/            # EJS: partials/, auth/, dashboard/, errors/
  public/           # css/, img/, js/ (static, public)
prisma/             # schema.prisma + migrations/ (append-only)
scripts/            # seed-admin.js, seed-demo.js, migrate-test-db.js
tests/              # *.test.js + helpers/ (db reset, CSRF-aware Supertest agents)
```

## Conventions

- Request flow: route → (requireLogin, global) → requireRole/requireActiveAccount → `validate(schema)` →
  controller → service (authorization + transaction + audit event) → response.
- Errors: throw `HttpError` helpers (`badRequest`, `forbidden`, `notFound`, `conflict`). API responses use
  `{ error: { code, message, details? } }`. HTML gets `views/errors/error.ejs`. No stack traces in production.
- Not allowed to see a record → **404** (don't reveal existence). Allowed to see but not act → 403.
- Session stores only `userId`. `loadUser` re-reads the user each request (suspension and role changes apply at once).
  Never select `passwordHash` into views or JSON.
- DB naming: Prisma models in PascalCase, tables/columns snake_case via `@@map`/`@map`. UUID ids.
- Every state change in a workflow writes an `application_events` (or similar audit) row: who, what, when, comment.
- Money in integer **cents**. Distances in miles computed server-side (haversine) from stored lat/lng.
- Tests: each `newAgent()` is a separate browser. Use helpers in `tests/helpers/http.js` (they fetch CSRF tokens).

## Roles

| Role     | Created by                                        | Can                                                                                                                                   |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| STUDENT  | self-register, email must end `@scu.edu` → ACTIVE | browse approved listings/map, save, roommate groups, apply as group, respond to doc requests, accept/decline offers, post subleases   |
| LANDLORD | self-register → **PENDING** until admin approves  | properties/units/floor plans, submit & revise listings, review applications to OWN listings, request docs, make/rescind/reject offers |
| ADMIN    | `npm run seed:admin` only (first), then promotion | approve/reject landlords, approve listings or return with comment, on-campus inventory, view everything                               |

Ownership: landlords own their properties/units/floor plans/listings. A student who posts a sublease
owns that listing and acts as its landlord. An application belongs to a roommate group and is readable
only by group members, the listing owner, and admins. PENDING accounts can log in but cannot publish
(`requireActiveAccount`).

## Workflows (server-enforced state machines)

- **Listing:** `draft → submitted → (changes_requested → submitted)* → approved | rejected`, and `approved → archived`.
  A comment is required for changes_requested. Only approved listings are visible to students and the map.
- **Roommate group:** per term. Invite by email, accept or decline. One active group per student per term.
  The group is "ready" when every member has accepted.
- **Application:** `submitted → docs_requested → submitted → under_review → offered → accepted | declined | expired`.
  `rejected` and `withdrawn` are also possible from open states. Group size ≤ unit capacity. One active application per group per unit.
  Offers have a deadline: expire via check-on-read or a scheduled job, and the unit goes back to available.
  **Accept** = one transaction with `SELECT … FOR UPDATE` on the unit: mark it leased, close all other open
  applications for the unit (with notifications). Two groups can never hold the same unit.
- **On-campus room selection:** stretch goal. Skip unless the team asks.

## Back-end capabilities to build (keep them testable in services/)

State machines, inventory and locking, roommate group validation, a cost calculator (rent split per person +
utilities + parking, comparing on- and off-campus), haversine distance filtering, GCS uploads with type/size
checks, in-app notifications, and optionally one small AI feature (never the core).

## Course requirements to keep satisfied

Deployed public URL on Cloud Run, Neon Postgres, data survives redeploys (migrations only, sessions in
Postgres, files in GCS). Protected `main`, PR-only changes. Every PR needs a line-level review comment and a commit
addressing it, with both members contributing code and reviews. Tests cover multi-account workflows, invalid input,
computed results, and persistence. An AI-assisted security review with fixes is recorded in the README.

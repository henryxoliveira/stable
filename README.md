# Stable

**One place for Santa Clara University students to find, compare, and apply for housing (on campus and off), as a roommate group, from first search to signed offer.**

A horse's home is its stable. The name is a nod to the SCU Broncos.

- **Public URL:** TODO (Cloud Run URL after first deploy)
- **Status:** skeleton + authentication foundation. Features are being built in PRs (see [Roadmap](#roadmap)).

> Stable is a student class prototype. It is **not** affiliated with or endorsed by SCU Housing, does not
> connect to any SCU system, and uses team-seeded listing data (nothing is scraped from Zillow,
> Apartments.com, or other sites). It uses an original name, colors, and icon, not SCU or Bronco marks.

---

## Table of contents

1. [Problem](#problem)
2. [Features](#features)
3. [Roles and permissions](#roles-and-permissions)
4. [Record ownership rules](#record-ownership-rules)
5. [Workflows](#workflows)
6. [How the system starts](#how-the-system-starts)
7. [Architecture](#architecture)
8. [Back-end logic walkthrough](#back-end-logic-walkthrough)
9. [Data model](#data-model)
10. [Local setup](#local-setup)
11. [Configuration](#configuration)
12. [Deployment](#deployment)
13. [GitHub workflow](#github-workflow)
14. [Test scenarios and results](#test-scenarios-and-results)
15. [Security review](#security-review)
16. [Known limitations](#known-limitations)
17. [Team contributions](#team-contributions)
18. [AI usage](#ai-usage)
19. [Roadmap](#roadmap)

---

## Problem

SCU students look for housing across scattered sources: SCU Housing pages for on-campus rooms, generic
rental sites for off-campus apartments, and group chats and social media for subleases. Comparing a
dorm against a four-bedroom house split among friends means doing the math by hand. Applying as a
group means emailing landlords back and forth, and nobody knows whether the unit is still available.

Existing tools solve parts of this:

- **SubleaseIV** (UC Santa Barbara) offers verified student-to-student subleasing within one campus community.
- **College Pads** and **Places4Students** are vendor platforms that aggregate off-campus listings for many universities.

These tools mostly stop at _browse a listing, then contact the owner_. **Stable runs the whole workflow**:
an admin-approved listing, a roommate group applying together, the landlord requesting documents, an
offer with a deadline, and acceptance that atomically reserves the unit and closes competing
applications. Every step is permission-checked and audited.

## Features

Status key: ✅ done · 🚧 in progress · ⬜ planned

| Feature                                                                               | Status |
| ------------------------------------------------------------------------------------- | ------ |
| Registration (students need `@scu.edu`; landlords start pending), login, logout       | ✅     |
| Server-side sessions in Postgres; login required for everything but the allow-list    | ✅     |
| Role and account-status checks; record-ownership helper                               | ✅     |
| First-admin seed script (idempotent)                                                  | ✅     |
| Admin: approve or reject landlord accounts; promote admins                            | ⬜     |
| Landlord: properties, units, floor plans; listing approval workflow                   | ⬜     |
| Floor plan and photo uploads to Google Cloud Storage                                  | ⬜     |
| Interactive map (Leaflet + OpenStreetMap), with price, units, and floor plans per pin | ⬜     |
| Search filters: price per person, distance to campus (haversine), bedrooms            | ⬜     |
| Saved listings                                                                        | ⬜     |
| Roommate groups per term (invite, accept, decline)                                    | ⬜     |
| Group application lifecycle, document requests, offers with deadlines                 | ⬜     |
| Offer acceptance with row locking; competing applications auto-closed                 | ⬜     |
| Cost calculator: per-person rent, utilities, and parking, on- vs. off-campus          | ⬜     |
| Student subleases (same approval and application flow)                                | ⬜     |
| In-app notifications                                                                  | ⬜     |
| (Optional) AI lease summary                                                           | ⬜     |
| (Stretch) On-campus room selection with time slots                                    | ⬜     |

## Roles and permissions

| Role                    | Responsibilities                                                                                                                                                                                | How the account is created                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Student**             | Browse approved listings and the map; save listings; create or join roommate groups; apply as a group; respond to document requests; accept or decline offers; post subleases of their own room | Self-registers. Email must end in `@scu.edu`.                                                                                                                                  |
| **Landlord**            | Create properties, units, and floor plans; submit listings for approval; revise rejected listings; review applications to their listings; request documents; make, rescind, or reject offers    | Self-registers, but is **pending** and can't publish until an admin approves the account.                                                                                      |
| **Admin (SCU Housing)** | Approve or reject landlord accounts; approve listings or return them with comments; manage on-campus buildings and rooms; view everything for oversight                                         | **Never** through public registration. The first admin is created by a one-time seed script (`npm run seed:admin`). It is idempotent. Existing admins can promote other users. |

**Where this is enforced (server side, never only in the UI):**

| Check                                    | Code                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Logged in at all                         | `requireLogin` in `src/middleware/auth.js`, mounted globally in `src/app.js`                   |
| Has the right role                       | `requireRole('LANDLORD', …)` in `src/middleware/auth.js`                                       |
| Account approved (not PENDING)           | `requireActiveAccount` in `src/middleware/auth.js`                                             |
| Owns this specific record                | `assertOwnership` / `loadOwned` in `src/middleware/authorize.js`                               |
| Can't self-register as admin             | zod enum in `src/validation/auth.schemas.js` **and** a guard in `src/services/auth.service.js` |
| Unapproved listings hidden from students | Prisma `where` filter in the listing service (TODO)                                            |

## Record ownership rules

- A **landlord owns** their properties, units, floor plans, and listings, and can only edit their own.
- A **student who posts a sublease** owns that listing and acts as its "landlord" for applications to it.
- An **application belongs to a roommate group.** Only group members, the listing owner, and admins can read it.
- **Unapproved listings are invisible to students.** They are filtered out in the database query, not just the UI.
- Any request for a record the user isn't allowed to see returns **404**, so the response doesn't reveal that
  the record exists. When the user can see a record but not perform an action, the response is **403**.
  The data itself is never returned.

## Workflows

All transitions are validated on the server by a state machine in `src/services/`. A request for an
illegal transition (for example, accepting an offer that has expired) is rejected with 409.

### A. Listing approval

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> submitted: landlord submits (account must be ACTIVE)
    submitted --> changes_requested: admin returns (comment required)
    changes_requested --> submitted: landlord revises & resubmits
    submitted --> approved: admin approves
    submitted --> rejected: admin rejects
    approved --> archived: landlord or admin archives
```

Only `approved` listings appear on the map or in student search results.

### B. Roommate group

A student creates a group for a term and invites others by email. Invitees accept or decline. A student
can be in **only one active group per term**. The group is **ready** (allowed to apply) when every member
has accepted.

### C. Group application → offer

```mermaid
stateDiagram-v2
    [*] --> submitted: group applies (group ready, size ≤ unit capacity, no other active app for this unit)
    submitted --> docs_requested: landlord requests documents
    docs_requested --> submitted: group uploads documents
    submitted --> under_review: landlord starts review
    under_review --> offered: landlord makes offer (with deadline)
    offered --> accepted: group accepts before deadline (transaction + row lock)
    offered --> declined: group declines
    offered --> expired: deadline passes (unit back to available)
    offered --> under_review: landlord rescinds offer
    submitted --> rejected: landlord rejects
    under_review --> rejected: landlord rejects
    submitted --> withdrawn: group withdraws
    docs_requested --> withdrawn: group withdraws
    under_review --> withdrawn: group withdraws
    accepted --> [*]
    declined --> [*]
    expired --> [*]
    rejected --> [*]
    withdrawn --> [*]
```

Rules:

- The group size must fit the unit (bedrooms or beds).
- A group can have only one active application per unit.
- An offer has a deadline. A scheduled job or a check-on-read moves it to `expired` when the deadline
  passes and puts the unit back to available.
- **Accepting** runs in one database transaction with `SELECT … FOR UPDATE` on the unit row. It marks the
  unit leased and closes every other open application for that unit, notifying each group. Two groups can
  never both hold the same unit.
- Every state change writes an `application_events` row (who, what, when, comment).

### D. On-campus room selection (stretch goal)

The admin opens a selection window, and students get time slots by priority (class year, then a random
lottery). During their slot, a student claims a bed, with locking to prevent double booking. _Not
planned unless time allows._

## How the system starts

Public registration can only create **Student** (ACTIVE) or **Landlord** (PENDING) accounts. So how does
the first admin exist?

1. An operator sets `ADMIN_EMAIL` and `ADMIN_PASSWORD` (locally in `.env`, or on a one-off Cloud Run Job
   via Secret Manager).
2. They run `npm run seed:admin` (`scripts/seed-admin.js`). It validates the input, hashes the password
   with argon2id, and inserts an `ADMIN` user with status `ACTIVE`.
3. The script is **idempotent**. If that email already belongs to an admin, it changes nothing (it doesn't
   even reset the password). If the email belongs to a non-admin, it refuses and exits with an error rather
   than silently promoting someone.
4. From then on, admins approve landlords and can promote other users to admin from inside the app (TODO).

## Architecture

```mermaid
flowchart LR
    B["Browser<br/>(EJS pages + vanilla JS,<br/>Leaflet map)"]
    subgraph GCP["Google Cloud"]
      CR["Cloud Run service<br/>Node 22 + Express<br/>(stateless container)"]
      J["Cloud Run Job<br/>prisma migrate deploy"]
      GCS[("Cloud Storage bucket<br/>floor plans & photos")]
      SM["Secret Manager<br/>DATABASE_URL, SESSION_SECRET"]
    end
    N[("Neon Postgres<br/>users, listings, applications,<br/>events, sessions")]
    OSM["OpenStreetMap<br/>tile servers"]

    B -- "HTTPS (cookie: stable.sid)" --> CR
    CR -- "Prisma / pg over TLS" --> N
    CR -- "@google-cloud/storage" --> GCS
    SM -. "env vars at startup" .-> CR
    J -- "migrations" --> N
    B -- "map tiles" --> OSM
```

| Component        | Where it runs                             | Notes                                                                    |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| Pages and map JS | The user's browser                        | Server-rendered EJS; the map fetches JSON from login-protected endpoints |
| Express app      | Cloud Run (one or more containers)        | Stateless: any instance can serve any request                            |
| Database         | Neon (managed Postgres)                   | Every piece of application state, including sessions                     |
| Uploaded files   | Google Cloud Storage                      | Streamed from memory; never written to the container disk                |
| Migrations       | Cloud Run Job (same image), before deploy | `prisma migrate deploy` only applies new migrations                      |
| Secrets          | Secret Manager → Cloud Run env vars       | Never in the image or the repo                                           |

### What survives a redeploy, and why

| Data                                     | Survives? | Why                                                                                                 |
| ---------------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| Accounts, listings, applications, events | ✅        | Stored in Neon, outside the container. Schema changes are additive migrations, never drop/recreate. |
| Login sessions                           | ✅        | Stored in the Postgres `session` table (connect-pg-simple), not in container memory                 |
| Uploaded floor plans and photos          | ✅        | Stored in GCS. Cloud Run's filesystem is in-memory and wiped on every deploy and instance restart.  |
| Rate-limit counters                      | ❌        | In memory per instance; acceptable (see limitations)                                                |

## Back-end logic walkthrough

How a request moves through the code, using the flow from **"group submits application"** to **"offer
accepted"**. Steps marked (TODO) describe the design for services that are not built yet. The
middleware steps are already in place.

**Every request** passes through `src/app.js` in this order:

1. `helmet()`: security headers (CSP, HSTS, frame protection).
2. Static files and `/healthz` are served without a session.
3. Body parsing (100 KB limit).
4. `sessionMiddleware`: reads the signed `stable.sid` cookie and loads the session row from Postgres.
5. `loadUser`: re-reads the user by `session.userId`. Suspended or deleted users are logged out.
6. `csrfProtection`: any POST/PUT/PATCH/DELETE must carry the session's CSRF token.
7. Public routes (`/login`, `/register`).
8. `requireLogin`: everything after this needs a logged-in user (401 JSON or redirect to `/login`).
9. Protected routes, then the 404 handler and the central error handler.

**1. Student A submits an application** with `POST /api/listings/:listingId/applications { groupId, unitId }` (TODO):

1. **Route:** `protected.routes.js` → `requireRole('STUDENT')`.
2. **Validation:** `validate(applySchema)` checks the UUIDs with zod. Bad input gets a 400 `VALIDATION_ERROR`.
3. **Controller:** passes `req.user` and `req.valid` to `applicationService.submit()`.
4. **Authorization (service):** loads the group and checks that the user is an accepted member (otherwise 404).
   Loads the unit through an _approved_ listing (otherwise 404).
5. **Business rules:** the group is ready (all members accepted), group size ≤ unit capacity, the unit is available,
   and there's no other active application from this group for this unit. A failure returns 409 with a specific code.
6. **Transaction:** inserts the `applications` row (`submitted`) and the `application_events` row
   (`actor=A, from=null, to=submitted`), plus a notification for the listing owner.
7. **Response:** 201 with the application JSON.

**2. The landlord requests documents, reviews, and makes an offer** (TODO): each action is `POST /api/applications/:id/<action>`.
The service loads the application, checks that `listing.ownerId === req.user.id` (otherwise 404), checks that
the transition is legal for the current state (otherwise 409), updates the state, writes an event, and notifies
the group. An offer stores `offerExpiresAt`.

**3. Student B (same group) accepts** with `POST /api/applications/:id/accept` (TODO):

1. Authorization: the user is a member of the application's group (otherwise 404).
2. `prisma.$transaction(async (tx) => { … })`:
   - `SELECT … FROM units WHERE id = $1 FOR UPDATE`: locks the unit row, so a concurrent accept for
     the same unit waits here.
   - Re-reads the application inside the transaction. It must still be `offered`, and `now < offerExpiresAt`
     (otherwise it is marked `expired` and the request gets a 409).
   - Unit status: `available` → `leased`.
   - The application becomes `accepted`, with an event row.
   - Every _other_ open application for that unit is marked `rejected` (reason: "unit leased"), with
     event rows and notifications.
3. The commit releases the lock. The second request then sees `leased` and fails cleanly. **Two groups can never both hold the unit.**
4. Response: 200 with the updated application.

## Data model

**Implemented now** (`prisma/schema.prisma`, migration `20261102000000_init`):

| Table     | Columns                                                                                                                                                                 | Notes                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `users`   | `id` (uuid), `email` (unique, lowercased), `password_hash` (argon2id), `role` (STUDENT/LANDLORD/ADMIN), `status` (ACTIVE/PENDING/SUSPENDED), `created_at`, `updated_at` |                              |
| `session` | `sid`, `sess` (json), `expire`                                                                                                                                          | Managed by connect-pg-simple |

**Planned** (each one will arrive in a migration in the PR that needs it):

```mermaid
erDiagram
    users ||--o{ properties : owns
    properties ||--o{ units : has
    units ||--o{ floor_plans : has
    units ||--o{ listings : "listed as"
    users ||--o{ listings : owns
    listings ||--o{ listing_reviews : "admin comments"
    listings ||--o{ photos : has
    users ||--o{ saved_listings : saves
    roommate_groups ||--o{ group_members : has
    users ||--o{ group_members : "is"
    roommate_groups ||--o{ applications : submits
    units ||--o{ applications : "applied to"
    applications ||--o{ application_events : "audit log"
    applications ||--o{ application_documents : has
    users ||--o{ notifications : receives
```

Key fields (planned): `properties(lat, lng, address)`, `units(bedrooms, beds, rent_cents, utilities_cents,
parking_cents, status available|leased)`, `listings(status, kind off_campus|on_campus|sublease, owner_id)`,
`roommate_groups(term, owner_id)`, `group_members(status invited|accepted|declined)`,
`applications(status, offer_expires_at)`, `application_events(actor_id, from_status, to_status, comment, created_at)`.
Money is stored in integer cents.

## Local setup

Prerequisites: Node.js 22+, a Neon account (free tier works), and git.

```bash
git clone <repo-url> stable && cd stable
npm install                       # also generates the Prisma client
cp .env.example .env              # then edit .env with YOUR values
```

1. **Database.** In Neon, create a project `stable`. Copy the connection string into `DATABASE_URL`. Then create
   a **branch** (e.g. `test`) and put its connection string in `DATABASE_URL_TEST`. Tests erase the test branch's data.
   (Any local Postgres also works, e.g. `postgresql://postgres:postgres@localhost:5432/stable_dev`.)
2. **Session secret.** Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
3. **Migrate and seed:**
   ```bash
   npm run db:deploy                # apply migrations to DATABASE_URL
   npm run seed:admin               # creates ADMIN_EMAIL / ADMIN_PASSWORD admin (safe to re-run)
   npm run dev                      # http://localhost:8080
   ```
4. **Tests:** `npm test` (applies migrations to `DATABASE_URL_TEST` first). Lint: `npm run lint`.

When you change the schema: edit `prisma/schema.prisma`, then run `npm run db:migrate -- --name describe_change`,
then commit the new folder in `prisma/migrations/`.

## Configuration

All variables are read and validated in `src/config/env.js`. The app refuses to start if a required one is missing.

| Variable                         | Required                | Purpose                                                                             | Placeholder                                                        |
| -------------------------------- | ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `NODE_ENV`                       | yes                     | `development`, `test`, or `production` (enables Secure cookies, hides stack traces) | `production`                                                       |
| `PORT`                           | no (default 8080)       | HTTP port. Cloud Run sets it.                                                       | `8080`                                                             |
| `DATABASE_URL`                   | yes                     | Neon Postgres connection string (with `sslmode=require`)                            | `postgresql://USER:PASSWORD@HOST/stable?sslmode=require`           |
| `DATABASE_URL_TEST`              | tests only              | **Separate** database for the test suite (it gets truncated)                        | `postgresql://USER:PASSWORD@TEST-HOST/stable_test?sslmode=require` |
| `SESSION_SECRET`                 | yes (≥32 chars in prod) | Signs session cookies                                                               | `replace-with-at-least-32-random-characters`                       |
| `GCS_BUCKET`                     | when uploads ship       | Bucket for floor plans and photos                                                   | `your-stable-uploads-bucket`                                       |
| `GOOGLE_APPLICATION_CREDENTIALS` | local only              | Path to a service-account key **outside the repo**. Unset on Cloud Run.             | `/absolute/path/outside/repo/key.json`                             |
| `ADMIN_EMAIL`                    | seed only               | Email for the first admin                                                           | `housing-admin@scu.edu`                                            |
| `ADMIN_PASSWORD`                 | seed only               | Password for the first admin (≥12 chars)                                            | `replace-with-a-long-unique-password`                              |
| `ALLOWED_STUDENT_EMAIL_DOMAIN`   | no (default scu.edu)    | Required domain for student emails                                                  | `scu.edu`                                                          |

## Deployment

**TODO for the team:** replace `YOUR_PROJECT`, `REGION` (e.g. `us-west1`), and the bucket and repo names.

### One-time setup

```bash
gcloud config set project YOUR_PROJECT
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com storage.googleapis.com

# 1. Secrets (values typed at the prompt, never committed)
printf '%s' 'postgresql://...neon.tech/stable?sslmode=require' | gcloud secrets create DATABASE_URL --data-file=-
node -e "process.stdout.write(require('crypto').randomBytes(48).toString('hex'))" | gcloud secrets create SESSION_SECRET --data-file=-
printf '%s' 'a-long-admin-password' | gcloud secrets create ADMIN_PASSWORD --data-file=-

# 2. Uploads bucket (private; the app serves files through signed URLs or a proxy route)
gcloud storage buckets create gs://YOUR_BUCKET --location=REGION --uniform-bucket-level-access

# 3. A service account for the app, with least privilege
gcloud iam service-accounts create stable-run
SA=stable-run@YOUR_PROJECT.iam.gserviceaccount.com
gcloud storage buckets add-iam-policy-binding gs://YOUR_BUCKET --member=serviceAccount:$SA --role=roles/storage.objectAdmin
for s in DATABASE_URL SESSION_SECRET ADMIN_PASSWORD; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done

# 4. Artifact Registry repo for images
gcloud artifacts repositories create stable --repository-format=docker --location=REGION
```

**Neon:** use the main branch's connection string for production, and keep a separate branch for tests.
Neon applies TLS automatically.

### Every deploy

```bash
IMAGE=REGION-docker.pkg.dev/YOUR_PROJECT/stable/app:$(git rev-parse --short HEAD)
gcloud builds submit --tag $IMAGE

# 1. Migrate FIRST (only applies new migrations; never resets data)
gcloud run jobs deploy stable-migrate --image $IMAGE --region REGION \
  --service-account $SA --set-secrets DATABASE_URL=DATABASE_URL:latest \
  --command npx --args prisma,migrate,deploy
gcloud run jobs execute stable-migrate --region REGION --wait

# 2. Deploy the service
gcloud run deploy stable --image $IMAGE --region REGION --service-account $SA \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,GCS_BUCKET=YOUR_BUCKET,ALLOWED_STUDENT_EMAIL_DOMAIN=scu.edu \
  --set-secrets DATABASE_URL=DATABASE_URL:latest,SESSION_SECRET=SESSION_SECRET:latest
```

(`--allow-unauthenticated` only makes the URL reachable. The app itself requires login for everything except
`/login`, `/register`, static files, and `/healthz`.)

### First deploy only: create the admin

```bash
gcloud run jobs deploy stable-seed-admin --image $IMAGE --region REGION --service-account $SA \
  --set-env-vars ADMIN_EMAIL=housing-admin@scu.edu \
  --set-secrets DATABASE_URL=DATABASE_URL:latest,ADMIN_PASSWORD=ADMIN_PASSWORD:latest \
  --command node --args scripts/seed-admin.js
gcloud run jobs execute stable-seed-admin --region REGION --wait   # re-running is harmless
```

### Persistence check (do after each feature deploy)

Log in with an existing account, confirm that your listings, applications, and uploaded files are still
there, and record the result in [Test scenarios](#test-scenarios-and-results).

## GitHub workflow

- One repository. Both members are collaborators.
- `main` is **protected**: no direct pushes, and every change goes through a pull request.
- CI (`.github/workflows/ci.yml`) runs lint, a format check, and the tests against a throwaway Postgres on every PR.
- **Review rule (course requirement):** on every PR, the reviewer leaves at least one **substantive
  line-level comment**, and the author pushes a **commit that addresses it** before merging. Both members
  write features and review each other's PRs. The instructor checks the history.
- Branch naming: `feat/<thing>`, `fix/<thing>`, `docs/<thing>`. Use the PR template (`.github/pull_request_template.md`).

### Setting up branch protection (once, by the repo owner)

1. On GitHub, open the repo → **Settings** → **Collaborators** → **Add people**, and invite your teammate (Write access).
2. **Settings** → **Branches** → **Add branch ruleset** (or _Add classic branch protection rule_).
3. Name: `protect-main`. Enforcement: **Active**. Target branches: **Include default branch** (`main`).
4. Enable:
   - **Restrict deletions**
   - **Block force pushes**
   - **Require a pull request before merging**, with **Required approvals: 1**, **Dismiss stale approvals when new
     commits are pushed**, and **Require conversation resolution before merging**
   - **Require status checks to pass**, adding **`lint-and-test`** (it appears after CI has run once on a PR)
5. Leave the bypass list **empty**, so the rule applies to admins too. Save.
6. Test it: `git push origin main` from a local commit should now be rejected.

## Test scenarios and results

Automated tests: `npm test` (Vitest + Supertest, real Postgres). Each Supertest agent is a separate
browser with its own cookies.

| #   | Scenario                                                                                | Accounts used    | Expected                                                      | Actual                      |
| --- | --------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------- | --------------------------- |
| 1   | Register a student with an `@scu.edu` email                                             | new student      | 302 → dashboard, ACTIVE, argon2id hash, `/api/me` has no hash | ✅ pass (automated)         |
| 2   | Register a student with `gmail.com`, `scu.edu.evil.com`, or `notscu.edu`                | 3 anonymous      | 400, no user created                                          | ✅ pass (automated)         |
| 3   | Public registration with `role=ADMIN`                                                   | anonymous        | 400, no admin created                                         | ✅ pass (automated)         |
| 4   | Register a landlord                                                                     | new landlord     | PENDING                                                       | ✅ pass (automated)         |
| 5   | Missing fields, short password, duplicate email                                         | anonymous        | 400 / 400 / 409                                               | ✅ pass (automated)         |
| 6   | Form POST without a CSRF token                                                          | anonymous        | 403                                                           | ✅ pass (automated)         |
| 7   | Login changes the session id; cookie is HttpOnly and SameSite=Lax                       | student          | new sid                                                       | ✅ pass (automated)         |
| 8   | Wrong password and unknown email                                                        | anonymous        | same 401 message                                              | ✅ pass (automated)         |
| 9   | Logout, then replay the old cookie from another client                                  | student          | session row deleted; 401                                      | ✅ pass (automated)         |
| 10  | Suspended user                                                                          | student          | existing session 401; login 401                               | ✅ pass (automated)         |
| 11  | Anonymous access to `/`, `/dashboard`, `/dashboard/admin`, an unknown path              | anonymous        | 302 → `/login`                                                | ✅ pass (automated)         |
| 12  | Anonymous `GET /api/me`                                                                 | anonymous        | 401 `{ error: { code, message } }`                            | ✅ pass (automated)         |
| 13  | Student opens the admin or landlord dashboard                                           | student          | 403                                                           | ✅ pass (automated)         |
| 14  | Pending landlord submits a listing                                                      | pending landlord | 403 `ACCOUNT_PENDING`                                         | ✅ pass (automated)         |
| 15  | Active landlord submits (feature stub)                                                  | active landlord  | passes checks → 501                                           | ✅ pass (automated)         |
| 16  | Invalid route param                                                                     | active landlord  | 400 `VALIDATION_ERROR`                                        | ✅ pass (automated)         |
| 17  | Ownership helper: owner, admin, other landlord                                          | unit test        | allow, allow, 404                                             | ✅ pass (automated)         |
| 18  | `seed:admin` twice, then with an existing non-admin email                               | script           | created → exists (hash unchanged) → conflict (not promoted)   | ✅ pass (automated)         |
| 19  | Student A applies, Landlord reviews, Student C (not in the group) reads the application | A, L, C          | C gets 404                                                    | TODO                        |
| 20  | Two groups accept offers for the same unit at the same time                             | groups 1 and 2   | exactly one is accepted                                       | TODO                        |
| 21  | Offer past its deadline                                                                 | group, landlord  | `expired`, unit available                                     | TODO                        |
| 22  | Cost split: $4,000 rent + $200 utilities, 3 people                                      | unit test        | per-person amount and remainder handled                       | TODO                        |
| 23  | Data still present after a redeploy (account, listing, uploaded floor plan)             | any              | all present                                                   | TODO (manual, on Cloud Run) |

Latest run (local, 2026-11-02): **26 tests, 4 files, all passing.**

## Security review

TODO: run an AI-assisted security review (e.g. Claude Code `/security-review`) once the main workflows
exist. Fix the findings, redeploy, and record them here.

| #   | Finding | Severity | Fix (PR / commit) | Verified after redeploy |
| --- | ------- | -------- | ----------------- | ----------------------- |
|     | TODO    |          |                   |                         |

Security measures already in place: argon2id hashing; server-side sessions (session id regenerated on login,
destroyed on logout); HttpOnly + SameSite=Lax cookies, Secure in production; CSRF tokens on all unsafe methods;
rate limiting on login and register; helmet headers (CSP, HSTS); zod validation; Prisma parameterized queries;
login required by default; 404 for records the user may not see; no stack traces in production; secrets
only in env vars or Secret Manager; a `.claude/settings.json` deny list so the AI agent can't read `.env` or key files.

Dependency audit at setup (`npm audit`, 2026-11-02): one high-severity advisory in `deepmerge-ts`, pulled in
by the Prisma **CLI**'s config loader (used at build and migrate time on trusted input only), and one moderate
advisory in `minimatch`, pulled in by ESLint (dev only). Neither is reachable from HTTP requests. Revisit these
when Prisma 6.x or ESLint ship patched releases.

## Known limitations

- Prototype only: no connection to SCU's real housing systems, and listings are team-seeded demo data.
- Rate-limit counters are in memory per Cloud Run instance, so the effective limit scales with the number of instances.
- Registration reveals whether an email is already registered (409). That's acceptable for a prototype; a production
  system would send a verification email instead.
- No email verification or password reset yet. Ownership of the `@scu.edu` address is not verified.
- TODO: add more as features land.

## Team contributions

### Henrique Oliveira

TODO: features built, PRs authored, PRs reviewed.

### TODO: teammate name

TODO: features built, PRs authored, PRs reviewed.

## AI usage

- **Claude Code** (Anthropic) generated the initial repository skeleton: folder structure, auth foundation,
  middleware, tests, CI, Dockerfile, and this README's structure. The team reviewed it and can explain every file.
- `CLAUDE.md` (and `AGENTS.md`, which points to it) gives every AI session the same rules: no secrets, login and
  authorization on every route, migrations only, plain JavaScript, small PRs.
- `.claude/settings.json` denies the agent read access to `.env` and key files.
- TODO: record later AI usage per feature (what was generated, what was changed by hand, and the AI security review).

## Roadmap

Next PR-sized tasks. **Member A:** auth hardening, listings and approval, uploads, map. **Member B:** groups,
the application state machine, offers, and the cost calculator.

| Member A                                                                       | Member B                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| A1. Admin: list pending landlords; approve or reject; promote to admin         | B1. Schema + service: roommate groups per term, invites, accept/decline, "ready"     |
| A2. Properties, units, floor plans (CRUD with ownership + tests)               | B2. Cost calculator service + page (cents, rent split, on- vs. off-campus)           |
| A3. Listing state machine + admin review queue with comments                   | B3. Application schema + state machine + `application_events`                        |
| A4. GCS uploads (multer memory, type/size checks) for floor plans and photos   | B4. Landlord review actions: docs requested, under review, offer with deadline       |
| A5. Map page (Leaflet, vendored) + JSON endpoint + haversine and price filters | B5. Accept offer with a transaction and `FOR UPDATE`; auto-close competitors; expiry |
| A6. Seeded demo listings (`seed:demo`) + saved listings                        | B6. In-app notifications + student subleases                                         |

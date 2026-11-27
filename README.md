# Stable

**One place for Santa Clara University students to find, compare, and apply for housing (on campus and off), as a roommate group, from first search to signed offer.**

A horse's home is its stable. The name is a nod to the SCU Broncos.

- **Public URL:** TODO (Cloud Run URL after first deploy)
- **Status:** authentication, roommate groups, the cost calculator, and landlord properties/units/floor plans are built. Other features are being built in PRs (see [Roadmap](#roadmap)).

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
| Landlord: properties, units, floor plans; listing approval workflow                   | 🚧     |
| Floor plan and photo uploads to Google Cloud Storage                                  | ⬜     |
| Interactive map (Leaflet + OpenStreetMap), with price, units, and floor plans per pin | ⬜     |
| Search filters: price per person, distance to campus (haversine), bedrooms            | ⬜     |
| Saved listings                                                                        | ⬜     |
| Roommate groups per term (invite by email, accept, decline, transfer, leave, history) | ✅     |
| Group application lifecycle, document requests, offers with deadlines                 | ✅     |
| Offer acceptance with row locking; competing applications auto-closed                 | ✅     |
| Cost calculator: per-person rent, utilities, and parking, on- vs. off-campus          | ✅     |
| Student subleases (same approval and application flow)                                | ⬜     |
| In-app notifications                                                                  | ✅     |
| (Optional) AI lease summary                                                           | ⬜     |
| (Stretch) On-campus room selection with time slots                                    | ⬜     |

## Roles and permissions

| Role         | Responsibilities                                                                                                                                                                                | How the account is created                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Student**  | Browse approved listings and the map; save listings; create or join roommate groups; apply as a group; respond to document requests; accept or decline offers; post subleases of their own room | Self-registers. Email must end in `@scu.edu`.                                                                                                                                  |
| **Landlord** | Create properties, units, and floor plans; submit listings for approval; revise rejected listings; review applications to their listings; request documents; make, rescind, or reject offers    | Self-registers, but is **pending** and can't publish until an admin approves the account.                                                                                      |
| **Admin**    | Approve or reject landlord accounts; approve listings or return them with comments; manage on-campus buildings and rooms; view everything for oversight                                         | **Never** through public registration. The first admin is created by a one-time seed script (`npm run seed:admin`). It is idempotent. Existing admins can promote other users. |

**Where this is enforced (server side, never only in the UI):**

| Check                                    | Code                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Logged in at all                         | `requireLogin` in `src/middleware/auth.js`, mounted globally in `src/app.js`                    |
| Has the right role                       | `requireRole('LANDLORD', …)` in `src/middleware/auth.js`                                        |
| Account approved (not PENDING)           | `requireActiveAccount` in `src/middleware/auth.js`                                              |
| Owns this specific record                | `assertOwnership` / `loadOwned` in `src/middleware/authorize.js`                                |
| Can't self-register as admin             | zod enum in `src/validation/auth.schemas.js` **and** a guard in `src/services/auth.service.js`  |
| Unapproved listings hidden from students | Prisma `where` filter in the listing service (TODO)                                             |
| Property, unit, floor plan: owner only   | `assertCanEdit()` in `src/services/property.service.js` (404 others; admins view, 403 on edit)  |
| Group page/actions: member or invitee    | `loadAccess()` in `src/services/group.service.js` (404 for anyone else; admins may view)        |
| Group owner-only actions                 | `requireOwner()` in `src/services/group.service.js` (403 for members and invitees)              |
| Cost estimate: only its owner            | every query in `src/services/costEstimate.service.js` filters by `userId` (404 for anyone else) |

## Record ownership rules

- A **landlord owns** their properties, units, floor plans, and listings, and can only edit their own.
- A **student who posts a sublease** owns that listing and acts as its "landlord" for applications to it.
- An **application belongs to a roommate group.** Only group members, the listing owner, and admins can read it.
- **Unapproved listings are invisible to students.** They are filtered out in the database query, not just the UI.
- Any request for a record the user isn't allowed to see returns **404**, so the response doesn't reveal that
  the record exists. When the user can see a record but not perform an action, the response is **403**.
  The data itself is never returned.

## Properties, units, and floor plans

A landlord sets these up from **Properties** on their dashboard (`/properties`). Pending landlords can do
this too, so they're ready when an admin approves them; they just can't publish listings yet.

- A **property** is a building or house: name, street address, city, state, ZIP, an optional map location
  (latitude and longitude, both or neither), and a description.
- A **unit** is one rentable place in a property: a label (unique within the property), bedrooms (0 for a
  studio), **beds** (how many people it fits, 1 to 16, the same as the largest roommate group), bathrooms
  in half steps, optional square feet, and monthly **rent, utilities, and parking** for the whole unit.
  Every unit starts `AVAILABLE`. Only accepting an offer (B5) will mark it `LEASED`.
- A **floor plan** belongs to a unit: a name (unique within the unit), optional square feet, and notes. The
  image upload comes with Cloud Storage uploads (A4).
- **Money** is typed in dollars (`2400`, `2400.50`, or `$2,400.50`) and stored as integer cents (`240050`),
  parsed from the text in `src/utils/money.js` (shared with the cost calculator) so no floating-point rounding is involved. Amounts over
  $100,000, negative amounts, and more than two digits of cents are refused.
- **Who can do what:** the owner can create and edit. Another landlord gets **404** on every page and
  action (they can't tell it exists), and their list only ever loads their own rows (the filter is in the
  query). Admins can view every property, with the owner's email, but get **403** on edits. Students get
  **403** on every property route.
- The database backs up the form rules with CHECK constraints (beds 1 to 16, cents ≥ 0, valid coordinates,
  latitude and longitude set together) and unique indexes for unit labels and floor plan names.
- Code: `src/services/property.service.js`, `src/controllers/properties.controller.js`,
  `src/validation/property.schemas.js`, views in `src/views/properties/`, `units/`, and `floor-plans/`.

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

A student creates a group with a name and a term. The term is picked from a dropdown of the **current SCU
quarter plus the next 5** (quarters: WINTER Jan–Mar, SPRING Apr–Jun, SUMMER Jul–Aug, FALL Sep–Dec, read on
Pacific time). The list comes from `upcomingTerms()` in `src/services/group.service.js`. The same function feeds
the zod schema, so the server rejects any other term (past, too far ahead, or malformed) with a 400, not just a
bad format. Values look like `FALL-2026`; the dropdown shows "Fall 2026". The creator becomes the **owner** and
the first accepted member.

**Members and invitations are stored separately.** `group_members` holds accepted members (tied to a user).
`group_invitations` holds invitations tied to an **email address** (lowercased, must end in `@scu.edu`), so
the owner can invite someone who hasn't registered yet. Invitations are matched to `req.user.email` when they
are read, so they appear as soon as the person registers or logs in. The invite response is identical whether
or not the email has an account, so inviting can't be used to find out who is registered.

Invitation states (one row per group + email; re-inviting resets the row to `PENDING`):

```mermaid
stateDiagram-v2
    [*] --> PENDING: owner invites email
    PENDING --> ACCEPTED: invitee accepts (becomes a member)
    PENDING --> DECLINED: invitee declines
    PENDING --> CANCELLED: owner cancels, or group disbanded
    DECLINED --> PENDING: owner re-invites
    CANCELLED --> PENDING: owner re-invites
    ACCEPTED --> PENDING: owner re-invites after the member left
```

Group states:

```mermaid
stateDiagram-v2
    [*] --> ACTIVE: student creates group (owner = creator)
    ACTIVE --> ACTIVE: invite / accept / decline / cancel / transfer ownership / member leaves
    ACTIVE --> DISBANDED: owner leaves as the only member (pending invites cancelled)
```

Rules (all enforced on the server):

| Rule                                                                         | Failure                         |
| ---------------------------------------------------------------------------- | ------------------------------- |
| Only students use group routes; admins may view any group page               | landlord 403, admin action 403  |
| Not a member or invitee (or the group is disbanded)                          | 404                             |
| Only the current owner can invite, cancel invites, or transfer ownership     | 403                             |
| Only the invitee (logged in with the invited email) can accept or decline    | 404 for anyone else             |
| At most **16 seats** (accepted members + pending invites), `MAX_GROUP_SEATS` | 409 `GROUP_FULL`                |
| No self-invite; no duplicate pending invite; no inviting an existing member  | 400 / 409 `INVITE_EXISTS` / 409 |
| A student is an accepted member of **at most one group per term**            | 409 `ALREADY_IN_GROUP_FOR_TERM` |
| The owner can't leave while other members remain (transfer first)            | 409 `TRANSFER_OWNERSHIP_FIRST`  |
| Transfer target must be another accepted member                              | 400                             |

- **Ready** = at least one accepted member and **no pending invitations**. Only ready groups will be able to apply (B3).
- **Locking.** Every change runs in one Prisma transaction. When a transaction needs both locks, it takes the
  student's `users` row first (`SELECT … FOR UPDATE`, a tagged `$queryRaw`), then the `roommate_groups` row.
  Two simultaneous accepts by the same student queue on the user lock, so the second sees the first membership
  and gets 409. The group lock stops a disband from racing with an accept or an invite, and keeps the seat count
  from going over 16. A unique index on `group_members(user_id, term)` is a database backstop in case the lock is
  ever skipped.
- Every change writes a `group_events` row (actor, type, detail, time) in the same transaction, including
  transfers and disbanding. The group page shows this history to members and admins.

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
    docs_requested --> rejected: landlord rejects
    under_review --> rejected: landlord rejects
    submitted --> withdrawn: group withdraws
    docs_requested --> withdrawn: group withdraws
    under_review --> withdrawn: group withdraws
    submitted --> closed: system closes it (unit leased, or group placed elsewhere)
    docs_requested --> closed: system closes it (unit leased, or group placed elsewhere)
    under_review --> closed: system closes it (unit leased, or group placed elsewhere)
    offered --> closed: system closes it (unit leased, or group placed elsewhere)
    accepted --> [*]
    declined --> [*]
    expired --> [*]
    rejected --> [*]
    withdrawn --> [*]
    closed --> [*]
```

**Where these rules live.** The states, the allowed moves, and who may make each move are written down in one
file: `src/services/application.workflow.js`. It has no database and doesn't read the clock (the current time is
passed in), so every rule can be tested on its own. `src/services/application.service.js` uses it for every status
change: it adds the database, the locks, and the history, but never its own copy of the rules.

- In the code, states are written in capitals (`DOCS_REQUESTED`). The diagram above uses lowercase to stay readable.
  Pages show friendly names such as "Documents requested".
- Each move has exactly one kind of actor: a **group member**, the **listing owner** (landlord), or the
  **system** (expiring an offer, or closing other applications when a group accepts). A move by the wrong
  person is refused.
- Finished applications (accepted, declined, expired, rejected, withdrawn, closed) can't change any more.
- **Closed** means the system closed it: when a group accepts an offer, every other open application for that
  unit is closed ("This unit was leased to another group"), and so is every other open application from that
  group ("Your group accepted another place"), because a group can't lease two places.
- Once an offer is made, the group can accept or decline, but not withdraw.
- **Deadline:** an offer counts as expired at the exact deadline time. Accepting needs the deadline and the
  current time to be checked; if they are missing or not valid dates, the move is refused, so later code can't skip the check.
- A test reads the diagram above and checks that the code allows exactly the same moves. If you change the
  diagram, the test fails until the code matches (and the other way round).

Rules:

- The group size must fit the unit (beds; if a unit doesn't list beds, its bedrooms).
- A group can have only one active application per unit.
- An offer has a deadline. A scheduled job or a check-on-read moves it to `expired` when the deadline
  passes and puts the unit back to available.
- **Accepting** runs in one database transaction with `SELECT … FOR UPDATE` on the unit row. It marks the
  unit leased and closes every other open application for that unit, notifying each group. Two groups can
  never both hold the same unit.
- Every state change writes an `application_events` row (who, what, when, comment).

### Notifications (B6 part 1)

Each notification is written **in the same transaction** as the event that causes it, so it exists exactly when
the event does. Nobody is notified about their own action. There is no email.

| What happened                                                         | Who is notified                                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A group applies                                                       | The unit's landlord                                                                |
| Landlord requests documents, starts review, offers, rescinds, rejects | Each member of the group (the offer shows its deadline)                            |
| Group sends documents, withdraws, or declines an offer                | The landlord                                                                       |
| A group accepts an offer                                              | The landlord, and the group's other members                                        |
| Accepting closes another application                                  | That group's members, with the reason; and its landlord if it was for another unit |
| An offer expires                                                      | Each member of the group, and the landlord                                         |
| A student is invited to a group                                       | The invited student, if an account with that email already exists                  |

Comments are included in the message, quoted. The header shows an unread count. `/notifications` lists the
latest 100, newest first, with "Mark read" and "Mark all as read". Every query filters on the logged-in user,
so someone else's notification is a 404. Links are always paths on this site (one `/`, never `//` or a full
URL), checked in code and by a CHECK constraint. Messages are always shown escaped, since they can contain
user comments.

### D. On-campus room selection (stretch goal)

The admin opens a selection window, and students get time slots by priority (class year, then a random
lottery). During their slot, a student claims a bed, with locking to prevent double booking. _Not
planned unless time allows._

### Cost calculator

A student types in what a place costs each month: rent, utilities, and parking for the whole unit.
Stable shows what each roommate pays. The student can save several estimates and compare them.
Each estimate is private to the student who made it.

- **Money is kept in cents.** "$4,000.50" is stored as 400050. Computers make small rounding errors with
  decimals, so we never use them for money.
- **Typing amounts.** You can type 1250, 1250.50, $1,250, or $1,250.50. Negative amounts, more than two
  digits of cents, letters, and amounts over $100,000 are refused with a plain message.
- **Splitting.** The monthly total is divided by the number of people. If it doesn't divide evenly, the
  extra cents go one each to the first few people. Example: $4,000.00 for 3 people is $1,333.34, $1,333.33,
  and $1,333.33. The shares always add up to the exact total.
- **On campus vs. off campus.** If the student enters an SCU housing cost per quarter, Stable compares the
  total for the lease against the total for the quarters on campus. Off campus is the most anyone in the group
  pays each month, times the lease length (12 months by default). On campus is the quarterly cost times the
  number of quarters (3 by default, about 9 months). These can cover different lengths of time, for example a
  12-month lease includes summer, so the page shows both totals and how each one was worked out.
- **Roommate group (optional).** A student can link one of their groups. If they leave "people" blank, it
  uses the group's size. Only accepted members can link a group. If the student later leaves the group,
  the estimate says "Linked group no longer available" and hides the group's details.
- **Results are worked out fresh** every time an estimate is opened. Only the inputs are saved.
- Code: the math is in `src/services/cost.service.js` (no database, so it is easy to test). Typed amounts are
  parsed by `src/utils/money.js`, the same parser the unit forms use, so both accept and refuse the same input. Saving and
  loading is in `src/services/costEstimate.service.js`.

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
2. Static files and `/health` are served without a session. The health endpoint returns
   `200` with `{"status":"ok"}`. Avoid health paths ending in `z`, which can conflict with
   [Cloud Run reserved URL paths](https://cloud.google.com/run/docs/known-issues#reserved-url-paths).
3. Body parsing (100 KB limit).
4. `sessionMiddleware`: reads the signed `stable.sid` cookie and loads the session row from Postgres.
5. `loadUser`: re-reads the user by `session.userId`. Suspended or deleted users are logged out.
6. `csrfProtection`: any POST/PUT/PATCH/DELETE must carry the session's CSRF token.
7. Public routes (`/login`, `/register`).
8. `requireLogin`: everything after this needs a logged-in user (401 JSON or redirect to `/login`).
9. Protected routes, then the 404 handler and the central error handler.

**1. Student A applies for the group** with `POST /api/units/:unitId/applications { groupId }` (the page form posts
to `/units/:unitId/apply`). Listings don't exist yet (A3), so students apply to a unit by link for now:

1. **Route:** `protected.routes.js` → `requireRole('STUDENT')`.
2. **Validation:** `validate(unitIdParams)` and `validate(applyBody)` check the ids with zod. Bad input gets a 400
   `VALIDATION_ERROR`.
3. **Controller:** `applications.controller.js` passes `req.user` and `req.valid` to `applicationService.apply()`.
4. **Transaction, with locks in a fixed order (group row, then unit row):**
   - Lock the group row and check that the student is an accepted member (otherwise 404). Two members clicking
     "apply" at the same moment run one after the other, so only one application is created.
   - Lock the unit row, so the unit can't be marked leased halfway through.
   - The unit's landlord must be ACTIVE (otherwise 404). _TODO (A3): require an approved listing instead._
5. **Business rules**, each failure a 409 with its own code: the group is ready (`isReady`: nobody still invited),
   it fits the unit (`groupFitsUnit`: beds, or bedrooms), the unit is AVAILABLE, and the group has no other open
   application for this unit. `canTransition(null, SUBMITTED, GROUP_MEMBER)` must agree.
6. **Writes:** the `applications` row (`SUBMITTED`, with the group size that was checked) and its first
   `application_events` row (`actor = A, from = null, to = SUBMITTED`), in the same transaction.
7. **Response:** 201 with the application JSON.

**2. The landlord and the group move it along**, each with `POST /api/applications/:id/<move>` (or the buttons on
the pages, which come from `allowedMoves()`):

| Move                | Who      | Notes                                                                      |
| ------------------- | -------- | -------------------------------------------------------------------------- |
| `request-documents` | landlord | Comment required (which documents)                                         |
| `send-documents`    | group    | Comment required (e.g. "Sent pay stubs by email"); file upload comes later |
| `start-review`      | landlord |                                                                            |
| `offer`             | landlord | Deadline in the future, at most 14 days away; one open offer per unit      |
| `rescind`           | landlord | Back to "Under review"                                                     |
| `reject`            | landlord | Optional reason                                                            |
| `withdraw`          | group    | Optional comment                                                           |
| `decline`           | group    | Declines an offer; optional comment                                        |

For each move the service: expires the offer first if its deadline has passed; locks the application row (for
`offer`, the unit row first, then the application); checks who the user is (a group member, or the owner of the
unit's property; anyone else gets 404, an admin gets 403); asks `canTransition()` (the wrong person gets 403, an
illegal move 409 with the workflow's plain-English reason); then updates the status and writes the event in one
transaction. Landlord moves need an ACTIVE account.

**Offer expiry:** whenever applications are read, and before every move, an offer past its deadline becomes
`EXPIRED` with a `SYSTEM` event. Exactly at the deadline counts as expired. The update only matches an offer that
is still open, so two reads at the same moment write only one event.

**3. Student B (same group) accepts the offer** with `POST /api/applications/:id/accept` (or the "Accept offer"
button). Only students reach this route; landlords and admins get 403.

1. **Expire first:** if the offer's deadline has passed, it becomes `EXPIRED` (in its own transaction, so it
   stays expired) and the request gets 409. Exactly at the deadline counts as passed.
2. **One transaction, with locks in this order: group row → unit row → application row.** It's the same order as
   applying (group → unit) and making an offer (unit → application), so no two requests can wait on each other in
   a circle. The student must be an accepted member of the group (otherwise 404).
3. **Ask the rules:** `canTransition(OFFERED, ACCEPTED, GROUP_MEMBER, { offerExpiresAt, now })`. If the offer was
   rescinded, declined, or accepted a moment earlier, this refuses with a 409.
4. **Re-check what may have changed since the group applied**, each a 409: the group is still ready (nobody
   still invited), it still fits the unit, the unit is still `AVAILABLE`, and the landlord is still ACTIVE.
5. **Write:** the unit becomes `LEASED`, the application `ACCEPTED`, with an event for the student.
6. **Close what's now impossible**, each with a `SYSTEM` event: every other open application for this unit ("This
   unit was leased to another group"), and every other open application from this group ("Your group accepted
   another place"). Each close goes through `canTransition(…, CLOSED, SYSTEM)`. The notifications (landlord,
   the rest of the group, each closed group) are written here too, in the same transaction.
7. **Commit.** A second accept for the same unit waits on the unit lock, then finds the unit leased (or its own
   application closed) and gets a clean 409. **Two groups can never both hold the unit.** A group that has
   accepted a place can't open new applications (409 `GROUP_ALREADY_PLACED`).
8. **Response:** 200 with the accepted application and how many others were closed.

## Data model

**Implemented now** (`prisma/schema.prisma`, migrations `20261102000000_init`, `20261110030323_roommate_groups`,
`20261124073118_cost_estimates`, `20261125025154_properties_units_floor_plans`, `20261126065226_applications`,
`20261126075425_application_closed`, and `20261126180000_notifications`):

| Table     | Columns                                                                                                                                                                 | Notes                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `users`   | `id` (uuid), `email` (unique, lowercased), `password_hash` (argon2id), `role` (STUDENT/LANDLORD/ADMIN), `status` (ACTIVE/PENDING/SUSPENDED), `created_at`, `updated_at` |                              |
| `session` | `sid`, `sess` (json), `expire`                                                                                                                                          | Managed by connect-pg-simple |

| Table               | Columns                                                                                                                                                                                            | Notes                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `roommate_groups`   | `id`, `name`, `term`, `owner_id` → users, `status` (ACTIVE/DISBANDED), `created_at`, `updated_at`                                                                                                  | Index on `term`                                                                      |
| `group_members`     | `id`, `group_id` → roommate_groups, `user_id` → users, `term` (copied from the group), `joined_at`                                                                                                 | Accepted members only. Unique `(group_id, user_id)` and **unique `(user_id, term)`** |
| `group_invitations` | `id`, `group_id`, `email` (lowercased), `status` (PENDING/ACCEPTED/DECLINED/CANCELLED), `invited_by_id`, `created_at`, `responded_at`                                                              | Tied to an email, not a user. Unique `(group_id, email)`; index `(email, status)`    |
| `group_events`      | `id`, `group_id`, `actor_id` → users, `type` (CREATED, INVITED, INVITE_CANCELLED, INVITE_ACCEPTED, INVITE_DECLINED, OWNERSHIP_TRANSFERRED, MEMBER_LEFT, DISBANDED), `detail` (jsonb), `created_at` | Append-only audit log                                                                |

| Table         | Columns                                                                                                                                                                                                  | Notes                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `properties`  | `id`, `owner_id` → users, `name`, `address`, `city`, `state` (default CA), `postal_code`, `latitude`, `longitude` (both or neither), `description`, `created_at`, `updated_at`                           | Index on `owner_id`                                                |
| `units`       | `id`, `property_id` → properties, `label`, `bedrooms`, `beds` (1–16), `bathrooms` (half steps), `square_feet`, `rent_cents`, `utilities_cents`, `parking_cents`, `status` (AVAILABLE/LEASED), timestamps | Unique `(property_id, label)`; CHECKs on ranges and cents ≥ 0      |
| `floor_plans` | `id`, `unit_id` → units, `name`, `square_feet`, `notes`, timestamps                                                                                                                                      | Unique `(unit_id, name)`. The image file arrives with uploads (A4) |

```mermaid
erDiagram
    users ||--o{ properties : owns
    properties ||--o{ units : has
    units ||--o{ floor_plans : has
    users ||--o{ roommate_groups : owns
    roommate_groups ||--o{ group_members : has
    users ||--o{ group_members : "is"
    roommate_groups ||--o{ group_invitations : "invites (by email)"
    roommate_groups ||--o{ group_events : "audit log"
    users ||--o{ group_events : "actor"
```

| Table            | Columns                                                                                                                                                                                                                                                                             | Notes                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `cost_estimates` | `id`, `user_id` → users, `name`, `people`, `rent_cents`, `utilities_cents`, `parking_cents` (monthly, whole unit), `lease_months` (default 12), `on_campus_quarterly_cents` (optional), `quarters` (default 3), `group_id` → roommate_groups (optional), `created_at`, `updated_at` | One student's saved estimate. Money is whole cents. Results are not stored; they are worked out on each view. |

How `cost_estimates` protects its data:

- If a user is deleted, their estimates are deleted too.
- If a group row is ever deleted, the estimate keeps its numbers and just loses the link.
- The database itself refuses bad numbers, even if the app had a bug: people must be 1 to 16, money can't be
  negative, the lease must be 1 to 24 months, and quarters must be 1 to 4. (These are CHECK constraints in the
  migration.)
- The money column names match the planned `units` table, so a listing's costs can fill in an estimate later.

```mermaid
erDiagram
    users ||--o{ cost_estimates : saves
    roommate_groups |o--o{ cost_estimates : "linked to (optional)"
```

**Group applications** (migrations `20261126065226_applications` and `20261126075425_application_closed`, which
adds the `CLOSED` status):

| Table                | Columns                                                                                                                                             | Notes                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `applications`       | `id`, `group_id` → roommate_groups, `unit_id` → units, `status`, `group_size`, `offer_expires_at`, `created_at`, `updated_at`                       | One group's application for one unit. An OFFERED application must have a deadline (CHECK). |
| `application_events` | `id`, `application_id` → applications, `actor_id` → users (empty for the system), `actor_type`, `from_status`, `to_status`, `comment`, `created_at` | Append-only history: every status change, who made it, and why.                            |

Statuses are the ones in Workflow C, written in capitals (`SUBMITTED`, `DOCS_REQUESTED`, …). `actor_type` is
`GROUP_MEMBER`, `LISTING_OWNER`, or `SYSTEM` (an offer expiring). `group_size` is the number of accepted members when
the group applied, which is the size checked against the unit.

```mermaid
erDiagram
    roommate_groups ||--o{ applications : submits
    units ||--o{ applications : "applied to"
    applications ||--o{ application_events : "history"
    users |o--o{ application_events : "made the move"
```

**Notifications** (migration `20261126180000_notifications`):

| Table           | Columns                                                                                                                              | Notes                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notifications` | `id`, `user_id` → users, `type`, `message` (plain English), `link` (a path on this site), `read_at` (empty until read), `created_at` | Only the user can read or mark it. Deleted with the user. Indexes `(user_id, created_at)` and `(user_id, read_at)`. CHECK: `link` is an internal path. |

```mermaid
erDiagram
    users ||--o{ notifications : receives
```

**Planned** (each one will arrive in a migration in the PR that needs it):

```mermaid
erDiagram
    units ||--o{ listings : "listed as"
    users ||--o{ listings : owns
    listings ||--o{ listing_reviews : "admin comments"
    listings ||--o{ photos : has
    users ||--o{ saved_listings : saves
    applications ||--o{ application_documents : has
```

Key fields (planned): `listings(status, kind off_campus|on_campus|sublease, owner_id)`.
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
`/login`, `/register`, static files, and `/health`.)

After deploying, verify the public health endpoint on the service URL:

```bash
SERVICE_URL=$(gcloud run services describe stable --region REGION --format='value(status.url)')
curl --fail-with-body "$SERVICE_URL/health"
# Expected: {"status":"ok"} with HTTP 200, without login or a session cookie.
```

Use `/health` for external health checks; `/healthz` conflicts with Cloud Run's reserved paths.

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

| #   | Scenario                                                                                                      | Accounts used    | Expected                                                                                                                            | Actual                      |
| --- | ------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | Register a student with an `@scu.edu` email                                                                   | new student      | 302 → dashboard, ACTIVE, argon2id hash, `/api/me` has no hash                                                                       | ✅ pass (automated)         |
| 2   | Register a student with `gmail.com`, `scu.edu.evil.com`, or `notscu.edu`                                      | 3 anonymous      | 400, no user created                                                                                                                | ✅ pass (automated)         |
| 3   | Public registration with `role=ADMIN`                                                                         | anonymous        | 400, no admin created                                                                                                               | ✅ pass (automated)         |
| 4   | Register a landlord                                                                                           | new landlord     | PENDING                                                                                                                             | ✅ pass (automated)         |
| 5   | Missing fields, short password, duplicate email                                                               | anonymous        | 400 / 400 / 409                                                                                                                     | ✅ pass (automated)         |
| 6   | Form POST without a CSRF token                                                                                | anonymous        | 403                                                                                                                                 | ✅ pass (automated)         |
| 7   | Login changes the session id; cookie is HttpOnly and SameSite=Lax                                             | student          | new sid                                                                                                                             | ✅ pass (automated)         |
| 8   | Wrong password and unknown email                                                                              | anonymous        | same 401 message                                                                                                                    | ✅ pass (automated)         |
| 9   | Logout, then replay the old cookie from another client                                                        | student          | session row deleted; 401                                                                                                            | ✅ pass (automated)         |
| 10  | Suspended user                                                                                                | student          | existing session 401; login 401                                                                                                     | ✅ pass (automated)         |
| 11  | Anonymous access to `/`, `/dashboard`, `/dashboard/admin`, an unknown path                                    | anonymous        | 302 → `/login`                                                                                                                      | ✅ pass (automated)         |
| 12  | Anonymous `GET /api/me`                                                                                       | anonymous        | 401 `{ error: { code, message } }`                                                                                                  | ✅ pass (automated)         |
| 13  | Student opens the admin or landlord dashboard                                                                 | student          | 403                                                                                                                                 | ✅ pass (automated)         |
| 14  | Pending landlord submits a listing                                                                            | pending landlord | 403 `ACCOUNT_PENDING`                                                                                                               | ✅ pass (automated)         |
| 15  | Active landlord submits (feature stub)                                                                        | active landlord  | passes checks → 501                                                                                                                 | ✅ pass (automated)         |
| 16  | Invalid route param                                                                                           | active landlord  | 400 `VALIDATION_ERROR`                                                                                                              | ✅ pass (automated)         |
| 17  | Ownership helper: owner, admin, other landlord                                                                | unit test        | allow, allow, 404                                                                                                                   | ✅ pass (automated)         |
| 18  | `seed:admin` twice, then with an existing non-admin email                                                     | script           | created → exists (hash unchanged) → conflict (not promoted)                                                                         | ✅ pass (automated)         |
| 19  | Student A applies, Landlord reviews, Student C (not in the group) reads the application                       | A, L, C          | C gets 404                                                                                                                          | TODO                        |
| 20  | Two groups accept offers for the same unit at the same time                                                   | groups 1 and 2   | exactly one is accepted                                                                                                             | TODO                        |
| 21  | Offer past its deadline                                                                                       | group, landlord  | `expired`, unit available                                                                                                           | TODO                        |
| 22  | Cost split: $4,000 rent + $200 utilities, 3 people                                                            | unit test        | $1,400.00 each; shares are equal                                                                                                    | ✅ pass (automated)         |
| 23  | Data still present after a redeploy (account, listing, uploaded floor plan)                                   | any              | all present                                                                                                                         | TODO (manual, on Cloud Run) |
| 24  | Create group (form) → invite 2 → both accept                                                                  | A, B, C          | not ready while pending; ready after; 5 audit events                                                                                | ✅ pass (automated)         |
| 25  | Invite an email before that person registers; they register and accept                                        | A, D             | invite appears right after registering; D becomes a member                                                                          | ✅ pass (automated)         |
| 26  | Invite a registered vs. an unregistered email                                                                 | A                | identical status and response shape                                                                                                 | ✅ pass (automated)         |
| 27  | Decline, then the owner re-invites                                                                            | A, B             | B accepts; still one invitation row                                                                                                 | ✅ pass (automated)         |
| 28  | Owner cancels an invite; invitee then tries to accept                                                         | A, B             | invite gone; accept 404; second cancel 409                                                                                          | ✅ pass (automated)         |
| 29  | Transfer ownership, then the old owner leaves                                                                 | A, B             | B owns; A gets 404 on the group                                                                                                     | ✅ pass (automated)         |
| 30  | Owner leaves while other members remain                                                                       | A, B             | 409 `TRANSFER_OWNERSHIP_FIRST`                                                                                                      | ✅ pass (automated)         |
| 31  | Transfer to a non-member or to yourself                                                                       | A                | 400                                                                                                                                 | ✅ pass (automated)         |
| 32  | Sole owner leaves                                                                                             | A, B (invited)   | DISBANDED, invite CANCELLED, `DISBANDED` event                                                                                      | ✅ pass (automated)         |
| 33  | Join a second group for the same term (accept, then create)                                                   | A, B, C          | 409 `ALREADY_IN_GROUP_FOR_TERM`; another term works                                                                                 | ✅ pass (automated)         |
| 34  | Two simultaneous accepts for the same term                                                                    | B                | exactly one 200, one 409; one membership row                                                                                        | ✅ pass (automated)         |
| 35  | Stranger opens the group or tries any action                                                                  | S                | 404 everywhere; no events written                                                                                                   | ✅ pass (automated)         |
| 36  | Non-owner member or invitee invites, cancels, or transfers                                                    | B, C             | 403; invitee doesn't see pending emails or history                                                                                  | ✅ pass (automated)         |
| 37  | Landlord uses group routes; admin views a group                                                               | L, admin         | landlord 403; admin 200 to view, 403 to act                                                                                         | ✅ pass (automated)         |
| 38  | Malformed term or empty name (JSON and HTML form)                                                             | A                | 400 with field errors; form re-rendered; no group created                                                                           | ✅ pass (automated)         |
| 39  | Malformed uuid in a route                                                                                     | A                | 400                                                                                                                                 | ✅ pass (automated)         |
| 40  | Non-`@scu.edu` invite, self-invite, duplicate invite                                                          | A                | 400 / 400 / 409 `INVITE_EXISTS`                                                                                                     | ✅ pass (automated)         |
| 41  | 16th seat, then 17th seat                                                                                     | A                | 16th 201; 17th 409 `GROUP_FULL`                                                                                                     | ✅ pass (automated)         |
| 42  | Past term (`FALL-2025`) or a term past the 6-quarter window                                                   | A                | 400 "Choose one of the upcoming terms"                                                                                              | ✅ pass (automated)         |
| 43  | Create form term dropdown                                                                                     | A                | options = `upcomingTerms()`, labels like "Fall 2026"                                                                                | ✅ pass (automated)         |
| 44  | `upcomingTerms()` on fixed dates (Nov 9 2026, Jan 15 2027, quarter edges, Dec 31 Pacific)                     | unit test        | current quarter + next 5, year rolls over after FALL                                                                                | ✅ pass (automated)         |
| 45  | Ben accepts, then the owner cancels the same invite                                                           | A, B             | cancel 409 `INVITE_NOT_PENDING`; Ben stays a member                                                                                 | ✅ pass (automated)         |
| 46  | Sole owner disbands, then the invitee accepts with the old invite id                                          | A, B             | 404; no membership; no `INVITE_ACCEPTED` event                                                                                      | ✅ pass (automated)         |
| 47  | Race ×10: accept vs. owner cancel, sent at the same time (`Promise.all`)                                      | A, B             | accept-first: 1 membership, cancel 409; cancel-first: accept 404, no membership or `INVITE_ACCEPTED`; never a `PENDING` invite left | ✅ pass (automated)         |
| 48  | Race ×10: accept vs. sole owner leaving (disband)                                                             | A, B             | accept-first: leave 409 `TRANSFER_OWNERSHIP_FIRST`, group ACTIVE; disband-first: accept 404, DISBANDED, no membership               | ✅ pass (automated)         |
| 49  | Chained `validate()` (params, then body): both pass, second fails, first fails, unknown keys, function `view` | unit test        | merged `req.valid`; 400 with only the failing validator's fields; handler never runs; unknown keys dropped                          | ✅ pass (automated)         |
| 50  | Two chained schemas declare the same key (`params.id` vs. `body.id`)                                          | unit test        | different values: 400 `VALIDATION_ERROR`, no overwrite; same value: allowed                                                         | ✅ pass (automated)         |
| 51  | Uneven split: $4,000.00 for 3 people                                                                          | unit test        | $1,333.34 + $1,333.33 + $1,333.33; adds up to $4,000.00                                                                             | ✅ pass (automated)         |
| 52  | Split for 1 person and for 16 people                                                                          | unit test        | 1 person pays all; 16 shares add up exactly, differ by ≤ 1¢                                                                         | ✅ pass (automated)         |
| 53  | Typing amounts: 4000, 4000.5, $4,000.50, 4,000 are accepted                                                   | unit test        | correct cents (e.g. 400050)                                                                                                         | ✅ pass (automated)         |
| 54  | Typing amounts: negative, 3 decimals, letters, empty, "4,00", "1.2.3", over $100,000                          | unit test        | refused with a plain-English message                                                                                                | ✅ pass (automated)         |
| 55  | On- vs. off-campus comparison (off cheaper, on cheaper, same, none entered)                                   | unit test        | right totals and the cheaper option                                                                                                 | ✅ pass (automated)         |
| 56  | Save an estimate with the form, then open it                                                                  | student          | page shows $4,200.00 a month and $1,400.00 each                                                                                     | ✅ pass (automated)         |
| 57  | Bad form input (every field)                                                                                  | student          | 400; form shown again with a message per field; nothing saved                                                                       | ✅ pass (automated)         |
| 58  | Another student opens or deletes my estimate                                                                  | A, S             | 404 (same as a missing estimate); estimate still there                                                                              | ✅ pass (automated)         |
| 59  | Landlord uses cost pages; logged-out visitor opens them                                                       | L, anonymous     | landlord 403; visitor sent to `/login` (API: 401)                                                                                   | ✅ pass (automated)         |
| 60  | Link a group and leave "people" blank                                                                         | A, B             | people = group size (2)                                                                                                             | ✅ pass (automated)         |
| 61  | Link a group I'm not in, or am only invited to                                                                | S, C             | 404; nothing saved                                                                                                                  | ✅ pass (automated)         |
| 62  | Link a group, leave it, then open the estimate                                                                | B                | "Linked group no longer available"; no group details shown                                                                          | ✅ pass (automated)         |
| 63  | Insert bad rows straight into the database (people 0 or 17, negative money, etc.)                             | unit test        | database refuses every one                                                                                                          | ✅ pass (automated)         |
| 64  | Save an estimate, then read it from a brand-new app instance                                                  | student          | same estimate and results (data lives in Postgres)                                                                                  | ✅ pass (automated)         |
| 65  | Delete my own estimate                                                                                        | student          | gone; opening it again gives 404                                                                                                    | ✅ pass (automated)         |
| 66  | Application rules match the Workflow C diagram (the test reads the diagram)                                   | unit test        | exactly the diagram's moves, each by the same actor                                                                                 | ✅ pass (automated)         |
| 67  | Every allowed application move, made by the right person                                                      | unit test        | allowed                                                                                                                             | ✅ pass (automated)         |
| 68  | Moves the diagram doesn't allow (e.g. submitted → offered, offered → withdrawn)                               | unit test        | refused: "can't go from … to …"                                                                                                     | ✅ pass (automated)         |
| 69  | Each move made by the wrong person (e.g. a group member making an offer)                                      | unit test        | refused, naming who can make that move                                                                                              | ✅ pass (automated)         |
| 70  | Any move out of a finished application (accepted, declined, expired, rejected, withdrawn)                     | unit test        | refused: it can't change any more                                                                                                   | ✅ pass (automated)         |
| 71  | Offer deadline: 1 ms before, exactly at, and 1 ms after                                                       | unit test        | accept works only before it; at the deadline it's expired                                                                           | ✅ pass (automated)         |
| 72  | Accept or expire an offer without passing the deadline                                                        | unit test        | refused (`MISSING_DEADLINE`), so the check can't be skipped                                                                         | ✅ pass (automated)         |
| 73  | Group size vs. unit: equal, one too many, beds vs. bedrooms, 1 and 16 people, bad sizes                       | unit test        | fits only when size ≤ beds (or bedrooms if no beds)                                                                                 | ✅ pass (automated)         |
| 90  | Pending landlord adds a property, a unit, and a floor plan through the forms                                  | L                | 302s; all three on the property page                                                                                                | ✅ pass (automated)         |
| 91  | Saved values: state `ca`, rent `$2,400.50`, blank utilities                                                   | L                | `CA`; 240050 cents; 0; unit AVAILABLE                                                                                               | ✅ pass (automated)         |
| 92  | Owner edits all three; clears optional boxes                                                                  | L                | saved; cleared fields become null; money shown in dollars                                                                           | ✅ pass (automated)         |
| 93  | Duplicate unit label / floor plan name (same place vs. another one)                                           | L                | 409 `UNIT_LABEL_TAKEN` / `FLOOR_PLAN_NAME_TAKEN`; else ok                                                                           | ✅ pass (automated)         |
| 94  | Log in again and read the property (persistence)                                                              | L                | same data, rent still 240050                                                                                                        | ✅ pass (automated)         |
| 95  | Property: blank fields, bad ZIP/state, half a location, coordinates out of range                              | L                | 400 with the right field; nothing saved                                                                                             | ✅ pass (automated)         |
| 96  | Unit: beds 0/17/2.5, bedrooms "two", 1.3 baths, rent blank/negative/over $100k/`24,00`                        | L                | 400 with the right field; nothing saved                                                                                             | ✅ pass (automated)         |
| 97  | Studio (0 bedrooms, 1 bed), JSON numbers; HTML form with beds 40                                              | L                | 201; form re-shown with the error and typed values                                                                                  | ✅ pass (automated)         |
| 98  | Malformed and unknown ids                                                                                     | L                | 400 / 404                                                                                                                           | ✅ pass (automated)         |
| 99  | Another landlord opens or changes any of it                                                                   | L, L2            | 404 on every page and action; their list is empty                                                                                   | ✅ pass (automated)         |
| 100 | Student uses any property route                                                                               | L, S             | 403 everywhere; nothing changes                                                                                                     | ✅ pass (automated)         |
| 101 | Admin views all properties, then tries every edit                                                             | L, L2, admin     | 200 with owner email; 403 on every edit; nothing changes                                                                            | ✅ pass (automated)         |
| 102 | Anonymous access; landlord POST without a CSRF token                                                          | anonymous, L     | 302 → `/login` / 401; 403 and nothing saved                                                                                         | ✅ pass (automated)         |
| 103 | Money parser and formatter (`src/utils/money.js`)                                                             | unit test        | exact cents; bad input refused; `$2,400.50` formatting                                                                              | ✅ pass (automated)         |
| 104 | Apply → request documents → send documents → review → offer → decline                                         | A, B, L          | each move works; 6 event rows with actor, from/to status, and comment                                                               | ✅ pass (automated)         |
| 105 | Pages: the group's applications and history; the landlord's incoming list with buttons                        | A, L             | buttons match `allowedMoves()` for each person and status                                                                           | ✅ pass (automated)         |
| 106 | Apply and reject through the HTML forms, then apply again                                                     | A, L             | redirects to the right page; a finished application doesn't block a new one                                                         | ✅ pass (automated)         |
| 107 | Apply as a non-member; group not ready; group too big; unit leased                                            | S, A             | 404 / 409 `GROUP_NOT_READY` / 409 `GROUP_TOO_BIG` / 409 `UNIT_NOT_AVAILABLE`                                                        | ✅ pass (automated)         |
| 108 | Apply to a pending landlord's unit or a missing unit                                                          | A                | 404                                                                                                                                 | ✅ pass (automated)         |
| 109 | Apply twice for the same unit; withdraw; apply again                                                          | A, B             | 409 `ALREADY_APPLIED`, then 201                                                                                                     | ✅ pass (automated)         |
| 110 | Race ×10: two members apply at the same moment                                                                | A, B             | exactly one 201 and one 409 each time; one application                                                                              | ✅ pass (automated)         |
| 111 | Second offer on the same unit; rescind; offer again                                                           | L, C             | 409 `UNIT_HAS_OPEN_OFFER`, then the new offer works                                                                                 | ✅ pass (automated)         |
| 112 | Offer deadline in the past, over 14 days, both or neither given, malformed                                    | L                | 400                                                                                                                                 | ✅ pass (automated)         |
| 113 | Illegal moves (offer before review; "start review" on an offer)                                               | L                | 409 with the workflow's reason; nothing changes                                                                                     | ✅ pass (automated)         |
| 114 | Offer expiry: 1 ms before, exactly at, and after the deadline                                                 | unit test        | expires exactly at the deadline; one `SYSTEM` event, only once                                                                      | ✅ pass (automated)         |
| 115 | Past deadline, then four reads at the same moment; decline after it expired                                   | A, B, L          | `EXPIRED` with exactly one event; decline gets 409                                                                                  | ✅ pass (automated)         |
| 116 | Outsider student and another landlord on someone else's application                                           | S, L2            | 404 on every page and move; nothing changes                                                                                         | ✅ pass (automated)         |
| 117 | Student on landlord moves; landlord on group moves; wrong actor past the routes                               | A, L             | 403                                                                                                                                 | ✅ pass (automated)         |
| 118 | Admin views and tries to act; pending landlord acts; logged-out visitor                                       | admin, P, anon   | admin 200 to view, 403 to act; `ACCOUNT_PENDING`; `/login` (API 401)                                                                | ✅ pass (automated)         |
| 119 | Bad ids, missing or too-long comments, bad group id                                                           | A, L             | 400; nothing changes                                                                                                                | ✅ pass (automated)         |
| 120 | Insert an OFFERED application without a deadline straight into the database                                   | unit test        | database refuses it (CHECK constraint)                                                                                              | ✅ pass (automated)         |
| 121 | Group X's offer passes its deadline unread; the landlord offers the same unit to group Y                      | L, A, C          | Y's offer works; X becomes `EXPIRED` with exactly one `SYSTEM` event                                                                | ✅ pass (automated)         |
| 122 | Accept an offer (API and the page button)                                                                     | A, B             | unit `LEASED`, application `ACCEPTED`, event written; no more buttons                                                               | ✅ pass (automated)         |
| 123 | Accept closes the unit's other open applications and the group's other open ones                              | A, C, L          | each `CLOSED` with a `SYSTEM` event and its reason; finished ones untouched                                                         | ✅ pass (automated)         |
| 124 | A group that accepted a place applies somewhere else                                                          | A                | 409 `GROUP_ALREADY_PLACED`                                                                                                          | ✅ pass (automated)         |
| 125 | Race ×5: two members accept at the same moment                                                                | A, B             | exactly one 200 and one 409; unit leased once; one acceptance                                                                       | ✅ pass (automated)         |
| 126 | Race ×6: accept vs. the landlord rescinding                                                                   | A, L             | exactly one wins; the other gets 409; unit leased only if accept won                                                                | ✅ pass (automated)         |
| 127 | Race ×6: accept vs. another group applying to the same unit                                                   | A, C             | no open application is ever left on the leased unit                                                                                 | ✅ pass (automated)         |
| 128 | Accept exactly at the deadline; 1 ms before; after it passed (HTTP)                                           | A                | at/after: 409 and stays `EXPIRED` (one event); 1 ms before: accepted                                                                | ✅ pass (automated)         |
| 129 | Accept after the group grew too big, got a new invite, or the unit was leased                                 | A                | 409 `GROUP_TOO_BIG` / `GROUP_NOT_READY` / `UNIT_NOT_AVAILABLE`; nothing changes                                                     | ✅ pass (automated)         |
| 130 | Accept after the landlord's account stopped being ACTIVE                                                      | A, L             | 409 `LANDLORD_NOT_ACTIVE`; unit not leased                                                                                          | ✅ pass (automated)         |
| 131 | Outsider, landlord, and admin try to accept; bad or missing id; not yet offered                               | S, L, admin      | 404 / 403 / 403; 400 / 404; 409 with the workflow's reason                                                                          | ✅ pass (automated)         |
| 132 | Apply through the page when it's refused (already applied; group not ready)                                   | A, B             | apply page shown again with the message; a link to the existing application                                                         | ✅ pass (automated)         |
| 133 | Open the apply page for a unit that isn't available                                                           | A                | no Submit button; a short note instead                                                                                              | ✅ pass (automated)         |
| 134 | Term shown on the applications pages and the group page                                                       | A                | friendly label ("Fall 2026"), never the raw value                                                                                   | ✅ pass (automated)         |
| 135 | History after an offer, and after rescinding and offering again                                               | A, L             | the latest "Offer made" line shows its deadline                                                                                     | ✅ pass (automated)         |
| 136 | Each trigger: apply, every landlord and group move, accept and what it closes, an offer expiring              | A, B, S, L, Lia  | the right people get exactly one each; nobody gets one for their own action                                                         | ✅ pass (automated)         |
| 137 | Invite an email that has an account, and one that doesn't                                                     | A                | a notification only for the account; the owner gets the same response either way                                                    | ✅ pass (automated)         |
| 138 | A refused move; a transaction that fails after writing a notification                                         | S, L             | no notification is left behind                                                                                                      | ✅ pass (automated)         |
| 139 | Links `//x`, `https://x`, `/\x`, `javascript:…` (in code, and straight into the database)                     | none             | refused by the code and by the CHECK constraint                                                                                     | ✅ pass (automated)         |
| 140 | Notifications page, header badge, and `/api/notifications`                                                    | A, B, L          | newest first, only my own, the unread count in the header                                                                           | ✅ pass (automated)         |
| 141 | A comment containing HTML, shown on the notifications page                                                    | A, L             | shown as text (escaped), never as markup                                                                                            | ✅ pass (automated)         |
| 142 | Mark one read (form, API, twice), then mark all                                                               | A, B, L          | only my own change; marking twice keeps the first read time                                                                         | ✅ pass (automated)         |
| 143 | Mark someone else's notification read; a missing id                                                           | A, Lia           | 404; theirs stays unread                                                                                                            | ✅ pass (automated)         |
| 144 | Bad id, no CSRF token, logged out (anonymous); an admin's page                                                | A, L, admin      | 400 / 403 / redirect to login; the admin's page is empty                                                                            | ✅ pass (automated)         |

Latest run (local, 2026-11-26): **305 tests, 15 files, all passing.**

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
- **Invitations are matched by email, and email ownership isn't verified yet.** An invitation shows up for
  whatever account registered with that address. Someone who registers an `@scu.edu` address they don't own
  could see (and accept) invitations sent to it. Invite links with a one-time token (planned) or email
  verification would fix this.
- Invitations are in-app only: no email is sent, so the owner has to tell the person to log in or register.
- A student can be invited to several groups for the same term, but can join only one (the others get 409 on accept).
- Properties, units, and floor plans can't be deleted yet (listings and applications will point at units).
- Map coordinates are typed in by hand. There's no address lookup (geocoding) yet.
- **Applications are only re-checked at the end.** The group's size and readiness are checked when it applies and
  again when it accepts an offer. In between, if someone leaves or joins, the application stays open and the
  landlord's moves still work; a group that no longer fits finds out when it tries to accept.
- Leaving or disbanding a group doesn't withdraw its open applications yet.
- "Send documents" only records a comment for now; uploading the files arrives with Google Cloud Storage (A4).
- There are no listings yet (A3), so students reach a unit's apply page by link, and any ACTIVE landlord's unit
  can be applied to. Once A3 lands, only units with an approved listing will accept applications.
- Offers expire when someone next looks at the application (or tries to act on it), not on a timer. Nobody
  sees the old status, but the expiry is recorded at that moment, not exactly at the deadline.
- Notifications are in-app only (no email), and a page shows new ones only after it's reloaded. The page lists
  the latest 100.
- An invite notifies only a student who already has an account. Someone who registers later still sees the
  invite on their groups page, but gets no notification for it.
- Student subleases (B6 part 2) wait for listings (A3), since a sublease is a listing a student owns.
- A leased unit stays leased. There's no lease end date or "cancel the lease" action yet, so a unit can't become
  available again through the app.
- TODO: add more as features land.

## Team contributions

### Henrique Oliveira

TODO: features built, PRs authored, PRs reviewed.

### Riley Conrad

- B1: roommate groups (schema and migration, service with row locking, routes, pages, tests, README).
- B2: cost calculator (pure math service in cents, strict dollar parser, saved estimates with an optional group
  link, database CHECK constraints, pages, tests, README).
- TODO: PRs authored, PRs reviewed.

## AI usage

- **Claude Code** (Anthropic) generated the initial repository skeleton: folder structure, auth foundation,
  middleware, tests, CI, Dockerfile, and this README's structure. The team reviewed it and can explain every file.
- `CLAUDE.md` (and `AGENTS.md`, which points to it) gives every AI session the same rules: no secrets, login and
  authorization on every route, migrations only, plain JavaScript, small PRs.
- `.claude/settings.json` denies the agent read access to `.env` and key files.
- **B1 (roommate groups):** Riley wrote the requirements. Claude Code proposed a plan, and Riley approved it with
  changes: lock the group row in leave/transfer/cancel, add the email-verification limitation, and comment the lock
  order and the `(user_id, term)` backstop. Claude Code then wrote the code, tests, and README updates.
- **B2 (cost calculator):** Riley wrote the requirements. Claude Code proposed a plan. Riley approved it and
  added changes: accept "$" and thousands commas, plain-English error messages, CHECK constraints in the database,
  cascade delete for a user's estimates, and hiding a linked group's details after the student leaves it. Claude
  Code then wrote the code, tests, and README updates.
- TODO: record later AI usage per feature (what was generated, what was changed by hand, and the AI security review).

## Roadmap

Next PR-sized tasks. **Member A:** auth hardening, listings and approval, uploads, map. **Member B:** groups,
the application state machine, offers, and the cost calculator.

| Member A                                                                       | Member B                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| A1. Admin: list pending landlords; approve or reject; promote to admin         | ✅ B1. Schema + service: roommate groups per term, invites, accept/decline, "ready"  |
| ✅ A2. Properties, units, floor plans (create/edit with ownership + tests)     | ✅ B2. Cost calculator service + page (cents, rent split, on- vs. off-campus)        |
| A3. Listing state machine + admin review queue with comments                   | ✅ B3. Application schema + state machine + `application_events`                     |
| A4. GCS uploads (multer memory, type/size checks) for floor plans and photos   | ✅ B4. Landlord review actions (document upload comes with A4)                       |
| A5. Map page (Leaflet, vendored) + JSON endpoint + haversine and price filters | ✅ B5. Accept offer with a transaction and `FOR UPDATE`; auto-close the rest; expiry |
| A6. Seeded demo listings (`seed:demo`) + saved listings                        | ✅ B6 part 1. In-app notifications · part 2: student subleases (after A3)            |

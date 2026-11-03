## Summary

<!-- What does this PR change, and why? Keep PRs small: one feature or fix. -->

## Linked issue

Closes #

## How it was tested

<!-- Which accounts/roles did you use? e.g. "Student A (a@scu.edu) applied, Landlord L reviewed, Student C got 404". -->

- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] Manual test with accounts:

## Screenshots

<!-- UI changes only. -->

## Security checklist

- [ ] Every new route requires login (or is deliberately added to `src/routes/public.routes.js`)
- [ ] Authorization is enforced **on the server** (role + record ownership), with a test proving an unauthorized user gets 403/404
- [ ] All input is validated with zod
- [ ] No secrets, credentials, or `.env` values in the diff
- [ ] Schema changes are a **new** Prisma migration (no edits to old migrations, no reset/db push)
- [ ] Uploads go to GCS, not the local filesystem
- [ ] README updated if behavior changed

## Review rule (required by the course)

> **Reviewer:** leave at least one substantive **line-level** comment (Files changed → click a line → comment).
> **Author:** push a commit that addresses it and reply with the commit hash before merging.

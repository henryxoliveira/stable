/**
 * Placeholder dashboards, one per role. Real content arrives in later PRs.
 */
const DASHBOARD_PATH = {
  STUDENT: '/dashboard/student',
  LANDLORD: '/dashboard/landlord',
  ADMIN: '/dashboard/admin',
};

/** /dashboard sends each user to their own role's dashboard. */
export function redirectToRoleDashboard(req, res) {
  res.redirect(DASHBOARD_PATH[req.user.role]);
}

export const student = (req, res) => res.render('dashboard/student');
export const landlord = (req, res) => res.render('dashboard/landlord');
export const admin = (req, res) => res.render('dashboard/admin');

/** GET /api/me: the logged-in user (never includes the password hash). */
export function me(req, res) {
  res.json({ user: req.user });
}

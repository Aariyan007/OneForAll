// Paths the proxy lets signed-out visitors open. Everything else redirects to /login.
// /invitations is public: it explains the invitation and offers sign-in; accepting still requires a session.
// /api/health is public so uptime checks can reach it; it reveals only up/down states.
const PUBLIC_PATHS = ["/", "/login", "/signup", "/auth", "/invitations"];
const PUBLIC_EXACT_PATHS = ["/api/health"];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT_PATHS.includes(pathname)) return true;
  return PUBLIC_PATHS.some((path) => pathname === path || (path !== "/" && pathname.startsWith(`${path}/`)));
}

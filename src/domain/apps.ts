/** App resolution from X-Client-Package (pkg/utils/auth/auth.go GetApp). */

export type App = 'photos' | 'auth' | 'locker';

const AUTH_PACKAGES = ['io.ente.auth', 'io.ente.auth.web'];
const LOCKER_PACKAGES = ['io.ente.locker', 'io.ente.locker.web'];

export const appFromClientPackage = (clientPackage: string | undefined): App => {
  if (clientPackage && AUTH_PACKAGES.includes(clientPackage)) return 'auth';
  if (clientPackage && LOCKER_PACKAGES.includes(clientPackage)) return 'locker';
  return 'photos';
};

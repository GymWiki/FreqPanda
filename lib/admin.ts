// This app has no real admin-role system — one operator account owns
// everything infra-related (creating/deleting the permanent data server,
// etc.). Used by app/api/admin/data-server.
const DEFAULT_ADMIN_EMAIL = "pieter.kluvers06@gmail.com";

export function isAdminUser(email: string | null | undefined): boolean {
  if (!email) return false;
  const adminEmail = process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
  return email.toLowerCase() === adminEmail.toLowerCase();
}

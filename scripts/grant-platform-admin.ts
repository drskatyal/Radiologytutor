// Grant platform super_admin to someone who already has an account.
//
// There is no public "sign up as admin" door and no password in this script.
// They create a teacher or student account in the app, then an operator runs:
//
//   npm run admin:grant -- person@hospital.edu
//
// The command uses the same store as the app: MONGODB_URI when set, otherwise
// the local JSON store (DATA_DIR). After it succeeds they sign in with that
// email and password, or Google, and land on /admin. From the Platform tab
// they can grant further admins the same way, by email of an existing account.

import { AccountNotFoundError, grantPlatformAdminByEmail } from "../lib/cases";

async function main() {
  const email = process.argv.slice(2).find((arg) => !arg.startsWith("-"))?.trim();
  if (!email) {
    console.error("Usage: npm run admin:grant -- person@hospital.edu");
    process.exit(1);
  }

  try {
    const user = await grantPlatformAdminByEmail(email);
    console.log(`Platform admin: ${user.email} (${user.id})`);
  } catch (err) {
    if (err instanceof AccountNotFoundError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

// Test-only accounts, created in the halcyon_test database by e2e/seed-accounts.sh before the server starts.
export const STAFF = { email: 'staff@halcyon.test', password: 'e2e-only-staff-password' };
export const CUSTOMER = { email: 'buyer@c055.test', password: 'e2e-only-buyer-password' };
export const STAFF_STATE = 'e2e/.auth/staff.json';

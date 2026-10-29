// Creates the e2e test accounts in the test database with the account tool (the same code that creates real accounts).
import { execFileSync } from 'node:child_process';
import { STAFF, CUSTOMER } from './accounts.js';

const add = (args, password) => execFileSync('node', ['server/scripts/users.mjs', 'add', ...args, '--password-stdin'], { input: password, stdio: ['pipe', 'inherit', 'inherit'] });
add(['--email', STAFF.email, '--role', 'staff', '--name', 'E2E staff'], STAFF.password);
add(['--email', CUSTOMER.email, '--role', 'customer', '--client', 'C055'], CUSTOMER.password);

// Website accounts, managed in Postgres. Uses DATABASE_URL (or PG* variables); passwords are typed at a hidden prompt.
//   npm --prefix server run users -- list
//   npm --prefix server run users -- add --email ops@halcyon.com --role staff [--name "Ops team"]
//   npm --prefix server run users -- add --email buyer@acme.com --role customer --client C176
//   npm --prefix server run users -- reset-password --email ops@halcyon.com
//   npm --prefix server run users -- disable --email buyer@acme.com      (enable to undo)
// --password-stdin reads the password from standard input instead (for scripted test setup only).
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { pool } from '../src/db.js';
import { ensureUserTable, userStore, clientExists } from '../src/auth/users.js';
import { addAccount, setPassword, setActive } from '../src/auth/accounts.js';

const [command, ...rest] = process.argv.slice(2);
const { values: o } = parseArgs({ args: rest, options: {
  email: { type: 'string' }, role: { type: 'string' }, client: { type: 'string' }, name: { type: 'string' }, 'password-stdin': { type: 'boolean' },
} });

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.replace(/\r?\n$/, '');
}

/** Asks twice at a prompt that does not echo what is typed. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (!rl.muted) rl.output.write(s); };
    rl.question(question, (answer) => { rl.output.write('\n'); rl.close(); resolve(answer); });
    rl.muted = true;
  });
}

async function password() {
  if (o['password-stdin']) return readStdin();
  if (!process.stdin.isTTY) throw new Error('Run this in a terminal (or use --password-stdin for scripted test setup)');
  const first = await askHidden('Password (at least 12 characters): ');
  if (first !== await askHidden('Same password again: ')) throw new Error('The passwords did not match');
  return first;
}

const deps = { store: userStore, clientExists };
const need = (k) => o[k] || (() => { throw new Error(`--${k} is required`); })();

try {
  await ensureUserTable();
  if (command === 'list') {
    console.table((await userStore.list()).map(({ email, role, client_id, active, created_at, last_login_at }) =>
      ({ email, role, client: client_id ?? '', active, created: String(created_at).slice(0, 16), 'last sign-in': last_login_at ? String(last_login_at).slice(0, 16) : '' })));
  } else if (command === 'add') {
    const u = await addAccount({ email: need('email'), role: need('role'), client_id: o.client, name: o.name, password: await password() }, deps);
    console.log(`Added ${u.role} ${u.email}${u.client_id ? ` for client ${u.client_id}` : ''}`);
  } else if (command === 'reset-password') {
    await setPassword(need('email'), await password(), deps);
    console.log(`Password changed for ${o.email}; its existing sign-ins have ended`);
  } else if (command === 'disable' || command === 'enable') {
    await setActive(need('email'), command === 'enable', deps);
    console.log(`${o.email} ${command}d${command === 'disable' ? '; its sign-ins have ended' : ''}`);
  } else {
    console.log('Commands: list | add | reset-password | disable | enable  (see the top of scripts/users.mjs)');
    process.exitCode = command ? 1 : 0;
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

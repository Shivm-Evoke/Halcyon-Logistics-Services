// Drop-folder ingestion: files placed in <project>/inbox are processed automatically.
//   *.eml          -> email channel        *.edi, *.x12 -> EDI channel        C###_*.csv -> client file drop
// Each file moves to inbox/processed (or inbox/failed) with the reply written next to it.
import fs from 'node:fs';
import path from 'node:path';

export const INBOX_DIR = process.env.INBOX_DIR || path.resolve(import.meta.dirname, '../../../inbox');

const handlerFor = (ingest, name) => {
  if (/\.eml$/i.test(name)) return (raw) => ingest.email(raw, { filename: name });
  if (/\.(edi|x12)$/i.test(name)) return (raw) => ingest.edi(raw, { filename: name });
  if (/\.csv$/i.test(name)) return (raw) => ingest.csvFile(raw, { filename: name });
  return null;
};

export function watchInbox(ingest, dir = INBOX_DIR) {
  for (const sub of ['', 'processed', 'failed']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const busy = new Set();

  const processFile = async (name) => {
    const file = path.join(dir, name);
    const handle = handlerFor(ingest, name);
    if (!handle || busy.has(name) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return;
    busy.add(name);
    try {
      // Wait until the file stops growing (a copy may still be in progress).
      let size = -1;
      while (size !== fs.statSync(file).size) { size = fs.statSync(file).size; await new Promise((r) => setTimeout(r, 250)); }
      const result = await handle(fs.readFileSync(file, 'utf8'));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(file, path.join(dir, 'processed', `${stamp}_${name}`));
      if (result.reply) fs.writeFileSync(path.join(dir, 'processed', `${stamp}_${name}.reply.txt`), result.reply);
      console.log(`inbox: ${name} -> message ${result.message_id} (${result.status})`);
    } catch (e) {
      console.error(`inbox: ${name} failed`, e);
      if (fs.existsSync(file)) fs.renameSync(file, path.join(dir, 'failed', name));
    } finally {
      busy.delete(name);
    }
  };

  for (const name of fs.readdirSync(dir)) processFile(name);
  fs.watch(dir, (_event, name) => name && processFile(name));
  console.log(`Watching ${dir} for .eml, .edi and C###_*.csv files`);
}

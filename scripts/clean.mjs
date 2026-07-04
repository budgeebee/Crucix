// scripts/clean.mjs — delete Crucix runs/* files older than the current week (Mon-Sun).
//
// Keeps:
//   - runs/latest.json (current sweep — always)
//   - runs/memory/hot.json + .bak (current sweep delta — always)
//   - runs/memory/cold/<this-week>.json (Mon..Sun of current week)
//   - Anything from the current week
//
// Deletes:
//   - briefing_<ISO-timestamp>.json older than Monday of this week
//   - cold/YYYY-MM-DD.json older than current week
//
// Usage:
//   node scripts/clean.mjs              # dry-run (default)
//   node scripts/clean.mjs --apply      # actually delete
//   node scripts/clean.mjs --verbose    # log every checked file

import { readdir, stat, unlink, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(__dirname, '..', 'runs');
const COLD_DIR = join(RUNS_DIR, 'memory', 'cold');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');

function mondayOfThisWeek() {
  const now = new Date();
  const day = now.getUTCDay();          // 0=Sun, 1=Mon, ... 6=Sat
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  const mon = new Date(now);
  mon.setUTCDate(now.getUTCDate() + diff);
  mon.setUTCHours(0, 0, 0, 0);
  return mon;
}

function fileDate(filename) {
  // briefing_2026-07-03T18-50-23Z.json  →  "2026-07-03"
  const m = filename.match(/briefing_(\d{4}-\d{2}-\d{2})T/);
  return m ? m[1] : '';
}

function isOlderThanMonday(filename, cutoffDate) {
  const d = fileDate(filename);
  if (!d) return false;
  return d < cutoffDate;
}

async function listFiles(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function clean() {
  const cutoff = mondayOfThisWeek();
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let marked = 0;
  let bytesFreed = 0;

  // 1. Top-level briefing_*.json (timestamped archives)
  const top = await listFiles(RUNS_DIR);
  for (const name of top) {
    if (name === 'latest.json' || name === 'memory') continue;
    if (!name.startsWith('briefing_')) continue;
    if (!isOlderThanMonday(name, cutoffStr)) {
      if (VERBOSE) console.log(`  keep:     runs/${name}`);
      continue;
    }
    const full = join(RUNS_DIR, name);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (APPLY) {
      await unlink(full);
      console.log(`  deleted:  runs/${name} (${s.size.toLocaleString()} bytes)`);
    } else {
      console.log(`  would delete: runs/${name} (${s.size.toLocaleString()} bytes)`);
    }
    marked++;
    bytesFreed += s.size;
  }

  // 2. memory/cold/YYYY-MM-DD.json — daily archives from previous weeks
  const coldFiles = await listFiles(COLD_DIR);
  for (const name of coldFiles) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    if (name >= `${cutoffStr}.json`) {
      if (VERBOSE) console.log(`  keep:     runs/memory/cold/${name}`);
      continue;
    }
    const full = join(COLD_DIR, name);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (APPLY) {
      await unlink(full);
      console.log(`  deleted:  runs/memory/cold/${name} (${s.size.toLocaleString()} bytes)`);
    } else {
      console.log(`  would delete: runs/memory/cold/${name} (${s.size.toLocaleString()} bytes)`);
    }
    marked++;
    bytesFreed += s.size;
  }

  const mode = APPLY ? 'applied' : 'dry-run';
  console.log(`\n${mode}: ${marked} file(s) marked, ${bytesFreed.toLocaleString()} bytes`);
  console.log(`cutoff: anything dated before ${cutoffStr} (Monday of this week)`);
  if (!APPLY && marked > 0) {
    console.log('  (pass --apply to actually delete)');
  }
}

clean().catch(err => {
  console.error('clean failed:', err);
  process.exit(1);
});
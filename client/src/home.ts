// Locates an installed ProvideX (the folder holding pvxwin32.exe and Lib).
import * as fs from 'fs';
import * as path from 'path';

const EXE = 'pvxwin32.exe';

function isHome(dir: string): boolean {
  try { return fs.existsSync(path.join(dir, EXE)) && fs.existsSync(path.join(dir, 'Lib')); } catch { return false; }
}

/** Walks up from a path looking for ...\Home or ...\MAS90\Home. */
export function homeFromPath(p: string): string | undefined {
  let dir = p;
  for (let i = 0; i < 8; i++) {
    for (const c of [dir, path.join(dir, 'Home'), path.join(dir, 'MAS90', 'Home')]) if (isHome(c)) return c;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** First detected install (nearest to the hints). */
export function detectHome(hints: string[]): string | undefined {
  return detectHomes(hints)[0];
}

/** All ProvideX installs found: those near the hints first, then the usual Sage 100 / ProvideX locations. */
export function detectHomes(hints: string[]): string[] {
  const found: string[] = [];
  const add = (h: string | undefined) => { if (h && !found.some((f) => f.toLowerCase() === h.toLowerCase())) found.push(h); };
  for (const h of hints) add(homeFromPath(h));
  if (process.platform !== 'win32') return found;
  const roots: string[] = [];
  for (const d of 'CDEFGH') {
    const root = d + ':\\';
    if (!fs.existsSync(root)) continue;
    roots.push(root, path.join(root, 'Sage'), path.join(root, 'Program Files (x86)', 'Sage'), path.join(root, 'Program Files', 'Sage'), path.join(root, 'Program Files (x86)'), path.join(root, 'PVX'));
  }
  for (const r of roots) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(r); } catch { continue; }
    for (const e of entries) {
      if (!/sage|mas ?90|mas ?200|providex|pvx/i.test(e)) continue;
      const base = path.join(r, e);
      for (const c of [base, path.join(base, 'Home'), path.join(base, 'MAS90', 'Home')]) if (isHome(c)) add(c);
      // Sage 100\<instance>\MAS90\Home
      let subs: string[] = [];
      try { subs = fs.readdirSync(base); } catch { continue; }
      for (const s of subs) {
        for (const c of [path.join(base, s, 'MAS90', 'Home'), path.join(base, s, 'Home')]) if (isHome(c)) add(c);
      }
    }
  }
  return found;
}

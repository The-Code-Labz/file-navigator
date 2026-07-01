/**
 * File Navigator — self-hosted web file explorer + disk usage analytics
 * Runs on any Linux server. Default port 9079 (override with PORT env).
 *
 * Security: restricted to a ROOT directory (default: /). Path traversal is
 * blocked. Set FN_ROOT to jail the app to a subtree, and set FN_READONLY=true
 * to disable upload/delete/rename.
 */
'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || '9079', 10);
// The filesystem root the app is allowed to browse. Jail here for safety.
const ROOT = path.resolve(process.env.FN_ROOT || '/');
const READONLY = String(process.env.FN_READONLY || 'false').toLowerCase() === 'true';
// Optional basic auth: set FN_USER and FN_PASS to require login.
const AUTH_USER = process.env.FN_USER || '';
const AUTH_PASS = process.env.FN_PASS || '';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/*  Optional basic auth                                                */
/* ------------------------------------------------------------------ */
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || '';
    const [scheme, encoded] = hdr.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
      if (u === AUTH_USER && p === AUTH_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="File Navigator"');
    return res.status(401).send('Authentication required');
  });
}

/* ------------------------------------------------------------------ */
/*  Path safety — everything resolves inside ROOT                      */
/* ------------------------------------------------------------------ */
function safeResolve(userPath) {
  const target = path.resolve(ROOT, '.' + path.sep + (userPath || ''));
  const rel = path.relative(ROOT, target);
  // rel must not escape ROOT
  if (rel.startsWith('..') || path.isAbsolute(rel) === false && rel === '') {
    // rel === '' means target === ROOT, which is fine
  }
  if (rel.startsWith('..')) {
    throw Object.assign(new Error('Path escapes root'), { status: 403 });
  }
  return target;
}

// Convert an absolute path back to a ROOT-relative "/..." for the client.
function toClientPath(abs) {
  const rel = path.relative(ROOT, abs);
  return '/' + rel.split(path.sep).filter(Boolean).join('/');
}

/* ------------------------------------------------------------------ */
/*  Directory listing                                                  */
/* ------------------------------------------------------------------ */
app.get('/api/list', async (req, res) => {
  try {
    const dir = safeResolve(req.query.path || '/');
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      const abs = path.join(dir, d.name);
      let stat = null;
      try {
        stat = await fsp.lstat(abs);
      } catch {
        continue; // permission denied on this entry — skip
      }
      const isDir = stat.isDirectory();
      const isLink = stat.isSymbolicLink();
      entries.push({
        name: d.name,
        path: toClientPath(abs),
        type: isLink ? 'symlink' : isDir ? 'directory' : 'file',
        size: isDir ? null : stat.size,
        mtime: stat.mtimeMs,
        mode: stat.mode,
      });
    }
    // Folders first, then alphabetical
    entries.sort((a, b) => {
      if ((a.type === 'directory') !== (b.type === 'directory')) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    res.json({ path: toClientPath(dir), root: ROOT, readonly: READONLY, entries });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Disk usage — per-child folder size (the WinDirStat feature)        */
/*  Walks each immediate child directory to sum its size. Bounded so   */
/*  huge trees don't hang the request forever.                         */
/* ------------------------------------------------------------------ */
async function dirSize(dir, budget) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    if (budget.count > budget.max) break;
    const cur = stack.pop();
    let dirents;
    try {
      dirents = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      budget.count++;
      if (budget.count > budget.max) break;
      const abs = path.join(cur, d.name);
      let stat;
      try {
        stat = await fsp.lstat(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(abs);
      } else if (stat.isFile()) {
        total += stat.size;
      }
    }
  }
  return { total, truncated: budget.count > budget.max };
}

app.get('/api/usage', async (req, res) => {
  try {
    const dir = safeResolve(req.query.path || '/');
    // Cap total entries scanned across the whole request so a scan of /
    // can't run forever. Tune via FN_SCAN_LIMIT.
    const max = parseInt(process.env.FN_SCAN_LIMIT || '400000', 10);
    const budget = { count: 0, max };
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    const children = [];
    for (const d of dirents) {
      const abs = path.join(dir, d.name);
      let stat;
      try {
        stat = await fsp.lstat(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue; // don't follow links (loop safety)
      if (stat.isDirectory()) {
        const { total, truncated } = await dirSize(abs, budget);
        children.push({ name: d.name, path: toClientPath(abs), type: 'directory', size: total, truncated });
      } else if (stat.isFile()) {
        children.push({ name: d.name, path: toClientPath(abs), type: 'file', size: stat.size, truncated: false });
      }
    }
    children.sort((a, b) => b.size - a.size);
    const grandTotal = children.reduce((s, c) => s + c.size, 0);
    res.json({
      path: toClientPath(dir),
      total: grandTotal,
      scanned: budget.count,
      truncated: budget.count > budget.max,
      children,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Filesystem-level disk stats (df-style, per mount)                  */
/* ------------------------------------------------------------------ */
const { execFile } = require('child_process');
app.get('/api/disks', (req, res) => {
  execFile('df', ['-kP'], { timeout: 5000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'df failed: ' + err.message });
    const lines = stdout.trim().split('\n').slice(1);
    const disks = lines.map((line) => {
      const p = line.split(/\s+/);
      const size = parseInt(p[1], 10) * 1024;
      const used = parseInt(p[2], 10) * 1024;
      const avail = parseInt(p[3], 10) * 1024;
      return {
        filesystem: p[0],
        size,
        used,
        available: avail,
        usePercent: p[4],
        mount: p.slice(5).join(' '),
      };
    }).filter((d) => d.size > 0);
    res.json({ disks });
  });
});

/* ------------------------------------------------------------------ */
/*  Download a file                                                    */
/* ------------------------------------------------------------------ */
app.get('/api/download', async (req, res) => {
  try {
    const target = safeResolve(req.query.path || '');
    const stat = await fsp.lstat(target);
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
    res.download(target);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Raw view (for previewing text/images inline)                       */
/* ------------------------------------------------------------------ */
app.get('/api/raw', async (req, res) => {
  try {
    const target = safeResolve(req.query.path || '');
    const stat = await fsp.lstat(target);
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
    if (stat.size > 5 * 1024 * 1024) return res.status(413).json({ error: 'File too large to preview (>5MB)' });
    res.sendFile(target);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Mutations — guarded by READONLY                                    */
/* ------------------------------------------------------------------ */
function requireWrite(req, res, next) {
  if (READONLY) return res.status(403).json({ error: 'Server is in read-only mode' });
  next();
}

// Upload one or more files into a target directory
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        cb(null, safeResolve(req.query.path || '/'));
      } catch (err) {
        cb(err, '');
      }
    },
    filename: (req, file, cb) => cb(null, path.basename(file.originalname)),
  }),
  limits: { fileSize: parseInt(process.env.FN_MAX_UPLOAD || String(2 * 1024 * 1024 * 1024), 10) },
});

app.post('/api/upload', requireWrite, upload.array('files'), (req, res) => {
  res.json({ ok: true, uploaded: (req.files || []).map((f) => f.originalname) });
});

// Create a new folder
app.post('/api/mkdir', requireWrite, async (req, res) => {
  try {
    const target = safeResolve(path.join(req.body.path || '/', req.body.name || ''));
    if (!req.body.name) return res.status(400).json({ error: 'Name required' });
    await fsp.mkdir(target, { recursive: false });
    res.json({ ok: true, path: toClientPath(target) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Delete a file or folder (recursive)
app.post('/api/delete', requireWrite, async (req, res) => {
  try {
    const target = safeResolve(req.body.path || '');
    if (path.resolve(target) === ROOT) return res.status(403).json({ error: 'Refusing to delete root' });
    const stat = await fsp.lstat(target);
    if (stat.isDirectory()) {
      await fsp.rm(target, { recursive: true, force: true });
    } else {
      await fsp.unlink(target);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Rename / move
app.post('/api/rename', requireWrite, async (req, res) => {
  try {
    const from = safeResolve(req.body.from || '');
    const to = safeResolve(req.body.to || '');
    await fsp.rename(from, to);
    res.json({ ok: true, path: toClientPath(to) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Server info                                                        */
/* ------------------------------------------------------------------ */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    root: ROOT,
    readonly: READONLY,
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: os.uptime(),
  });
});

app.listen(PORT, () => {
  console.log(`File Navigator listening on http://0.0.0.0:${PORT}`);
  console.log(`  Root:      ${ROOT}`);
  console.log(`  Read-only: ${READONLY}`);
  console.log(`  Auth:      ${AUTH_USER ? 'enabled' : 'disabled'}`);
});

# 🗂️ File Navigator

A self-hosted, web-based **file explorer + disk usage analyzer** for any Linux server.

Think Windows Explorer meets WinDirStat, in your browser. Clone it onto any Linux
box, run it, and browse the filesystem, find what's eating your storage, and
upload / delete / rename files — all from a clean web UI.

![status](https://img.shields.io/badge/status-stable-brightgreen) ![node](https://img.shields.io/badge/node-%3E%3D18-blue) ![license](https://img.shields.io/badge/license-MIT-green)

---

## Features

- 📁 **Browse** the whole filesystem with a Windows-Explorer-style UI (breadcrumbs, icons, folders-first sorting)
- 📊 **Analyze folder sizes** — recursively sums each folder so you can see *what's using the most storage*, with visual usage bars and % of total (the "why is my disk full" feature)
- 💽 **Per-mount disk stats** — `df`-style capacity bars for every mounted filesystem in the sidebar
- ⬆️ **Upload** files (button or drag-and-drop) into the current folder
- 🗑️ **Delete** files and folders (recursive)
- ✏️ **Rename / move** entries
- 📁 **Create folders**
- ⬇️ **Download** and inline-preview files (text, images)
- 🌓 **Light / dark theme**
- 🔒 **Safe by design** — path-traversal blocked, optional root jail, optional read-only mode, optional basic auth

---

## Quick start

```bash
git clone https://github.com/The-Code-Labz/file-navigator.git
cd file-navigator
npm install
npm start
```

Then open **http://<server-ip>:9079** in your browser.

That's it. No build step, no database — a single Node process serves both the API and the UI.

---

## Configuration

All config is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9079` | HTTP port to listen on |
| `FN_ROOT` | `/` | Filesystem root the app may browse. **Set this to jail the app** to a subtree (e.g. `/home/user/data`) |
| `FN_READONLY` | `false` | When `true`, disables upload / delete / rename / mkdir |
| `FN_USER` / `FN_PASS` | *(unset)* | Set both to require HTTP Basic auth |
| `FN_MAX_UPLOAD` | `2147483648` | Max upload size in bytes (default 2 GB) |
| `FN_SCAN_LIMIT` | `400000` | Max files scanned per size-analysis request (prevents runaway scans of `/`) |

### Examples

Jail to a data directory, read-only, with a password:

```bash
FN_ROOT=/srv/data FN_READONLY=true FN_USER=admin FN_PASS=secret npm start
```

Run on a custom port:

```bash
PORT=9000 npm start
```

---

## Run as a service (systemd)

A ready-made unit is included in `deploy/file-navigator.service`:

```bash
sudo cp deploy/file-navigator.service /etc/systemd/system/
sudo nano /etc/systemd/system/file-navigator.service   # edit WorkingDirectory / User / env
sudo systemctl daemon-reload
sudo systemctl enable --now file-navigator
```

Check it:

```bash
systemctl status file-navigator
journalctl -u file-navigator -f
```

---

## API

The web UI is a thin client over a small JSON API:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/list?path=` | GET | List a directory |
| `/api/usage?path=` | GET | Per-child recursive folder sizes |
| `/api/disks` | GET | `df`-style per-mount capacity |
| `/api/download?path=` | GET | Download a file |
| `/api/raw?path=` | GET | Inline preview (<= 5 MB) |
| `/api/upload?path=` | POST | Multipart upload |
| `/api/mkdir` | POST | Create a folder |
| `/api/delete` | POST | Delete file/folder |
| `/api/rename` | POST | Rename / move |
| `/api/health` | GET | Server info |

---

## Security notes

- **Path traversal** is blocked — every path resolves inside `FN_ROOT`; `..` escapes return `403`.
- **This app runs with the permissions of the user that starts it.** Running as `root` gives it full filesystem access. For anything exposed beyond localhost, run it as a limited user, set `FN_ROOT` to jail it, enable `FN_USER`/`FN_PASS`, and put it behind HTTPS (nginx/Caddy).
- Symlinks are **not followed** during size scans (loop safety).
- The app **refuses to delete the root** directory.

---

## License

MIT — see [LICENSE](LICENSE).

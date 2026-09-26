#!/usr/bin/env python3
"""
Local admin server for mikehadfield.co.uk.

    python3 tools/admin_server.py            # then open http://127.0.0.1:8700/admin.html

Serves the site folder and adds a small, password-protected API that admin.html uses to save
project write-ups, upload their images, and edit the CV and home-page text. It only ever listens
on 127.0.0.1, and nothing here runs on GitHub Pages -- there, admin.html finds no API and opens
read-only. Saving writes files into this folder; review, commit and push as usual (the mirror
workflow is untouched).

Password: until one exists, admin.html asks you to choose it (the server only accepts
connections from this PC, and only while no password is set). It's stored as a salted PBKDF2 hash
in .admin-password (in .gitignore -- never commit it). Change it later with --set-password in a
terminal, or delete the file and choose again in the browser.

What gets written:
  content/projects/<slug>.json   one write-up (Markdown body + figures with hotspot pins)
  content/projects/index.json    the list the site reads (kept in step on every save)
  content/img/<slug>/            that write-up's images
  content/cv.json, content/site.json
  index.html                     the CV, bio and status line between their <!-- markers -->, so
                                 they're plain HTML for visitors and search engines

Standard library only.
"""
import argparse
import getpass
import hashlib
import hmac
import html
import http.server
import json
import os
import re
import secrets
import shutil
import sys
import tempfile
import threading
import time
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

DEFAULT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PORT = 8700

SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
FIG_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".svg"}
MAX_UPLOAD = 20 * 1024 * 1024
MAX_JSON = 4 * 1024 * 1024
SESSION_HOURS = 12
PBKDF2_ITERATIONS = 600_000


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# -- password --------------------------------------------------------------------------------

def hash_password(password: str, salt: bytes | None = None, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        algo, iterations, salt_hex, digest_hex = stored.strip().split("$")
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations))
        return hmac.compare_digest(digest.hex(), digest_hex)
    except ValueError:
        return False


def write_password_file(path: Path, password: str) -> None:
    write_atomic(path, (hash_password(password) + "\n").encode())
    os.chmod(path, 0o600)


# -- files -----------------------------------------------------------------------------------

def write_atomic(path: Path, data: bytes) -> None:
    """Temp file in the same folder, then rename -- a crash never leaves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def dump_json(obj) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode()


def splice(text: str, start: str, end: str, content: str) -> str:
    """Replace what's between two marker comments (markers kept). Loud if they're missing."""
    a = text.find(start)
    b = text.find(end, a + len(start)) if a >= 0 else -1
    if a < 0 or b < 0 or text.count(start) != 1:
        raise ApiError(f"index.html is missing its {start} ... {end} markers", 500)
    return text[:a + len(start)] + content + text[b:]


class Site:
    """Everything the API changes, relative to the site folder."""

    def __init__(self, root: Path):
        self.root = root
        self.projects = root / "content" / "projects"
        self.images = root / "content" / "img"
        self.index_path = self.projects / "index.json"
        self.lock = threading.Lock()  # one save at a time

    # projects ---------------------------------------------------------------------------
    def read_index(self) -> list:
        return json.loads(self.index_path.read_text()) if self.index_path.exists() else []

    def project_path(self, slug: str) -> Path:
        if not SLUG_RE.match(slug or ""):
            raise ApiError("slug must be lower-case letters, numbers and dashes")
        return self.projects / f"{slug}.json"

    @staticmethod
    def index_entry(p: dict) -> dict:
        return {k: p.get(k, "" if k != "tags" else []) for k in ("slug", "title", "summary", "tags", "status", "started", "updated")}

    def clean_project(self, p: dict, slug: str) -> dict:
        if not isinstance(p, dict):
            raise ApiError("project must be an object")
        s = lambda k: str(p.get(k) or "").strip()  # noqa: E731
        if not s("title"):
            raise ApiError("a project needs a title")
        if p.get("status") not in ("draft", "published"):
            raise ApiError("status must be draft or published")
        tags = p.get("tags") or []
        if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
            raise ApiError("tags must be a list of words")
        repo = s("repo")
        if repo.lower() == "private":
            repo = "private"  # shown on the site as an inactive "Private repo" button
        elif repo and not re.match(r"^https?://", repo):
            raise ApiError("the repo link must start with http:// or https:// (or just say private)")
        figures = {}
        for fid, f in (p.get("figures") or {}).items():
            if not FIG_ID_RE.match(fid) or not isinstance(f, dict):
                raise ApiError(f"bad figure id {fid!r}")
            src = str(f.get("src") or "")
            if not src.startswith("content/img/") or ".." in src or "\\" in src:
                raise ApiError(f"figure {fid}: images must live under content/img/")
            spots = []
            for h in f.get("hotspots") or []:
                try:
                    x, y = float(h["x"]), float(h["y"])
                except (KeyError, TypeError, ValueError):
                    raise ApiError(f"figure {fid}: bad pin")
                spots.append({"x": round(min(max(x, 0), 100), 1), "y": round(min(max(y, 0), 100), 1), "note": str(h.get("note") or "")})
            figures[fid] = {"src": src, "w": int(f.get("w") or 1600), "h": int(f.get("h") or 1000),
                            "title": str(f.get("title") or ""), "caption": str(f.get("caption") or ""),
                            "alt": str(f.get("alt") or ""), "hotspots": spots}
        return {"slug": slug, "title": s("title"), "summary": s("summary"), "tags": [t.strip() for t in tags if t.strip()],
                "repo": repo, "status": p["status"], "started": s("started"), "updated": date.today().isoformat(),
                "body": str(p.get("body") or ""), "figures": figures}

    def save_project(self, slug: str, project: dict, old_slug: str | None) -> dict:
        with self.lock:
            path = self.project_path(slug)
            old_slug = old_slug or slug
            old_path = self.project_path(old_slug)
            if old_slug != slug and path.exists():
                raise ApiError(f"there's already a project called {slug}", 409)
            p = self.clean_project(project, slug)
            if old_slug != slug:
                # renamed: its images move with it, and its figures follow
                old_dir, new_dir = self.images / old_slug, self.images / slug
                if old_dir.exists():
                    if new_dir.exists():
                        raise ApiError(f"content/img/{slug}/ already exists", 409)
                    old_dir.rename(new_dir)
                prefix_old, prefix_new = f"content/img/{old_slug}/", f"content/img/{slug}/"
                for f in p["figures"].values():
                    if f["src"].startswith(prefix_old):
                        f["src"] = prefix_new + f["src"][len(prefix_old):]
            write_atomic(path, dump_json(p))
            if old_slug != slug:
                old_path.unlink(missing_ok=True)
            index = self.read_index()
            entry = self.index_entry(p)
            for i, e in enumerate(index):
                if e.get("slug") == old_slug:
                    index[i] = entry
                    break
            else:
                index.append(entry)
            write_atomic(self.index_path, dump_json(index))
            return p

    def delete_project(self, slug: str) -> None:
        with self.lock:
            path = self.project_path(slug)
            if not path.exists():
                raise ApiError("no such project", 404)
            path.unlink()
            shutil.rmtree(self.images / slug, ignore_errors=True)
            write_atomic(self.index_path, dump_json([e for e in self.read_index() if e.get("slug") != slug]))

    def reorder(self, slugs: list) -> list:
        with self.lock:
            index = self.read_index()
            by_slug = {e["slug"]: e for e in index}
            if sorted(slugs) != sorted(by_slug):
                raise ApiError("the new order must list every project exactly once")
            index = [by_slug[s] for s in slugs]
            write_atomic(self.index_path, dump_json(index))
            return index

    def save_image(self, slug: str, filename: str, data: bytes) -> str:
        self.project_path(slug)  # validates the slug
        stem, ext = os.path.splitext(os.path.basename(filename or ""))
        ext = ext.lower()
        if ext not in IMAGE_EXTS:
            raise ApiError(f"images must be one of {', '.join(sorted(IMAGE_EXTS))}")
        if not data:
            raise ApiError("empty file")
        stem = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")[:60] or "image"
        folder = self.images / slug
        name, n = f"{stem}{ext}", 2
        with self.lock:
            while (folder / name).exists():  # never overwrite: add -2, -3...
                name, n = f"{stem}-{n}{ext}", n + 1
            write_atomic(folder / name, data)
        return f"content/img/{slug}/{name}"

    # CV + home text -----------------------------------------------------------------------
    def save_cv(self, cv: dict, cv_html: str) -> None:
        if not isinstance(cv, dict) or not isinstance(cv_html, str) or not cv_html.strip():
            raise ApiError("cv and its rendered html are both required")
        with self.lock:
            index_html = self.root / "index.html"
            text = splice(index_html.read_text(), "<!-- cv:begin -->", "<!-- cv:end -->", "\n" + cv_html.strip() + "\n")
            write_atomic(self.root / "content" / "cv.json", dump_json(cv))
            write_atomic(index_html, text.encode())

    def save_site(self, site: dict) -> dict:
        if not isinstance(site, dict):
            raise ApiError("site must be an object")
        clean = {"status": str(site.get("status") or "").strip() or "ONLINE", "bio": str(site.get("bio") or "").strip()}
        with self.lock:
            index_html = self.root / "index.html"
            text = index_html.read_text()
            text = splice(text, "<!-- site:status -->", "<!-- /site:status -->", html.escape(clean["status"], quote=False))
            text = splice(text, "<!-- site:bio -->", "<!-- /site:bio -->", html.escape(clean["bio"], quote=False))
            write_atomic(self.root / "content" / "site.json", dump_json(clean))
            write_atomic(index_html, text.encode())
        return clean


# -- HTTP ------------------------------------------------------------------------------------

class State:
    def __init__(self, root: Path, port: int, password_file: Path):
        self.site = Site(root)
        self.port = port
        self.password_file = password_file
        self.sessions: dict[str, float] = {}
        self.failures: list[float] = []
        self.lock = threading.Lock()


def make_handler(state: State):
    root = str(state.site.root)
    allowed_hosts = {f"127.0.0.1:{state.port}", f"localhost:{state.port}"}

    class Handler(http.server.SimpleHTTPRequestHandler):
        server_version = "mh-admin"

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def log_message(self, fmt, *args):  # quieter: API calls and errors only
            if self.path.startswith("/api/") or (len(args) > 1 and str(args[1])[:1] in "45"):
                sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")  # editing: always the file on disk
            super().end_headers()

        # -- plumbing ------------------------------------------------------------------
        def reply(self, status, obj=None, headers=None):
            body = json.dumps(obj if obj is not None else {}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def host_ok(self):
            # DNS rebinding: a page on some other domain resolving to 127.0.0.1 must not reach this
            return self.headers.get("Host", "") in allowed_hosts

        def session(self):
            for part in (self.headers.get("Cookie") or "").split(";"):
                k, _, v = part.strip().partition("=")
                if k == "mh_admin":
                    with state.lock:
                        exp = state.sessions.get(v)
                        if exp and exp > time.time():
                            return v
                        state.sessions.pop(v, None)
            return None

        def body_bytes(self, limit):
            n = int(self.headers.get("Content-Length") or 0)
            if n > limit:
                raise ApiError("too large", 413)
            return self.rfile.read(n) if n else b""

        def body_json(self):
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                raise ApiError("expected JSON", 415)
            try:
                return json.loads(self.body_bytes(MAX_JSON) or b"{}")
            except json.JSONDecodeError:
                raise ApiError("bad JSON")

        # -- static files: never dotfiles (.admin-password, .git) ---------------------------
        def do_GET(self):
            if not self.host_ok():
                return self.reply(403, {"message": "unexpected Host"})
            path = unquote(urlparse(self.path).path)
            if path.startswith("/api/"):
                return self.api("GET", path)
            if any(part.startswith(".") for part in path.split("/") if part):
                return self.reply(404, {"message": "not found"})
            return super().do_GET()

        def do_HEAD(self):
            if not self.host_ok():
                return self.reply(403, {"message": "unexpected Host"})
            path = unquote(urlparse(self.path).path)
            if path.startswith("/api/") or any(part.startswith(".") for part in path.split("/") if part):
                return self.reply(404)
            return super().do_HEAD()

        def do_POST(self):
            self.mutate("POST")

        def do_PUT(self):
            self.mutate("PUT")

        def do_DELETE(self):
            self.mutate("DELETE")

        def mutate(self, method):
            if not self.host_ok():
                return self.reply(403, {"message": "unexpected Host"})
            path = unquote(urlparse(self.path).path)
            # a custom header can't be sent cross-site without a CORS preflight (which this
            # server never grants), so other sites open in the browser can't call the API
            if self.headers.get("X-MH-Admin") != "1":
                return self.reply(403, {"message": "missing X-MH-Admin header"})
            origin = self.headers.get("Origin")
            if origin and urlparse(origin).netloc not in allowed_hosts:
                return self.reply(403, {"message": "cross-origin request refused"})
            self.api(method, path)

        # -- API -------------------------------------------------------------------------
        def api(self, method, path):
            try:
                self.route(method, path)
            except ApiError as e:
                self.reply(e.status, {"message": str(e)})
            except Exception as e:  # noqa: BLE001 -- report, don't kill the thread silently
                sys.stderr.write(f"error: {e!r}\n")
                self.reply(500, {"message": f"server error: {e}"})

        def route(self, method, path):
            site = state.site
            if method == "GET" and path == "/api/status":
                return self.reply(200, {"local": True, "authed": bool(self.session()), "setup": not state.password_file.exists()})
            if method == "POST" and path == "/api/setup":
                return self.first_run_setup()
            if method == "POST" and path == "/api/login":
                return self.login()
            if method == "POST" and path == "/api/logout":
                tok = self.session()
                with state.lock:
                    state.sessions.pop(tok, None)
                return self.reply(200, {}, {"Set-Cookie": "mh_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"})
            if not self.session():
                raise ApiError("log in first", 401)

            m = re.match(r"^/api/projects/([^/]+)$", path)
            if m and method == "PUT":
                data = self.body_json()
                p = site.save_project(m.group(1), data.get("project"), data.get("oldSlug"))
                return self.reply(200, {"project": p, "index": site.read_index()})
            if m and method == "DELETE":
                site.delete_project(m.group(1))
                return self.reply(200, {"index": site.read_index()})
            if method == "PUT" and path == "/api/projects-order":
                return self.reply(200, {"index": site.reorder(self.body_json().get("slugs") or [])})
            m = re.match(r"^/api/images/([^/]+)$", path)
            if m and method == "POST":
                name = (parse_qs(urlparse(self.path).query).get("name") or [""])[0]
                return self.reply(200, {"src": site.save_image(m.group(1), name, self.body_bytes(MAX_UPLOAD))})
            if method == "PUT" and path == "/api/cv":
                data = self.body_json()
                site.save_cv(data.get("cv"), data.get("html"))
                return self.reply(200, {})
            if method == "PUT" and path == "/api/site":
                return self.reply(200, {"site": site.save_site(self.body_json().get("site"))})
            raise ApiError("not found", 404)

        def login(self):
            now = time.time()
            with state.lock:
                state.failures = [t for t in state.failures if now - t < 60]
                if len(state.failures) >= 10:
                    raise ApiError("too many attempts -- wait a minute", 429)
            password = str(self.body_json().get("password") or "")
            stored = state.password_file.read_text() if state.password_file.exists() else ""
            if not stored or not check_password(password, stored):
                with state.lock:
                    state.failures.append(now)
                time.sleep(0.4)
                raise ApiError("wrong password", 401)
            self.start_session()

        def first_run_setup(self):  # not setup(): that name is BaseRequestHandler's own
            # first run only: choose the password in the browser (no terminal needed -- e.g. when
            # Citadel starts this). Refused as soon as a password exists.
            password = str(self.body_json().get("password") or "")
            if not password:  # no length / complexity rules: Mike's choice (loopback-only server, demo site)
                raise ApiError("the password can't be empty")
            with state.lock:
                if state.password_file.exists():
                    raise ApiError("a password is already set -- log in instead", 409)
                write_password_file(state.password_file, password)
            self.start_session()

        def start_session(self):
            token = secrets.token_urlsafe(32)
            with state.lock:
                state.sessions[token] = time.time() + SESSION_HOURS * 3600
            cookie = f"mh_admin={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_HOURS * 3600}"
            self.reply(200, {"authed": True}, {"Set-Cookie": cookie})

    return Handler


def serve(root: Path, port: int, password_file: Path, ready=None):
    state = State(root, port, password_file)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), make_handler(state))
    if ready:
        ready(httpd)
    return httpd


def main():
    ap = argparse.ArgumentParser(description="Local admin server for mikehadfield.co.uk")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="site folder (default: this repo)")
    ap.add_argument("--set-password", action="store_true", help="choose a new admin password and exit")
    args = ap.parse_args()
    root = args.root.resolve()
    pw_file = root / ".admin-password"

    if args.set_password:
        if not sys.stdin.isatty():
            sys.exit("--set-password needs a terminal to type into.")
        print("Choose the admin password (stored hashed in .admin-password, which is gitignored).")
        while True:
            pw = getpass.getpass("New admin password: ")
            if not pw:
                print("It can't be empty.")
                continue
            if getpass.getpass("Again: ") != pw:
                print("They didn't match.")
                continue
            break
        write_password_file(pw_file, pw)
        print("Saved.")
        return

    httpd = serve(root, args.port, pw_file)
    print(f"Admin: http://127.0.0.1:{args.port}/admin.html   (site: http://127.0.0.1:{args.port}/)")
    print("Local only. Ctrl+C to stop.")
    if not pw_file.exists():
        print("No admin password yet -- open the admin page to choose one.")
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()

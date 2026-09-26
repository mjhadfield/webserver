"""Tests for the local admin server. Each test runs it against a throwaway copy of the site.

    python3 tools/test_admin_server.py
"""
import http.client
import json
import shutil
import sys
import tempfile
import threading
import unittest
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import admin_server as A  # noqa: E402

REPO = HERE.parent
PASSWORD = "correct horse battery"


class AdminServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        for name in ("index.html", "content"):
            src = REPO / name
            (shutil.copytree if src.is_dir() else shutil.copy)(src, self.tmp / name)
        A.PBKDF2_ITERATIONS = 1000  # fast for tests
        A.write_password_file(self.tmp / ".admin-password", PASSWORD)
        self.httpd = A.serve(self.tmp, 0, self.tmp / ".admin-password")
        self.port = self.httpd.server_address[1]
        # the Host allow-list was built for port 0; rebuild the handler for the real port
        self.httpd.RequestHandlerClass = A.make_handler(A.State(self.tmp, self.port, self.tmp / ".admin-password"))
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.cookie = None

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        shutil.rmtree(self.tmp)

    # -- helpers ----------------------------------------------------------------------------
    def req(self, method, path, body=None, raw=None, headers=None, admin=True, host=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": host or f"127.0.0.1:{self.port}"}
        if admin:
            h["X-MH-Admin"] = "1"
        if self.cookie:
            h["Cookie"] = self.cookie
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        if raw is not None:
            data = raw
            h["Content-Type"] = "application/octet-stream"
        h.update(headers or {})
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        payload = r.read()
        set_cookie = r.getheader("Set-Cookie")
        c.close()
        try:
            payload = json.loads(payload)
        except ValueError:
            pass
        return r.status, payload, set_cookie

    def login(self):
        status, _, cookie = self.req("POST", "/api/login", {"password": PASSWORD})
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.cookie = cookie.split(";")[0]

    def project(self, **kw):
        p = {"slug": "test-proj", "title": "Test project", "summary": "  sum  ", "tags": [" Python ", "", "SQL"],
             "repo": "https://github.com/x/y", "status": "draft", "started": "2026-01", "body": "## Hi\n\n::figure[a]",
             "figures": {"a": {"src": "content/img/test-proj/a.png", "w": 800, "h": 600, "title": "A", "caption": "c",
                               "hotspots": [{"x": 150, "y": -3, "note": "pin"}]}}}
        p.update(kw)
        return p

    # -- guards -----------------------------------------------------------------------------
    def test_status_and_static(self):
        status, body, _ = self.req("GET", "/api/status", admin=False)
        self.assertEqual((status, body), (200, {"local": True, "authed": False, "setup": False}))
        self.assertEqual(self.req("GET", "/index.html", admin=False)[0], 200)

    def test_dotfiles_never_served(self):
        self.assertEqual(self.req("GET", "/.admin-password", admin=False)[0], 404)
        self.assertEqual(self.req("GET", "/content/../.admin-password", admin=False)[0], 404)
        self.assertEqual(self.req("GET", "/%2eadmin-password", admin=False)[0], 404)

    def test_wrong_host_refused(self):  # DNS rebinding
        self.assertEqual(self.req("GET", "/api/status", host="evil.example:80")[0], 403)
        self.assertEqual(self.req("GET", "/index.html", host="evil.example")[0], 403)

    def test_writes_need_header_session_and_same_origin(self):
        self.assertEqual(self.req("POST", "/api/login", {"password": PASSWORD}, admin=False)[0], 403)
        self.assertEqual(self.req("PUT", "/api/site", {"site": {"bio": "x"}})[0], 401)
        self.login()
        self.assertEqual(self.req("PUT", "/api/site", {"site": {"bio": "x"}}, admin=False)[0], 403)
        self.assertEqual(self.req("PUT", "/api/site", {"site": {"bio": "x"}}, headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.req("PUT", "/api/site", {"site": {"bio": "x"}}, headers={"Origin": f"http://127.0.0.1:{self.port}"})[0], 200)

    def test_wrong_password(self):
        status, body, cookie = self.req("POST", "/api/login", {"password": "nope"})
        self.assertEqual(status, 401)
        self.assertIsNone(cookie)

    def test_logout_ends_session(self):
        self.login()
        self.assertTrue(self.req("GET", "/api/status")[1]["authed"])
        self.req("POST", "/api/logout", {})
        self.assertFalse(self.req("GET", "/api/status")[1]["authed"])

    # -- projects ---------------------------------------------------------------------------
    def test_save_new_project_cleans_and_indexes(self):
        self.login()
        status, body, _ = self.req("PUT", "/api/projects/test-proj", {"project": self.project(), "oldSlug": None})
        self.assertEqual(status, 200, body)
        saved = json.loads((self.tmp / "content/projects/test-proj.json").read_text())
        self.assertEqual(saved["tags"], ["Python", "SQL"])
        self.assertEqual(saved["summary"], "sum")
        self.assertEqual(saved["updated"], date.today().isoformat())
        self.assertEqual(saved["figures"]["a"]["hotspots"][0], {"x": 100, "y": 0, "note": "pin"})  # clamped to the image
        index = json.loads((self.tmp / "content/projects/index.json").read_text())
        self.assertEqual(index[-1]["slug"], "test-proj")
        self.assertEqual(len(index), 5)

    def test_bad_input_refused(self):
        self.login()
        for slug in ("../evil", "Upper", "a_b", "-x", "x" * 70):  # "../evil" never even matches a route (404)
            self.assertIn(self.req("PUT", f"/api/projects/{slug}", {"project": self.project(slug=slug)})[0], (400, 404), slug)
        self.assertFalse((self.tmp / "content" / "evil.json").exists())
        self.assertEqual(self.req("PUT", "/api/projects/ok", {"project": self.project(status="live")})[0], 400)
        self.assertEqual(self.req("PUT", "/api/projects/ok", {"project": self.project(repo="javascript:alert(1)")})[0], 400)
        status, body, _ = self.req("PUT", "/api/projects/ok2", {"project": self.project(repo=" Private ")})
        self.assertEqual((status, body["project"]["repo"]), (200, "private"))   # the inactive "Private repo" button
        bad_fig = self.project(figures={"a": {"src": "../../etc/passwd"}})
        self.assertEqual(self.req("PUT", "/api/projects/ok", {"project": bad_fig})[0], 400)
        self.assertFalse((self.tmp / "content/projects/ok.json").exists())

    def test_rename_moves_json_images_and_keeps_order(self):
        self.login()
        img = self.tmp / "content/img/citadel/citadel-dashboard.svg"
        self.assertTrue(img.exists())
        p = json.loads((self.tmp / "content/projects/citadel.json").read_text())
        p["slug"] = "citadel-hub"
        status, body, _ = self.req("PUT", "/api/projects/citadel-hub", {"project": p, "oldSlug": "citadel"})
        self.assertEqual(status, 200, body)
        self.assertFalse((self.tmp / "content/projects/citadel.json").exists())
        self.assertTrue((self.tmp / "content/img/citadel-hub/citadel-dashboard.svg").exists())
        self.assertTrue(all(f["src"].startswith("content/img/citadel-hub/") for f in body["project"]["figures"].values()))
        self.assertEqual([e["slug"] for e in body["index"]][0], "citadel-hub")  # same place in the list

    def test_rename_onto_existing_refused(self):
        self.login()
        p = json.loads((self.tmp / "content/projects/citadel.json").read_text())
        self.assertEqual(self.req("PUT", "/api/projects/star-epr", {"project": p, "oldSlug": "citadel"})[0], 409)
        self.assertTrue((self.tmp / "content/projects/citadel.json").exists())

    def test_delete_and_reorder(self):
        self.login()
        self.assertEqual(self.req("PUT", "/api/projects-order", {"slugs": ["citadel"]})[0], 400)  # must list all
        slugs = ["star-epr", "home-casino", "music-companion", "citadel"]
        status, body, _ = self.req("PUT", "/api/projects-order", {"slugs": slugs})
        self.assertEqual([e["slug"] for e in body["index"]], slugs)
        status, body, _ = self.req("DELETE", "/api/projects/home-casino")
        self.assertEqual(status, 200)
        self.assertNotIn("home-casino", [e["slug"] for e in body["index"]])
        self.assertFalse((self.tmp / "content/img/home-casino").exists())
        self.assertEqual(self.req("DELETE", "/api/projects/home-casino")[0], 404)

    # -- images -----------------------------------------------------------------------------
    def test_upload_never_overwrites_and_checks_type(self):
        self.login()
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 64
        s1 = self.req("POST", "/api/images/citadel?name=My%20Shot.PNG", raw=png)
        s2 = self.req("POST", "/api/images/citadel?name=My%20Shot.PNG", raw=png)
        self.assertEqual(s1[1]["src"], "content/img/citadel/my-shot.png")
        self.assertEqual(s2[1]["src"], "content/img/citadel/my-shot-2.png")
        self.assertEqual(self.req("POST", "/api/images/citadel?name=evil.html", raw=b"<script>")[0], 400)
        self.assertEqual(self.req("POST", "/api/images/citadel?name=../../x.png", raw=png)[1]["src"], "content/img/citadel/x.png")
        self.assertIn(self.req("POST", "/api/images/..%2Fescape?name=a.png", raw=png)[0], (400, 404))
        self.assertFalse((self.tmp / "content" / "escape").exists())

    # -- CV + home text ---------------------------------------------------------------------
    def test_cv_is_written_into_index_html(self):
        self.login()
        cv = json.loads((self.tmp / "content/cv.json").read_text())
        cv["title"] = "New title"
        status, _, _ = self.req("PUT", "/api/cv", {"cv": cv, "html": "<header>NEW CV</header>"})
        self.assertEqual(status, 200)
        page = (self.tmp / "index.html").read_text()
        self.assertIn("<!-- cv:begin -->\n<header>NEW CV</header>\n<!-- cv:end -->", page)
        self.assertEqual(page.count("<!-- cv:begin -->"), 1)
        self.assertEqual(json.loads((self.tmp / "content/cv.json").read_text())["title"], "New title")

    def test_site_text_is_escaped_into_index_html(self):
        self.login()
        status, body, _ = self.req("PUT", "/api/site", {"site": {"status": "BUSY", "bio": "Fish & <chips>"}})
        self.assertEqual(status, 200)
        page = (self.tmp / "index.html").read_text()
        self.assertIn("<!-- site:bio -->Fish &amp; &lt;chips&gt;<!-- /site:bio -->", page)
        self.assertIn("<!-- site:status -->BUSY<!-- /site:status -->", page)

    def test_missing_markers_fail_loudly(self):
        self.login()
        page = self.tmp / "index.html"
        page.write_text(page.read_text().replace("<!-- cv:end -->", ""))
        status, body, _ = self.req("PUT", "/api/cv", {"cv": {}, "html": "<p>x</p>"})
        self.assertEqual(status, 500)
        self.assertIn("markers", body["message"])


    def test_first_run_setup_in_browser(self):
        (self.tmp / ".admin-password").unlink()
        self.assertTrue(self.req("GET", "/api/status")[1]["setup"])
        self.assertEqual(self.req("POST", "/api/login", {"password": PASSWORD})[0], 401)   # nothing to log in to yet
        self.assertEqual(self.req("POST", "/api/setup", {"password": ""})[0], 400)
        self.assertEqual(self.req("POST", "/api/setup", {"password": "admin"}, admin=False)[0], 403)  # header still required
        status, _, cookie = self.req("POST", "/api/setup", {"password": "admin"})
        self.assertEqual(status, 200)
        self.cookie = cookie.split(";")[0]                                                  # logged straight in
        self.assertEqual(self.req("GET", "/api/status")[1], {"local": True, "authed": True, "setup": False})
        self.assertTrue(A.check_password("admin", (self.tmp / ".admin-password").read_text()))
        self.cookie = None
        self.assertEqual(self.req("POST", "/api/setup", {"password": "take-over-now"})[0], 409)  # once only
        self.assertTrue(A.check_password("admin", (self.tmp / ".admin-password").read_text()))


class PasswordTests(unittest.TestCase):
    def test_hash_round_trip(self):
        h = A.hash_password("secret", iterations=1000)
        self.assertTrue(A.check_password("secret", h))
        self.assertFalse(A.check_password("Secret", h))
        self.assertFalse(A.check_password("secret", "garbage"))
        self.assertNotIn("secret", h)


if __name__ == "__main__":
    unittest.main()

"""Tests for the HTTP API (uploads, thumbnails, jobs in worker processes)."""

import io
import time

import pymupdf as fitz
import pytest

from pdfplume.jobs import JobManager
from pdfplume.server import create_app


@pytest.fixture()
def client(storage):
    jobs = JobManager(storage, workers=1)
    app = create_app(storage=storage, jobs=jobs)
    app.testing = True
    yield app.test_client()
    jobs.shutdown()


def upload(client, path, name=None):
    data = {"file": (io.BytesIO(path.read_bytes()), name or path.name)}
    res = client.post("/api/upload", data=data, content_type="multipart/form-data")
    assert res.status_code == 200, res.json
    return res.json


def wait_job(client, job_id, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        st = client.get(f"/api/jobs/{job_id}").json
        if st["status"] in ("done", "error"):
            return st
        time.sleep(0.2)
    raise AssertionError("job timed out")


def test_pages_served(client):
    assert client.get("/").status_code == 200
    assert b"/static/js/home.js" in client.get("/").data
    assert client.get("/merge_pdf").status_code == 200
    assert client.get("/not_a_tool").status_code == 404
    assert client.get("/static/js/tool.js").status_code == 200
    caps = client.get("/api/capabilities").json
    assert "libreoffice" in caps and "translation" in caps


def test_upload_and_thumbnails(client, samples):
    meta = upload(client, samples["pdf"])
    assert meta["kind"] == "pdf" and meta["pages"] == 5 and "path" not in meta
    res = client.get(f"/api/files/{meta['id']}/thumb/0?w=200")
    assert res.status_code == 200 and res.mimetype == "image/png"
    assert client.get(f"/api/files/{meta['id']}/thumb/9").status_code == 404
    pages = client.get(f"/api/files/{meta['id']}/pages").json["pages"]
    assert len(pages) == 5 and pages[0]["w"] == 595
    img = upload(client, samples["jpg"])
    assert img["kind"] == "image" and img["width"] == 800
    assert client.get(f"/api/files/{img['id']}/thumb/0").status_code == 200


def test_invalid_ids_rejected(client):
    assert client.get("/api/files/../../etc/passwd/thumb/0").status_code == 404
    assert client.get("/api/files/abc/thumb/0").status_code == 404
    assert client.get("/api/jobs/zzz").status_code == 404


def test_password_flow(client, samples):
    meta = upload(client, samples["locked"])
    assert meta["needs_password"] and meta["pages"] == 0
    assert client.get(f"/api/files/{meta['id']}/thumb/0").status_code == 423
    assert client.post(f"/api/files/{meta['id']}/password", json={"password": "nope"}).status_code == 403
    ok = client.post(f"/api/files/{meta['id']}/password", json={"password": "secret"}).json
    assert ok["pages"] == 5 and not ok["needs_password"] and "password" not in ok
    assert client.get(f"/api/files/{meta['id']}/thumb/0").status_code == 200


def test_search(client, samples):
    meta = upload(client, samples["pdf"])
    res = client.post(f"/api/files/{meta['id']}/search", json={"terms": ["Merging"], "patterns": ["email"]}).json
    assert res["total"] == 20
    assert all(0 <= v <= 1 for m in res["matches"] for v in m["rect"])


def test_job_roundtrip_and_continue(client, samples):
    a = upload(client, samples["pdf"])
    b = upload(client, samples["pdf2"])
    res = client.post("/api/process/merge_pdf", json={"files": [{"id": a["id"]}, {"id": b["id"]}]})
    assert res.status_code == 200
    st = wait_job(client, res.json["job_id"])
    assert st["status"] == "done", st
    dl = client.get(f"/api/jobs/{res.json['job_id']}/download")
    assert dl.status_code == 200
    assert fitz.open("pdf", dl.data).page_count == 8
    assert "attachment" in dl.headers["Content-Disposition"]
    files = client.post(f"/api/jobs/{res.json['job_id']}/continue").json["files"]
    assert len(files) == 1 and files[0]["pages"] == 8
    assert client.delete(f"/api/jobs/{res.json['job_id']}").json["ok"]
    assert client.get(f"/api/jobs/{res.json['job_id']}").status_code == 404


def test_job_error_is_reported(client, samples):
    a = upload(client, samples["pdf"])
    res = client.post("/api/process/remove_pages", json={"files": [{"id": a["id"]}], "options": {"pages": "1-5"}})
    st = wait_job(client, res.json["job_id"])
    assert st["status"] == "error" and "every page" in st["message"]


def test_process_validation(client, samples):
    a = upload(client, samples["pdf"])
    img = upload(client, samples["jpg"])
    assert client.post("/api/process/merge_pdf", json={"files": [{"id": a["id"]}]}).status_code == 400
    assert client.post("/api/process/merge_pdf", json={"files": [{"id": a["id"]}, {"id": img["id"]}]}).status_code == 400
    assert client.post("/api/process/nope", json={}).status_code == 404
    gone = "0" * 32
    assert client.post("/api/process/compress_pdf", json={"files": [{"id": gone}]}).status_code == 410


def test_watermark_image_reference(client, samples):
    a = upload(client, samples["pdf"])
    logo = upload(client, samples["png"])
    res = client.post("/api/process/add_watermark", json={
        "files": [{"id": a["id"]}], "options": {"type": "image", "image_id": logo["id"]}})
    assert wait_job(client, res.json["job_id"])["status"] == "done"


def test_compare_assets(client, samples):
    a = upload(client, samples["pdf"])
    b = upload(client, samples["modified"])
    res = client.post("/api/process/compare_pdf", json={"files": [{"id": a["id"]}, {"id": b["id"]}],
                                                       "options": {"mode": "overlay"}})
    st = wait_job(client, res.json["job_id"])
    asset = st["extra"]["pages"][0]["asset"]
    assert client.get(f"/api/jobs/{res.json['job_id']}/assets/{asset}").status_code == 200
    assert client.get(f"/api/jobs/{res.json['job_id']}/assets/..%2Fresult.json").status_code in (400, 404)


def test_cleanup(storage, samples):
    import os
    meta = storage.add_file("x.pdf", lambda p: p.write_bytes(samples["pdf"].read_bytes()))
    d = storage.upload_dir(meta["id"])
    old = time.time() - 10 * 3600
    os.utime(d, (old, old))
    assert storage.cleanup(ttl_minutes=60) >= 1
    assert not d.exists()


def test_result_thumbnails(client, samples):
    a = upload(client, samples["pdf"])
    res = client.post("/api/process/split_pdf", json={"files": [{"id": a["id"]}], "options": {"mode": "all"}})
    st = wait_job(client, res.json["job_id"])
    job = res.json["job_id"]
    first = st["outputs"][0]["name"]
    thumb = client.get(f"/api/jobs/{job}/thumb?file={first}&w=200")
    assert thumb.status_code == 200 and thumb.mimetype == "image/png"
    assert client.get(f"/api/jobs/{job}/thumb?file={st['file']}").status_code == 404  # the zip
    assert client.get(f"/api/jobs/{job}/thumb?file=../result.json").status_code == 400


def test_app_manifest_and_service_worker(client):
    man = client.get("/manifest.webmanifest")
    assert man.status_code == 200 and man.json["start_url"] == "/"
    assert all(client.get(i["src"]).status_code == 200 for i in man.json["icons"])
    sw = client.get("/sw.js")
    assert sw.status_code == 200 and b"fetch" in sw.data


def test_heic_thumbnail(client, samples):
    meta = upload(client, samples["heic"])
    assert meta["kind"] == "image"
    assert client.get(f"/api/files/{meta['id']}/thumb/0").status_code == 200


def test_cancel_endpoint(client, samples):
    a = upload(client, samples["pdf"])
    res = client.post("/api/process/ocr_pdf", json={"files": [{"id": a["id"]}], "options": {"force": True}})
    job = res.json["job_id"]
    client.post(f"/api/jobs/{job}/cancel")
    st = wait_job_any(client, job)
    assert st["status"] in ("cancelled", "done")  # it may finish before the cancel lands
    assert client.post("/api/jobs/" + "0" * 32 + "/cancel").json["ok"] is False


def wait_job_any(client, job_id, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        st = client.get(f"/api/jobs/{job_id}").json
        if st["status"] in ("done", "error", "cancelled"):
            return st
        time.sleep(0.2)
    raise AssertionError("job timed out")


def test_chat_endpoints(client, samples):
    meta = upload(client, samples["pdf"])
    info = client.get(f"/api/files/{meta['id']}/chat").json
    assert info["pages"] == 5 and info["suggestions"][0] == "Summarize this document"
    assert info["llm"]["available"] is False
    res = client.post(f"/api/files/{meta['id']}/ask", json={"question": "How do I protect sensitive content?"}).json
    assert "[p. " in res["answer"] and res["sources"]
    quote = res["quotes"][0]  # each quoted sentence comes with its position, line by line
    assert "protect" in quote["text"].lower() and quote["rects"]
    assert all(0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1 for x0, y0, x1, y1 in quote["rects"])
    assert client.post(f"/api/files/{meta['id']}/ask", json={"question": " "}).status_code == 400
    scan = upload(client, samples["scanned"])
    res = client.post(f"/api/files/{scan['id']}/ask", json={"question": "anything"}).json
    assert res.get("needs_ocr") is True
    assert client.get("/chat_pdf").status_code == 200
    assert client.get("/api/capabilities").json["llm"]["available"] is False


def test_llm_status_without_server(monkeypatch):
    from pdfplume import config, llm
    monkeypatch.setattr(config, "OLLAMA_URL", "http://127.0.0.1:9")  # nothing listens on the discard port
    llm._cache["status"] = None
    st = llm.status()
    assert st["available"] is False and st["url"] == "http://127.0.0.1:9"
    llm._cache["status"] = None


def test_detect_endpoint(client, samples):
    meta = upload(client, samples["desk"])
    res = client.get(f"/api/files/{meta['id']}/detect").json
    assert res["found"] and len(res["corners"]) == 4
    assert client.get(f"/api/files/{meta['id']}/detect").json == res  # cached
    pdf_meta = upload(client, samples["pdf"])
    assert client.get(f"/api/files/{pdf_meta['id']}/detect").status_code == 400


def test_certificate_endpoints(client, samples):
    assert client.get("/api/certificates").json == {"certificates": []}
    assert client.post("/api/certificates", json={"name": "", "password": "abcd"}).status_code == 400
    info = client.post("/api/certificates", json={"name": "Visu Joy", "email": "v@example.com", "password": "abcd1234"}).json
    assert info["name"] == "Visu Joy" and info["email"] == "v@example.com"
    assert [c["id"] for c in client.get("/api/certificates").json["certificates"]] == [info["id"]]
    pem = client.get(f"/api/certificates/{info['id']}/download")
    assert pem.status_code == 200 and b"BEGIN CERTIFICATE" in pem.data and "Visu_Joy.cer" in pem.headers["Content-Disposition"]

    meta = upload(client, samples["pdf"])
    body = {"files": [{"id": meta["id"]}], "options": {"elements": [], "digital": {"cert_id": info["id"], "password": "abcd1234", "reason": "OK"}}}
    st = wait_job(client, client.post("/api/process/sign_pdf", json=body).json["job_id"])
    assert st["status"] == "done", st
    assert st["extra"]["digital"]["signatures"][0]["intact"]
    bad = dict(body, options={"digital": {"cert_id": "0" * 32, "password": "x"}})
    assert client.post("/api/process/sign_pdf", json=bad).status_code == 410

    # Upload the signed result and check it is reported as signed.
    job_id = client.post("/api/process/sign_pdf", json=body).json["job_id"]
    st = wait_job(client, job_id)
    data = client.get(f"/api/jobs/{job_id}/download").data
    up = client.post("/api/upload", data={"file": (io.BytesIO(data), "signed.pdf")}, content_type="multipart/form-data").json
    sigs = client.get(f"/api/files/{up['id']}/signatures").json["signatures"]
    assert len(sigs) == 1 and sigs[0]["intact"] and sigs[0]["trusted"]  # trusted: it is one of our own certificates
    assert client.get(f"/api/files/{meta['id']}/signatures").json["signatures"] == []

    p12 = io.BytesIO(b"not a certificate")
    res = client.post("/api/certificates/import", data={"file": (p12, "x.p12"), "password": "a"}, content_type="multipart/form-data")
    assert res.status_code == 400
    assert client.delete(f"/api/certificates/{info['id']}").json == {"ok": True}
    assert client.get("/api/certificates").json["certificates"] == []

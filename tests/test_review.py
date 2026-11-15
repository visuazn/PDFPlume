"""Regression tests for bugs found in the code review."""

import io

import pymupdf as fitz
import pytest

from pdfplume import config
from pdfplume.jobs import JobManager
from pdfplume.server import create_app
from pdfplume.storage import write_json
from pdfplume.utils import PageRangeError, parse_page_ranges, safe_filename


@pytest.fixture()
def client(storage):
    app = create_app(storage, JobManager(storage, workers=1))
    yield app.test_client()
    app.extensions["pdfplume_jobs"].shutdown()


def upload(client, path):
    with open(path, "rb") as f:
        res = client.post("/api/upload", data={"file": (io.BytesIO(f.read()), path.name)})
    assert res.status_code == 200, res.json
    return res.json


def words_pdf(path, lines):
    doc = fitz.open()
    page = doc.new_page()
    for i, line in enumerate(lines):
        page.insert_text((72, 100 + 24 * i), line, fontsize=12)
    doc.save(path)
    return path


# ------------------------------------------------------------------- helpers
def test_safe_filename_stays_a_plain_name():
    assert safe_filename("../../etc/passwd.pdf") == "passwd.pdf"
    assert safe_filename("..\\..\\evil.pdf") == "evil.pdf"
    assert safe_filename("C:evil.pdf") == "C_evil.pdf"
    assert safe_filename("..") == "document"
    assert safe_filename("report.final.PDF") == "report.final.pdf"


def test_page_ranges_reject_odd_input():
    with pytest.raises(PageRangeError):
        parse_page_ranges("²", 5)  # a digit for str.isdigit(), not for int()
    with pytest.raises(PageRangeError):
        parse_page_ranges(0, 5)
    assert parse_page_ranges(3, 5) == [2]


# --------------------------------------------------------------------- tools
def test_merge_file_name_cannot_leave_the_job_folder(run_tool, samples):
    res, out = run_tool("merge_pdf", [samples["pdf"], samples["pdf"]], {"filename": "../../escaped"})
    assert res["status"] == "done" and res["file"] == "escaped.pdf"
    assert (out / "escaped.pdf").is_file()
    assert not (out.parent.parent / "escaped.pdf").exists()


def test_redact_whole_words_only(tmp_path):
    from pdfplume.tools.security import find_matches
    doc = fitz.open(words_pdf(tmp_path / "w.pdf", ["The art of the start is a party.", "Art matters; ART too."]))
    loose = find_matches(doc, ["art"], [])
    assert len(loose) == 5
    whole = find_matches(doc, ["art"], [], whole_words=True)
    assert [m["text"] for m in whole] == ["art", "Art", "ART"]
    page = doc[0]
    for m in whole:  # the boxes cover exactly the word, not "start" or "party"
        assert page.get_textbox(m["rect"]).strip().lower() == "art"
    assert [m["text"] for m in find_matches(doc, ["art"], [], case_sensitive=True, whole_words=True)] == ["art"]


def test_redact_whole_words_leave_neighbours(run_tool, tmp_path):
    src = words_pdf(tmp_path / "w.pdf", ["The art of the start is a party."])
    res, out = run_tool("redact_pdf", [src], {"terms": ["art"], "whole_words": True})
    text = fitz.open(out / res["file"])[0].get_text()
    assert "start" in text and "party" in text and " art " not in text


def test_redact_phrase_across_lines(tmp_path):
    from pdfplume.tools.security import find_matches
    doc = fitz.open(words_pdf(tmp_path / "w.pdf", ["Signed by John", "Smith on Monday.", "John Smithson was absent."]))
    assert len(find_matches(doc, ["John Smith"], [])) == 3  # two line parts + inside "Smithson"
    assert len(find_matches(doc, ["John Smith"], [], whole_words=True)) == 2


def test_compress_returns_untouched_original_when_not_smaller(run_tool, samples):
    res, out = run_tool("compress_pdf", [samples["locked"]], {"mode": "target", "target_mb": 50},
                        passwords=["secret"])
    assert res["status"] == "done"
    assert (out / res["file"]).read_bytes() == samples["locked"].read_bytes()


def test_nup_margins_too_large(run_tool, tmp_path):
    doc = fitz.open()
    doc.new_page(width=200, height=200)
    doc.save(tmp_path / "tiny.pdf")
    res, _ = run_tool("nup_pdf", [tmp_path / "tiny.pdf"], {"per_sheet": 16, "sheet": "same", "margin": 40, "gap": 30})
    assert res["status"] == "error" and "margins" in res["message"].lower()


def test_watermark_on_tiny_page(run_tool, tmp_path):
    doc = fitz.open()
    doc.new_page(width=40, height=40)
    doc.save(tmp_path / "tiny.pdf")
    res, _ = run_tool("add_watermark", [tmp_path / "tiny.pdf"], {"text": "DRAFT"})
    assert res["status"] == "done"


def test_damaged_pdf_gives_a_clear_message(run_tool, tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"this is not a pdf")
    res, _ = run_tool("pdf_to_text", [bad])
    assert res["status"] == "error" and "damaged" in res["message"]


def test_ocr_language_is_validated():
    from pdfplume import engines
    if not engines.tesseract_path():
        pytest.skip("Tesseract is not installed")
    with pytest.raises(engines.EngineError):
        engines.tesseract_pdf("x.png", "eng --psm 0", 300)


# ----------------------------------------------------------------------- api
def test_bad_parameters_answer_in_json(client, samples):
    f = upload(client, samples["pdf"])
    assert client.get(f"/api/files/{f['id']}/thumb/0?w=abc").status_code == 200
    res = client.post(f"/api/files/{f['id']}/search", json={"patterns": ["re:("]})
    assert res.status_code == 400 and "regular expression" in res.json["error"]
    res = client.get(f"/api/files/{f['id']}/text?pages=99")
    assert res.status_code == 400 and "does not exist" in res.json["error"]
    res = client.get("/api/files/0123456789abcdef0123456789abcdef")
    assert res.status_code == 404 and res.is_json
    assert client.post("/api/process/merge_pdf", json=[1, 2]).status_code == 400
    res = client.post("/api/process/rotate_pdf", json={"files": [{"id": f["id"], "options": "x"}], "options": "y"})
    assert res.status_code == 200


def test_damaged_upload_does_not_crash_the_api(client, tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"%PDF-1.4 nonsense")
    f = upload(client, bad)
    for url in (f"/api/files/{f['id']}/pages", f"/api/files/{f['id']}/fields", f"/api/files/{f['id']}/outline"):
        res = client.get(url)
        assert res.status_code in (200, 400) and res.is_json
    res = client.post(f"/api/files/{f['id']}/password", json={"password": "x"})
    assert res.status_code in (200, 400) and res.is_json


def test_job_files_are_limited_to_its_outputs(client, samples):
    import time
    f = upload(client, samples["pdf"])
    job = client.post("/api/process/rotate_pdf", json={"files": [{"id": f["id"], "options": {"rotation": 90}}]}).json["job_id"]
    for _ in range(200):
        st = client.get(f"/api/jobs/{job}").json
        if st["status"] != "running":
            break
        time.sleep(0.05)
    assert st["status"] == "done"
    assert client.get(f"/api/jobs/{job}/download").status_code == 200
    for name in ("../result.json", "..\\result.json", "C:result.json", "assets", "other.pdf"):
        assert client.get(f"/api/jobs/{job}/download", query_string={"file": name}).status_code == 404
        assert client.get(f"/api/jobs/{job}/thumb", query_string={"file": name}).status_code == 404


def test_interrupted_job_is_reported(client, storage):
    job_id, job_dir = storage.new_job()
    write_json(job_dir / "progress.json", {"progress": 0.4, "message": "Working"})
    st = client.get(f"/api/jobs/{job_id}").json  # no worker knows this job (server restarted)
    assert st["status"] == "error" and "restarted" in st["message"]


def test_requests_for_another_host_are_refused(client, monkeypatch):
    monkeypatch.setattr(config, "HOST", "127.0.0.1")
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/health", headers={"Host": "127.0.0.1:8765"}).status_code == 200
    assert client.get("/api/health", headers={"Host": "[::1]:8765"}).status_code == 200
    assert client.get("/api/health", headers={"Host": "evil.example:8765"}).status_code == 403
    monkeypatch.setattr(config, "ALLOWED_HOSTS", {"pdf.example"})
    assert client.get("/api/health", headers={"Host": "pdf.example"}).status_code == 200
    monkeypatch.setattr(config, "HOST", "0.0.0.0")
    assert client.get("/api/health", headers={"Host": "evil.example"}).status_code == 200


def test_invalid_image_upload_from_a_job_is_skipped(client, storage):
    meta = storage.add_file("x.png", lambda p: p.write_bytes(b"not an image"))
    assert storage.get_meta(meta["id"])
    storage.delete_file(meta["id"])
    with pytest.raises(KeyError):
        storage.update_meta(meta["id"], pages=1)  # a deleted file is not brought back half-way

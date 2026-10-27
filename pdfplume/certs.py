"""Signing certificates and cryptographic (digital) PDF signatures via pyHanko.

Certificates live as password-protected PKCS#12 files in
``<data dir>/certificates`` and are never deleted by the file cleanup.
"""

import datetime
import hashlib
import json
import logging
import re
import uuid
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID, ObjectIdentifier

DOCUMENT_SIGNING = ObjectIdentifier("1.3.6.1.5.5.7.3.36")
ID_RE = re.compile(r"^[0-9a-f]{32}$")


class CertError(Exception):
    """A problem whose message is shown to the user."""


def _describe(cert, source):
    def attr(name_obj, oid):
        values = name_obj.get_attributes_for_oid(oid)
        return values[0].value if values else ""
    subject, issuer = cert.subject, cert.issuer
    return {
        "name": attr(subject, NameOID.COMMON_NAME) or subject.rfc4514_string(),
        "email": attr(subject, NameOID.EMAIL_ADDRESS),
        "organization": attr(subject, NameOID.ORGANIZATION_NAME),
        "issuer": attr(issuer, NameOID.COMMON_NAME) or issuer.rfc4514_string(),
        "self_signed": subject == issuer,
        "not_after": cert.not_valid_after_utc.isoformat(),
        "fingerprint": hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest().upper(),
        "source": source,
    }


class CertStore:
    def __init__(self, root):
        self.root = Path(root)

    def _dir(self):
        self.root.mkdir(parents=True, exist_ok=True)
        return self.root

    def path(self, cert_id):
        if not ID_RE.match(str(cert_id or "")):
            raise CertError("Unknown certificate.")
        p = self.root / f"{cert_id}.p12"
        if not p.exists():
            raise CertError("This certificate no longer exists.")
        return p

    def _save(self, data, cert, info):
        cert_id = uuid.uuid4().hex
        d = self._dir()
        (d / f"{cert_id}.p12").write_bytes(data)
        (d / f"{cert_id}.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        info = {"id": cert_id, "created": datetime.datetime.now(datetime.timezone.utc).isoformat(), **info}
        (d / f"{cert_id}.json").write_text(json.dumps(info), "utf-8")
        return info

    def list(self):
        if not self.root.exists():
            return []
        out = []
        for meta in self.root.glob("*.json"):
            try:
                out.append(json.loads(meta.read_text("utf-8")))
            except (OSError, ValueError):
                continue
        return sorted(out, key=lambda c: c.get("created", ""), reverse=True)

    def delete(self, cert_id):
        p = self.path(cert_id)
        for suffix in (".p12", ".pem", ".json"):
            p.with_suffix(suffix).unlink(missing_ok=True)

    def create(self, name, password, email="", organization="", years=3):
        name = str(name or "").strip()
        if not name:
            raise CertError("Enter the name to show as the signer.")
        if len(password or "") < 4:
            raise CertError("Choose a password of at least 4 characters to protect the certificate.")
        attrs = [x509.NameAttribute(NameOID.COMMON_NAME, name[:64])]
        if organization:
            attrs.append(x509.NameAttribute(NameOID.ORGANIZATION_NAME, str(organization)[:64]))
        if email:
            attrs.append(x509.NameAttribute(NameOID.EMAIL_ADDRESS, str(email)[:128]))
        subject = x509.Name(attrs)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (x509.CertificateBuilder()
                .subject_name(subject).issuer_name(subject).public_key(key.public_key())
                .serial_number(x509.random_serial_number())
                .not_valid_before(now - datetime.timedelta(minutes=5))
                .not_valid_after(now + datetime.timedelta(days=365 * years))
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False,
                                             data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                             crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.EMAIL_PROTECTION, DOCUMENT_SIGNING]), critical=False)
                .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
                .sign(key, hashes.SHA256()))
        data = pkcs12.serialize_key_and_certificates(name.encode()[:64], key, cert, None,
                                                     serialization.BestAvailableEncryption(password.encode()))
        return self._save(data, cert, _describe(cert, "created"))

    def import_p12(self, data, password):
        try:
            key, cert, _extra = pkcs12.load_key_and_certificates(data, (password or "").encode() or None)
        except ValueError:
            raise CertError("Wrong password, or this is not a .p12 / .pfx certificate file.")
        if key is None or cert is None:
            raise CertError("This file has no private key, so it cannot sign. Export it again with the key included.")
        return self._save(data, cert, _describe(cert, "imported"))

    def info(self, cert_id):
        return json.loads(self.path(cert_id).with_suffix(".json").read_text("utf-8"))

    def public_pem(self, cert_id):
        """The certificate without its key - safe to share so others can trust it."""
        return self.path(cert_id).with_suffix(".pem").read_bytes()

    def trusted(self):
        """The user's own certificates, trusted when checking signatures."""
        from pyhanko.keys import load_cert_from_pemder
        out = []
        for pem in self.root.glob("*.pem") if self.root.exists() else []:
            try:
                out.append(load_cert_from_pemder(str(pem)))
            except Exception:
                continue
        return out


# ---------------------------------------------------------------- signing
def sign_pdf_file(src, dst, p12_path, password, reason="", location="", contact="", box=None, page=0):
    """Add a PAdES signature to ``src`` (written to ``dst``).

    ``box`` (x0, y0, x1, y1 in PDF user space) makes the signature field
    clickable over the visible signature; without it the field is invisible.
    """
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import fields, signers
    from pyhanko.stamp import TextStampStyle

    try:
        signer = signers.SimpleSigner.load_pkcs12(pfx_file=str(p12_path), passphrase=(password or "").encode())
    except Exception:
        signer = None
    if signer is None:
        raise CertError("Wrong certificate password.")
    with open(src, "rb") as inf:
        writer = IncrementalPdfFileWriter(inf, strict=False)
        existing = {f[0] for f in fields.enumerate_sig_fields(writer)}
        n = 1
        while f"Signature{n}" in existing:
            n += 1
        field = f"Signature{n}"
        style = None
        if box:
            fields.append_signature_field(writer, fields.SigFieldSpec(field, on_page=page, box=tuple(box)))
            # The handwritten signature is already on the page; keep the field itself transparent.
            style = TextStampStyle(stamp_text="", border_width=0, background=None)
        meta = signers.PdfSignatureMetadata(field_name=field, reason=reason or None, location=location or None,
                                            contact_info=contact or None, md_algorithm="sha256",
                                            subfilter=fields.SigSeedSubFilter.PADES)
        pdf_signer = signers.PdfSigner(meta, signer=signer, stamp_style=style)
        with open(dst, "wb") as out:
            pdf_signer.sign_pdf(writer, output=out)
    return signer.signing_cert.subject.human_friendly


def verify_pdf(path, trusted=()):
    """[{field, signer, signed_at, intact, valid, trusted, self_signed, covers_whole_file}]"""
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    logging.getLogger("pyhanko").setLevel(logging.CRITICAL)
    logging.getLogger("pyhanko_certvalidator").setLevel(logging.CRITICAL)
    out = []
    with open(path, "rb") as f:
        reader = PdfFileReader(f, strict=False)
        for sig in reader.embedded_signatures:
            cert = sig.signer_cert
            try:
                # Trust is explicit: the user's own certificates (the OS trust list is not consulted).
                st = validate_pdf_signature(sig, ValidationContext(trust_roots=list(trusted)))
                intact, valid, ok_trust = st.intact, st.valid, st.trusted
                covers = st.coverage.name == "ENTIRE_FILE"
                when = st.signer_reported_dt.isoformat() if st.signer_reported_dt else None
            except Exception:
                intact = valid = ok_trust = covers = False
                when = None
            out.append({"field": sig.field_name, "signer": cert.subject.human_friendly if cert else "",
                        "signed_at": when, "intact": bool(intact), "valid": bool(valid), "trusted": bool(ok_trust),
                        "self_signed": bool(cert and cert.subject == cert.issuer), "covers_whole_file": bool(covers)})
    return out

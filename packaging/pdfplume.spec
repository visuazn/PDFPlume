# PyInstaller spec for the stand-alone PDFPlume app (no Python needed to run it).
#   pip install pyinstaller && pyinstaller packaging/pdfplume.spec
# Output: dist/PDFPlume/ (Windows, Linux) or dist/PDFPlume.app (macOS).
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parent
ICON = str(ROOT / "pdfplume" / "static" / "img" / "icon-512.png")  # converted to .ico / .icns by Pillow

datas = [(str(ROOT / "pdfplume" / "static"), "pdfplume/static"), (str(ROOT / "LICENSE"), ".")]
for pkg in ("pymupdf.layout", "pyhanko", "pyhanko_certvalidator", "pymupdf4llm", "pdf2docx", "docx", "pptx"):
    datas += collect_data_files(pkg)

hidden = collect_submodules("pdfplume") + collect_submodules("pyhanko") + ["run", "waitress", "pillow_heif"]

a = Analysis(
    [str(ROOT / "desktop.py")],
    pathex=[str(ROOT)],
    datas=datas,
    hiddenimports=hidden,
    excludes=["pytest", "playwright", "IPython", "matplotlib", "tkinter.test"],
    noarchive=False,
)
pyz = PYZ(a.pure)
windowed = sys.platform in ("darwin", "win32")  # the Tk status window replaces the console
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="PDFPlume",
    console=not windowed,
    icon=ICON,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="PDFPlume", upx=False)
if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="PDFPlume.app",
        icon=ICON,
        bundle_identifier="app.pdfplume.local",
        info_plist={"CFBundleShortVersionString": "2.1.0", "NSHighResolutionCapable": True,
                    "LSApplicationCategoryType": "public.app-category.productivity"},
    )

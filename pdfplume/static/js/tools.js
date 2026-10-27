// Catalog of every tool: texts, categories, accepted files and sidebar options.

export const CATEGORIES = [
  { id: 'organize', name: 'Organize', color: '#3e63dd', blurb: 'Merge, split and rearrange pages' },
  { id: 'optimize', name: 'Optimize', color: '#2a9d61', blurb: 'Make files smaller, fix and recognise text' },
  { id: 'convert_to', name: 'Convert to PDF', color: '#c97a00', blurb: 'Turn documents and images into PDF' },
  { id: 'convert_from', name: 'Convert from PDF', color: '#0a8fb3', blurb: 'Export PDFs to editable formats' },
  { id: 'edit', name: 'Edit', color: '#d6409f', blurb: 'Annotate, stamp and reshape pages' },
  { id: 'security', name: 'Security', color: '#5b6577', blurb: 'Protect, sign, redact and compare' },
  { id: 'intelligence', name: 'Intelligence', color: '#8e4ec6', blurb: 'Summarize, ask questions and translate locally' },
];
export const CAT_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

const KEYWORDS = {
  merge_pdf: 'combine join append concatenate', split_pdf: 'separate divide cut ranges',
  remove_pages: 'delete pages', extract_pages: 'select pages save', organize_pdf: 'reorder sort pages move rearrange',
  scan_to_pdf: 'camera webcam photo phone', compress_pdf: 'reduce size shrink smaller optimize',
  repair_pdf: 'fix broken corrupt damaged recover', ocr_pdf: 'text recognition scan searchable',
  jpg_to_pdf: 'image png photo picture tiff webp', word_to_pdf: 'docx doc document', powerpoint_to_pdf: 'pptx ppt slides presentation',
  excel_to_pdf: 'xlsx xls csv spreadsheet sheet', html_to_pdf: 'web page website url',
  pdf_to_jpg: 'image png picture export', pdf_to_word: 'docx doc editable', pdf_to_powerpoint: 'pptx slides presentation',
  pdf_to_excel: 'xlsx spreadsheet table csv', pdf_to_text: 'markdown md txt text extract copy', pdf_to_pdfa: 'archive iso long-term',
  rotate_pdf: 'turn orientation landscape', add_page_numbers: 'numbering footer header pagination',
  add_watermark: 'stamp confidential logo draft', crop_pdf: 'trim margins cut', edit_pdf: 'annotate text draw shapes write',
  unlock_pdf: 'remove password decrypt', protect_pdf: 'password encrypt lock secure',
  sign_pdf: 'signature initials esign', redact_pdf: 'black out hide sensitive censor remove',
  compare_pdf: 'diff difference versions changes', summarize_pdf: 'ai summary key points tldr',
  translate_pdf: 'language translation ai',
  chat_pdf: 'ask question answer chat ai assistant search find rag ollama llm',
  fill_form: 'fill in form fields acroform application checkbox type answers', edit_metadata: 'metadata title author keywords bookmarks outline table of contents toc properties',
  nup_pdf: 'n-up multiple pages per sheet print handout 2-up 4-up', booklet_pdf: 'booklet print fold saddle stitch zine', resize_pdf: 'page size a4 letter scale paper margins', grayscale_pdf: 'black and white gray monochrome print ink',
};

const ACCEPT = {
  pdf: { ext: '.pdf', label: 'PDF', kinds: ['pdf'] },
  image: { ext: '.jpg,.jpeg,.png,.heic,.heif,.gif,.bmp,.tif,.tiff,.webp', label: 'images', kinds: ['image'] },
  word: { ext: '.doc,.docx,.odt,.rtf,.txt', label: 'Word', kinds: ['word'] },
  powerpoint: { ext: '.ppt,.pptx,.pps,.ppsx,.odp', label: 'PowerPoint', kinds: ['powerpoint'] },
  excel: { ext: '.xls,.xlsx,.ods,.csv', label: 'Excel', kinds: ['excel'] },
  html: { ext: '.html,.htm', label: 'HTML', kinds: ['html'] },
};

const POS9 = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right'];
export { POS9 };

const OCR_OPTION = { type: 'checkbox', key: 'ocr', label: 'Recognize text in scanned pages (OCR)', default: false, needs: 'tesseract' };

export const TOOLS = [
  // ------------------------------------------------------------- organize
  {
    slug: 'merge_pdf', name: 'Merge PDF', cat: 'organize', accept: 'pdf',
    multiple: true, minFiles: 2, sortable: true, rotatable: true,
    desc: 'Combine several PDFs into one document, in any order.',
    action: 'Merge files', done: 'Your PDFs are merged',
    options: [
      { type: 'note', html: 'Files are combined in the order shown. Drag cards to reorder; hover a card to rotate or remove it.' },
      { type: 'sortButtons' },
    ],
    next: ['compress_pdf', 'add_page_numbers', 'split_pdf', 'protect_pdf', 'organize_pdf', 'sign_pdf'],
  },
  {
    slug: 'split_pdf', name: 'Split PDF', cat: 'organize', accept: 'pdf',
    multiple: false, workspace: 'split',
    desc: 'Break a PDF into separate files by range, page or size.',
    action: 'Split PDF', done: 'Your PDF is split',
    next: ['merge_pdf', 'compress_pdf', 'pdf_to_jpg', 'organize_pdf'],
  },
  {
    slug: 'remove_pages', name: 'Remove pages', cat: 'organize', accept: 'pdf',
    multiple: false, workspace: 'pages', pageMode: 'remove',
    desc: 'Delete the pages you don’t need and keep the rest.',
    action: 'Remove pages', done: 'Pages removed',
    next: ['compress_pdf', 'merge_pdf', 'add_page_numbers', 'organize_pdf'],
  },
  {
    slug: 'extract_pages', name: 'Extract pages', cat: 'organize', accept: 'pdf',
    multiple: false, workspace: 'pages', pageMode: 'select',
    desc: 'Pull selected pages out into a new PDF.',
    action: 'Extract pages', done: 'Pages extracted',
    next: ['merge_pdf', 'compress_pdf', 'pdf_to_jpg', 'pdf_to_word'],
  },
  {
    slug: 'organize_pdf', name: 'Organize PDF', cat: 'organize', accept: 'pdf',
    multiple: true, workspace: 'pages', pageMode: 'organize',
    desc: 'Reorder, rotate, duplicate and delete pages visually.',
    action: 'Save order', done: 'Pages organized',
    next: ['compress_pdf', 'add_page_numbers', 'merge_pdf', 'sign_pdf'],
  },
  {
    slug: 'scan_to_pdf', name: 'Scan to PDF', cat: 'organize', accept: 'image',
    multiple: true, workspace: 'scan', sortable: true,
    desc: 'Capture paper documents with your camera and clean them up.',
    action: 'Create PDF', done: 'Scan saved as PDF',
    options: [
      { type: 'cards', key: 'filter', label: 'Image filter', default: 'enhance', grid: true, choices: [
        { value: 'enhance', title: 'Auto enhance', desc: 'Sharper, higher contrast' },
        { value: 'color', title: 'Original', desc: 'As captured' },
        { value: 'grayscale', title: 'Grayscale', desc: 'Smaller files' },
        { value: 'bw', title: 'Black & white', desc: 'Best for text' }] },
      { type: 'checkbox', key: 'auto_crop', label: 'Find the page edges and straighten the page', default: true,
        help: 'Use the crop button on a page to move the corners yourself.' },
      { type: 'seg', key: 'page_size', label: 'Page size', default: 'a4', choices: [
        { value: 'a4', label: 'A4' }, { value: 'letter', label: 'US Letter' }, { value: 'fit', label: 'Fit' }] },
      { type: 'seg', key: 'margin', label: 'Margin', default: 'none', choices: [
        { value: 'none', label: 'None' }, { value: 'small', label: 'Small' }, { value: 'big', label: 'Big' }] },
    ],
    next: ['ocr_pdf', 'compress_pdf', 'merge_pdf', 'sign_pdf'],
  },

  {
    slug: 'nup_pdf', name: 'Pages per sheet', cat: 'organize', accept: 'pdf',
    multiple: true,
    desc: 'Print several pages on one sheet – 2, 4, 6, 8, 9 or 16 per page.',
    action: 'Arrange pages', done: 'Pages arranged',
    options: [
      { type: 'seg', key: 'per_sheet', label: 'Pages per sheet', default: 4, choices: [2, 4, 6, 8, 9, 16].map((n) => ({ value: n, label: String(n) })) },
      { type: 'select', key: 'sheet', label: 'Sheet size', default: 'a4', choices: [
        { value: 'a4', label: 'A4' }, { value: 'letter', label: 'US Letter' }, { value: 'a3', label: 'A3' }, { value: 'same', label: 'Same as the original pages' }] },
      { type: 'seg', key: 'orientation', label: 'Orientation', default: 'auto', choices: [
        { value: 'auto', label: 'Best fit' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }] },
      { type: 'seg', key: 'order', label: 'Reading order', default: 'rows', choices: [
        { value: 'rows', label: 'Left to right' }, { value: 'columns', label: 'Top to bottom' }] },
      { type: 'row', items: [
        { type: 'number', key: 'margin', label: 'Margin (mm)', default: 8, min: 0, max: 40 },
        { type: 'number', key: 'gap', label: 'Spacing (mm)', default: 4, min: 0, max: 30 }] },
      { type: 'checkbox', key: 'border', label: 'Draw a thin border around each page', default: false },
    ],
    next: ['compress_pdf', 'add_page_numbers', 'merge_pdf'],
  },
  {
    slug: 'booklet_pdf', name: 'Booklet', cat: 'organize', accept: 'pdf',
    multiple: false,
    desc: 'Reorder pages so a printed, folded stack reads like a booklet.',
    action: 'Make booklet', done: 'Booklet ready',
    options: [
      { type: 'note', html: 'Pages are placed two per sheet side in print order. Blank pages are added so the total is a multiple of four.' },
      { type: 'select', key: 'sheet', label: 'Sheet size', default: 'same', choices: [
        { value: 'same', label: 'Two original pages side by side' }, { value: 'a4', label: 'A4 (landscape)' },
        { value: 'letter', label: 'US Letter (landscape)' }, { value: 'a3', label: 'A3 (landscape)' }] },
      { type: 'seg', key: 'binding', label: 'Binding', default: 'left', choices: [
        { value: 'left', label: 'Left (most languages)' }, { value: 'right', label: 'Right (Arabic, Hebrew …)' }] },
      { type: 'number', key: 'margin', label: 'Margin (mm)', default: 5, min: 0, max: 30 },
    ],
    next: ['compress_pdf', 'grayscale_pdf'],
  },
  {
    slug: 'resize_pdf', name: 'Resize pages', cat: 'organize', accept: 'pdf',
    multiple: true,
    desc: 'Change the paper size – e.g. Letter to A4 – and add margins.',
    action: 'Resize', done: 'Pages resized',
    options: [
      { type: 'select', key: 'size', label: 'New page size', default: 'a4', choices: [
        { value: 'a4', label: 'A4 (210 × 297 mm)' }, { value: 'letter', label: 'US Letter (8.5 × 11 in)' }, { value: 'legal', label: 'US Legal' },
        { value: 'a3', label: 'A3' }, { value: 'a5', label: 'A5' }, { value: 'custom', label: 'Custom size' }] },
      { type: 'row', when: (o) => o.size === 'custom', items: [
        { type: 'number', key: 'width_mm', label: 'Width (mm)', default: 210, min: 20 },
        { type: 'number', key: 'height_mm', label: 'Height (mm)', default: 297, min: 20 }] },
      { type: 'seg', key: 'orientation', label: 'Orientation', default: 'auto', choices: [
        { value: 'auto', label: 'Match each page' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }] },
      { type: 'cards', key: 'mode', default: 'fit', choices: [
        { value: 'fit', title: 'Scale to fit', desc: 'Content grows or shrinks to fill the new page.' },
        { value: 'keep', title: 'Keep original scale', desc: 'Only the paper changes; content stays centred at 100%.' }] },
      { type: 'number', key: 'margin', label: 'Extra margin (mm)', default: 0, min: 0, max: 60 },
    ],
    next: ['compress_pdf', 'nup_pdf', 'add_page_numbers'],
  },

  // ------------------------------------------------------------- optimize
  {
    slug: 'compress_pdf', name: 'Compress PDF', cat: 'optimize', accept: 'pdf',
    multiple: true,
    desc: 'Shrink file size while keeping text sharp and images clear.',
    action: 'Compress', done: 'Compression complete',
    options: [
      { type: 'tabs', key: 'mode', default: 'level', choices: [
        { value: 'level', label: 'By quality', icon: 'sparkle' }, { value: 'target', label: 'By file size', icon: 'files' }] },
      { type: 'number', key: 'target_mb', label: 'Maximum size per file (MB)', default: 2, min: 0.1, step: 0.1, when: (o) => o.mode === 'target',
        help: 'PDFPlume uses the gentlest compression that fits. Common limits: e-mail 10–25 MB, upload forms 1–5 MB.' },
      { type: 'cards', key: 'level', label: 'Compression level', default: 'recommended', when: (o) => o.mode !== 'target', choices: [
        { value: 'extreme', title: 'Strong', desc: 'Smallest file – images become visibly softer' },
        { value: 'recommended', title: 'Balanced', desc: 'Much smaller with good quality (recommended)' },
        { value: 'low', title: 'Light', desc: 'Near-original quality, modest savings' }] },
    ],
    next: ['merge_pdf', 'pdf_to_jpg', 'protect_pdf', 'split_pdf', 'pdf_to_word'],
  },
  {
    slug: 'repair_pdf', name: 'Repair PDF', cat: 'optimize', accept: 'pdf',
    multiple: true,
    desc: 'Rebuild damaged or corrupt PDFs and recover their content.',
    action: 'Repair', done: 'Repair complete',
    options: [{ type: 'note', html: 'Rebuilds broken cross-reference tables, damaged streams and missing objects. Protected files need their password.' }],
    next: ['compress_pdf', 'merge_pdf', 'pdf_to_word', 'ocr_pdf'],
  },
  {
    slug: 'ocr_pdf', name: 'OCR PDF', cat: 'optimize', accept: 'pdf',
    multiple: true, needs: 'tesseract',
    desc: 'Make scanned PDFs searchable and copyable.',
    action: 'Recognize text', done: 'Text is now searchable',
    options: [
      { type: 'language', key: 'language', label: 'Document language', default: 'eng', multiple: true },
      { type: 'checkbox', key: 'force', label: 'Re-run OCR on pages that already have text', default: false },
    ],
    next: ['pdf_to_word', 'compress_pdf', 'summarize_pdf', 'translate_pdf'],
  },

  {
    slug: 'grayscale_pdf', name: 'Grayscale PDF', cat: 'optimize', accept: 'pdf',
    multiple: true,
    desc: 'Turn colours into shades of gray for cheaper, print-friendly copies.',
    action: 'Convert to grayscale', done: 'Converted to grayscale',
    options: [{ type: 'note', html: 'Text stays selectable and sharp; photos, drawings and coloured text become gray.' }],
    next: ['compress_pdf', 'booklet_pdf', 'nup_pdf'],
  },

  // ----------------------------------------------------------- convert to
  {
    slug: 'jpg_to_pdf', name: 'Images to PDF', cat: 'convert_to', accept: 'image',
    multiple: true, sortable: true, rotatable: false,
    desc: 'Turn photos and images into a tidy PDF.',
    action: 'Convert to PDF', done: 'Images converted',
    options: [
      { type: 'seg', key: 'orientation', label: 'Page orientation', default: 'portrait', choices: [
        { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }, { value: 'auto', label: 'Auto' }] },
      { type: 'seg', key: 'page_size', label: 'Page size', default: 'a4', choices: [
        { value: 'fit', label: 'Fit (same size)' }, { value: 'a4', label: 'A4' }, { value: 'letter', label: 'US Letter' }] },
      { type: 'seg', key: 'margin', label: 'Margin', default: 'none', choices: [
        { value: 'none', label: 'No margin' }, { value: 'small', label: 'Small' }, { value: 'big', label: 'Big' }] },
      { type: 'checkbox', key: 'merge', label: 'Combine all images into one PDF', default: true },
    ],
    next: ['merge_pdf', 'compress_pdf', 'ocr_pdf', 'organize_pdf'],
  },
  {
    slug: 'word_to_pdf', name: 'Word to PDF', cat: 'convert_to', accept: 'word',
    multiple: true, engine: 'libreoffice',
    desc: 'Convert Word documents to PDF with their layout intact.',
    action: 'Convert to PDF', done: 'Converted to PDF',
    next: ['merge_pdf', 'compress_pdf', 'protect_pdf', 'sign_pdf'],
  },
  {
    slug: 'powerpoint_to_pdf', name: 'PowerPoint to PDF', cat: 'convert_to', accept: 'powerpoint',
    multiple: true, engine: 'libreoffice',
    desc: 'Convert slide decks to PDF for easy sharing.',
    action: 'Convert to PDF', done: 'Converted to PDF',
    next: ['merge_pdf', 'compress_pdf', 'add_watermark', 'pdf_to_jpg'],
  },
  {
    slug: 'excel_to_pdf', name: 'Excel to PDF', cat: 'convert_to', accept: 'excel',
    multiple: true, engine: 'libreoffice',
    desc: 'Convert spreadsheets and CSV files to print-ready PDF.',
    action: 'Convert to PDF', done: 'Converted to PDF',
    next: ['merge_pdf', 'compress_pdf', 'add_page_numbers', 'protect_pdf'],
  },
  {
    slug: 'html_to_pdf', name: 'HTML to PDF', cat: 'convert_to', accept: 'html',
    multiple: true, workspace: 'url', minFiles: 0,
    desc: 'Save any web page or HTML file as a PDF.',
    action: 'Convert to PDF', done: 'Page saved as PDF',
    options: [
      { type: 'seg', key: 'viewport', label: 'Screen size', default: 'desktop', choices: [
        { value: 'desktop', label: 'Desktop' }, { value: 'laptop', label: 'Laptop' }, { value: 'tablet', label: 'Tablet' }, { value: 'mobile', label: 'Mobile' }] },
      { type: 'select', key: 'page_size', label: 'Page size', default: 'a4', choices: [
        { value: 'a4', label: 'A4 (297 × 210 mm)' }, { value: 'letter', label: 'US Letter (215 × 279.4 mm)' },
        { value: 'legal', label: 'US Legal' }, { value: 'a3', label: 'A3' }, { value: 'one_page', label: 'One long page' }] },
      { type: 'seg', key: 'orientation', label: 'Orientation', default: 'portrait', when: (o) => o.page_size !== 'one_page', choices: [
        { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }] },
      { type: 'seg', key: 'margin', label: 'Margin', default: 'small', when: (o) => o.page_size !== 'one_page', choices: [
        { value: 'none', label: 'No margin' }, { value: 'small', label: 'Small' }, { value: 'big', label: 'Big' }] },
    ],
    next: ['compress_pdf', 'merge_pdf', 'add_watermark', 'summarize_pdf'],
  },

  // --------------------------------------------------------- convert from
  {
    slug: 'pdf_to_jpg', name: 'PDF to images', cat: 'convert_from', accept: 'pdf',
    multiple: true,
    desc: 'Export pages as images, or pull out embedded pictures.',
    action: 'Export images', done: 'Images ready',
    options: [
      { type: 'cards', key: 'mode', default: 'pages', choices: [
        { value: 'pages', title: 'Pages as images', desc: 'Each page becomes one image file.' },
        { value: 'extract', title: 'Embedded pictures', desc: 'Save the photos and graphics stored inside the PDF.' }] },
      { type: 'seg', key: 'quality', label: 'Image quality', default: 'normal', when: (o) => o.mode !== 'extract', choices: [
        { value: 'low', label: 'Low (96 dpi)' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High (300 dpi)' }] },
      { type: 'seg', key: 'format', label: 'Format', default: 'jpg', choices: [
        { value: 'jpg', label: 'JPG' }, { value: 'png', label: 'PNG' }] },
    ],
    next: ['jpg_to_pdf', 'compress_pdf', 'merge_pdf'],
  },
  {
    slug: 'pdf_to_word', name: 'PDF to Word', cat: 'convert_from', accept: 'pdf',
    multiple: true,
    desc: 'Turn a PDF into an editable Word document.',
    action: 'Convert to Word', done: 'Word document ready',
    options: [
      { type: 'cards', key: 'ocr', default: false, choices: [
        { value: false, title: 'Digital PDF', desc: 'Text can already be selected – fastest and most accurate.' },
        { value: true, title: 'Scanned PDF', desc: 'Recognize the text in scanned pages first (OCR).', needs: 'tesseract' }] },
    ],
    next: ['word_to_pdf', 'compress_pdf', 'pdf_to_excel'],
  },
  {
    slug: 'pdf_to_powerpoint', name: 'PDF to PowerPoint', cat: 'convert_from', accept: 'pdf',
    multiple: true,
    desc: 'Turn PDF pages into editable slides.',
    action: 'Convert to PowerPoint', done: 'Presentation ready',
    options: [
      { type: 'cards', key: 'mode', default: 'editable', choices: [
        { value: 'editable', title: 'Editable text', desc: 'Text becomes editable text boxes on top of the page graphics.' },
        { value: 'image', title: 'Exact look', desc: 'Each page becomes a picture slide (not editable).' }] },
      OCR_OPTION,
    ],
    next: ['powerpoint_to_pdf', 'compress_pdf', 'pdf_to_word'],
  },
  {
    slug: 'pdf_to_excel', name: 'PDF to Excel', cat: 'convert_from', accept: 'pdf',
    multiple: true,
    desc: 'Extract tables from PDFs into spreadsheets.',
    action: 'Convert to Excel', done: 'Spreadsheet ready',
    options: [
      { type: 'cards', key: 'layout', default: 'per_page', choices: [
        { value: 'per_page', title: 'One sheet per page', desc: 'Every PDF page goes to its own worksheet.' },
        { value: 'single', title: 'Single sheet', desc: 'All tables are stacked in one worksheet.' }] },
      OCR_OPTION,
    ],
    next: ['excel_to_pdf', 'pdf_to_word', 'compress_pdf'],
  },
  {
    slug: 'pdf_to_text', name: 'PDF to Markdown', cat: 'convert_from', accept: 'pdf',
    multiple: true,
    desc: 'Get the text of a PDF as Markdown (headings, lists, tables) or plain text.',
    action: 'Extract text', done: 'Text ready',
    options: [
      { type: 'cards', key: 'format', default: 'md', choices: [
        { value: 'md', title: 'Markdown', desc: 'Keeps headings, lists, bold text and tables – great for notes and AI tools.' },
        { value: 'txt', title: 'Plain text', desc: 'Just the words, page by page.' }] },
      { type: 'checkbox', key: 'page_markers', label: 'Mark where each page starts', default: true, when: (o) => o.format === 'txt' },
      OCR_OPTION,
    ],
    next: ['summarize_pdf', 'translate_pdf', 'compress_pdf'],
  },
  {
    slug: 'pdf_to_pdfa', name: 'PDF to PDF/A', cat: 'convert_from', accept: 'pdf',
    multiple: true,
    desc: 'Convert to PDF/A for long-term archiving.',
    action: 'Convert to PDF/A', done: 'PDF/A ready',
    options: [
      { type: 'cards', key: 'conformance', label: 'Conformance level', default: '2b', choices: [
        { value: '1b', title: 'PDF/A-1b', desc: 'Strictest, maximum compatibility (no transparency).' },
        { value: '2b', title: 'PDF/A-2b', desc: 'Recommended - supports transparency and layers.' },
        { value: '3b', title: 'PDF/A-3b', desc: 'Like 2b, also allows embedded files.' }] },
    ],
    next: ['compress_pdf', 'protect_pdf', 'sign_pdf'],
  },

  // ------------------------------------------------------------------ edit
  {
    slug: 'rotate_pdf', name: 'Rotate PDF', cat: 'edit', accept: 'pdf',
    multiple: true, workspace: 'rotate',
    desc: 'Fix page orientation for whole files or single pages.',
    action: 'Apply rotation', done: 'Rotation applied',
    next: ['compress_pdf', 'merge_pdf', 'organize_pdf'],
  },
  {
    slug: 'add_page_numbers', name: 'Page numbers', cat: 'edit', accept: 'pdf',
    multiple: true, preview: 'numbers',
    desc: 'Number your pages with full control over position and style.',
    action: 'Add numbers', done: 'Page numbers added',
    options: [
      { type: 'cards', key: 'mode', label: 'Page mode', default: 'single', grid: true, center: true, choices: [
        { value: 'single', title: 'Single page' }, { value: 'facing', title: 'Facing pages' }] },
      { type: 'position', key: 'position', label: 'Position', default: 'bottom-center', disable: ['middle-left', 'middle-center', 'middle-right'] },
      { type: 'seg', key: 'margin', label: 'Margin', default: 'recommended', choices: [
        { value: 'small', label: 'Small' }, { value: 'recommended', label: 'Recommended' }, { value: 'big', label: 'Big' }] },
      { type: 'number', key: 'first_number', label: 'First number', default: 1, min: 0 },
      { type: 'text', key: 'pages', label: 'Pages', default: 'all', placeholder: 'all, or e.g. 2-10', help: 'Use “all”, a range like 2-10 or a list like 1,3,5.' },
      { type: 'select', key: 'format', label: 'Text', default: '{n}', choices: [
        { value: '{n}', label: 'Number only (1, 2, 3 …)' }, { value: 'Page {n}', label: 'Page {n}' },
        { value: 'Page {n} of {p}', label: 'Page {n} of {p}' }, { value: '{n} / {p}', label: '{n} / {p}' },
        { value: 'custom', label: 'Custom' }] },
      { type: 'text', key: 'custom_text', label: 'Custom text', default: '- {n} -', when: (o) => o.format === 'custom', help: '{n} = page number, {p} = total pages' },
      { type: 'textstyle', keys: { font: 'font', size: 'font_size', bold: 'bold', italic: 'italic', color: 'color' },
        defaults: { font: 'helvetica', font_size: 12, bold: false, italic: false, color: '#000000' }, label: 'Text format' },
    ],
    next: ['compress_pdf', 'merge_pdf', 'add_watermark', 'protect_pdf'],
  },
  {
    slug: 'add_watermark', name: 'Add watermark', cat: 'edit', accept: 'pdf',
    multiple: true, preview: 'watermark',
    desc: 'Stamp text or a logo across your pages.',
    action: 'Add watermark', done: 'Watermark added',
    options: [
      { type: 'tabs', key: 'type', default: 'text', choices: [
        { value: 'text', label: 'Place text', icon: 'text' }, { value: 'image', label: 'Place image', icon: 'image' }] },
      { type: 'textarea', key: 'text', label: 'Text', default: 'CONFIDENTIAL', when: (o) => o.type === 'text' },
      { type: 'textstyle', when: (o) => o.type === 'text', underline: true,
        keys: { font: 'font', size: 'font_size', bold: 'bold', italic: 'italic', underline: 'underline', color: 'color' },
        defaults: { font: 'helvetica', font_size: 48, bold: true, italic: false, underline: false, color: '#5b5bd6' }, label: 'Text format' },
      { type: 'image', key: 'image_id', label: 'Image', when: (o) => o.type === 'image' },
      { type: 'range', key: 'image_size', label: 'Image size (% of page width)', default: 40, min: 5, max: 100, when: (o) => o.type === 'image' },
      { type: 'position', key: 'position', label: 'Position', default: 'middle-center', mosaicKey: 'mosaic' },
      { type: 'row', items: [
        { type: 'select', key: 'opacity', label: 'Transparency', default: 50, number: true, choices: [
          { value: 100, label: 'No transparency' }, { value: 75, label: '25%' }, { value: 50, label: '50%' },
          { value: 25, label: '75%' }, { value: 10, label: '90%' }] },
        { type: 'select', key: 'rotation', label: 'Rotation', default: 45, number: true, choices: [
          { value: 0, label: 'Do not rotate' }, { value: 45, label: '45 degrees' }, { value: 90, label: '90 degrees' },
          { value: 180, label: '180 degrees' }, { value: 270, label: '270 degrees' }, { value: 315, label: '-45 degrees' }] }] },
      { type: 'text', key: 'pages', label: 'Pages', default: 'all', placeholder: 'all, or e.g. 1-3' },
      { type: 'cards', key: 'layer', label: 'Layer', default: 'over', grid: true, center: true, choices: [
        { value: 'over', title: 'On top' }, { value: 'below', title: 'Behind content' }] },
    ],
    next: ['compress_pdf', 'protect_pdf', 'merge_pdf', 'add_page_numbers'],
  },
  {
    slug: 'crop_pdf', name: 'Crop PDF', cat: 'edit', accept: 'pdf',
    multiple: false, workspace: 'crop',
    desc: 'Trim margins or keep just the area you need.',
    action: 'Crop', done: 'Pages cropped',
    next: ['compress_pdf', 'merge_pdf', 'pdf_to_jpg'],
  },
  {
    slug: 'edit_pdf', name: 'Edit PDF', cat: 'edit', accept: 'pdf',
    multiple: false, workspace: 'editor',
    desc: 'Change the existing text, or add text, images, shapes and drawings.',
    action: 'Save PDF', done: 'Changes saved',
    next: ['compress_pdf', 'sign_pdf', 'protect_pdf', 'merge_pdf'],
  },

  // -------------------------------------------------------------- security
  {
    slug: 'fill_form', name: 'Fill PDF form', cat: 'edit', accept: 'pdf',
    multiple: false, workspace: 'form',
    desc: 'Type into a PDF form’s fields, tick its boxes and pick its options.',
    action: 'Save form', done: 'Form filled in',
    next: ['sign_pdf', 'compress_pdf', 'protect_pdf', 'merge_pdf'],
  },
  {
    slug: 'edit_metadata', name: 'Properties & bookmarks', cat: 'edit', accept: 'pdf',
    multiple: false, workspace: 'outline',
    desc: 'Edit the title, author and keywords, and build a clickable table of contents.',
    action: 'Save PDF', done: 'Properties saved',
    next: ['compress_pdf', 'add_page_numbers', 'protect_pdf', 'pdf_to_pdfa'],
  },
  {
    slug: 'unlock_pdf', name: 'Unlock PDF', cat: 'security', accept: 'pdf',
    multiple: true, keepLocked: true,
    desc: 'Remove passwords and restrictions from PDFs you own.',
    action: 'Unlock', done: 'Protection removed',
    options: [{ type: 'note', html: 'Files that only restrict printing or copying unlock instantly. Files that need a password to open will ask for it once.' }],
    next: ['compress_pdf', 'merge_pdf', 'pdf_to_word', 'edit_pdf'],
  },
  {
    slug: 'protect_pdf', name: 'Protect PDF', cat: 'security', accept: 'pdf',
    multiple: true,
    desc: 'Encrypt a PDF with a password and set permissions.',
    action: 'Protect', done: 'PDF protected',
    options: [
      { type: 'password', key: 'password', label: 'Type password', default: '' },
      { type: 'password', key: 'confirm', label: 'Repeat password', default: '' },
      { type: 'note', html: 'Files are encrypted with AES-256. Don’t forget your password - it can’t be recovered.' },
      { type: 'details', label: 'Permissions (optional)', items: [
        { type: 'checkbox', key: 'allow_print', label: 'Allow printing', default: true },
        { type: 'checkbox', key: 'allow_copy', label: 'Allow copying text and images', default: true },
        { type: 'checkbox', key: 'allow_modify', label: 'Allow editing and annotations', default: true },
        { type: 'password', key: 'owner_password', label: 'Owner password (to change permissions)', default: '' }] },
    ],
    next: ['compress_pdf', 'merge_pdf', 'unlock_pdf'],
  },
  {
    slug: 'sign_pdf', name: 'Sign PDF', cat: 'security', accept: 'pdf',
    multiple: false, workspace: 'sign',
    desc: 'Type, draw or upload your signature and place it on the page.',
    action: 'Sign document', done: 'Document signed',
    next: ['protect_pdf', 'compress_pdf', 'merge_pdf', 'pdf_to_pdfa'],
  },
  {
    slug: 'redact_pdf', name: 'Redact PDF', cat: 'security', accept: 'pdf',
    multiple: false, workspace: 'redact',
    desc: 'Permanently black out sensitive text and areas.',
    action: 'Apply redaction', done: 'Redaction applied',
    next: ['protect_pdf', 'compress_pdf', 'sign_pdf'],
  },
  {
    slug: 'compare_pdf', name: 'Compare PDF', cat: 'security', accept: 'pdf',
    multiple: true, minFiles: 2, maxFiles: 2, workspace: 'compare',
    desc: 'Spot every change between two versions of a document.',
    action: 'Compare', done: 'Comparison ready',
    options: [
      { type: 'cards', key: 'mode', default: 'text', choices: [
        { value: 'text', title: 'Text changes', desc: 'Lists every added, removed and reworded passage.' },
        { value: 'overlay', title: 'Visual overlay', desc: 'Lays the pages on top of each other to show what moved or changed.' }] },
      { type: 'checkbox', key: 'ignore_case', label: 'Ignore upper/lower case', default: false, when: (o) => o.mode === 'text' },
    ],
    next: ['merge_pdf', 'edit_pdf', 'sign_pdf'],
  },

  // ---------------------------------------------------------- intelligence
  {
    slug: 'summarize_pdf', name: 'AI Summarizer', cat: 'intelligence', accept: 'pdf',
    multiple: false, tag: 'Local AI',
    desc: 'Get the key points of a long PDF in seconds.',
    action: 'Summarize', done: 'Summary ready',
    options: [
      { type: 'seg', key: 'length', label: 'Summary length', default: 'medium', choices: [
        { value: 'short', label: 'Short' }, { value: 'medium', label: 'Medium' }, { value: 'long', label: 'Long' }] },
      { type: 'cards', key: 'engine', label: 'Engine', default: 'builtin', needsOllama: true, choices: [
        { value: 'builtin', title: 'Built-in (offline)', desc: 'Picks the most important sentences.' },
        { value: 'ollama', title: 'Local LLM (Ollama)', desc: 'Writes a new summary with your Ollama model.' }] },
      { type: 'checkbox', key: 'sections', label: 'Also summarize section by section', default: true },
      { type: 'checkbox', key: 'ocr', label: 'Read scanned pages with OCR', default: true, needs: 'tesseract' },
    ],
    next: ['chat_pdf', 'translate_pdf', 'compress_pdf', 'pdf_to_word'],
  },
  {
    slug: 'chat_pdf', name: 'Chat with PDF', cat: 'intelligence', accept: 'pdf',
    multiple: false, workspace: 'chat', tag: 'Local AI',
    desc: 'Ask questions and get answers with the pages they come from.',
    action: 'Ask', done: '',
  },
  {
    slug: 'translate_pdf', name: 'Translate PDF', cat: 'intelligence', accept: 'pdf',
    multiple: false, tag: 'Local AI', needs: 'translation',
    desc: 'Translate a PDF while keeping its layout.',
    action: 'Translate', done: 'Translation ready',
    options: [
      { type: 'language', key: 'source', label: 'From', default: 'auto', source: 'translate', auto: true },
      { type: 'language', key: 'target', label: 'To', default: 'es', source: 'translate' },
    ],
    next: ['summarize_pdf', 'compress_pdf', 'pdf_to_word'],
  },
];

for (const t of TOOLS) {
  t.acceptInfo = ACCEPT[t.accept];
  t.url = '/' + t.slug;
  t.color = CAT_MAP[t.cat].color;
  t.keywords = KEYWORDS[t.slug] || '';
}

export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.slug, t]));
export const POPULAR = ['merge_pdf', 'compress_pdf', 'edit_pdf', 'sign_pdf', 'pdf_to_word', 'split_pdf'];
export const DEFAULT_PINS = ['merge_pdf', 'compress_pdf', 'edit_pdf', 'sign_pdf'];
export const CONVERT_MENU = {
  to: ['jpg_to_pdf', 'word_to_pdf', 'powerpoint_to_pdf', 'excel_to_pdf', 'html_to_pdf'],
  from: ['pdf_to_jpg', 'pdf_to_word', 'pdf_to_powerpoint', 'pdf_to_excel', 'pdf_to_text', 'pdf_to_pdfa'],
};
export const KIND_COLOR = { pdf: '#5b5bd6', image: '#c97a00', word: '#2b579a', powerpoint: '#c4441c', excel: '#1e7145', html: '#0a8fb3' };

// My Health - read a PDF or image IN THE BROWSER. The file never leaves the device for extraction:
// pdf.js reads the text layer; scanned pages and images go through Tesseract OCR running locally (WebAssembly).
// Only the two libraries (and Tesseract's English language data) are downloaded from the jsDelivr CDN.
import { buildLinesFromItems } from './extract.mjs';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
export const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_OCR_PAGES = 12;
export const ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';

const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) scripts.set(src, new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    s.onload = res; s.onerror = () => { scripts.delete(src); rej(new Error('Could not download a required library. Check your internet connection and try again.')); };
    document.head.appendChild(s);
  }));
  return scripts.get(src);
}

export function fileKind(file) {
  const n = (file.name || '').toLowerCase(); const t = file.type || '';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (t === 'image/jpeg' || t === 'image/png' || /\.(jpe?g|png)$/.test(n)) return 'image';
  return null;
}

async function canvasFromImage(file) {
  const bmp = await createImageBitmap(file);
  const longest = Math.max(bmp.width, bmp.height);
  const scale = longest > 3200 ? 3200 / longest : longest < 1400 ? Math.min(2, 1800 / longest) : 1;
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d'); try { ctx.filter = 'grayscale(1) contrast(1.15)'; } catch { /* Safari: no filter, still fine */ }
  ctx.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  return c;
}

let ocrWorker = null;
async function getOcr(onProgress) {
  if (ocrWorker) return ocrWorker;
  await loadScript(TESS);
  onProgress?.('Preparing the text reader (first time only, about 10 MB)...');
  ocrWorker = await window.Tesseract.createWorker('eng', 1, {
    logger: (m) => { if (m.status === 'recognizing text' && m.progress != null) onProgress?.(`Reading text from the image... ${Math.round(m.progress * 100)}%`); },
  });
  await ocrWorker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '6' });
  return ocrWorker;
}
async function ocrCanvas(canvas, onProgress) {
  const w = await getOcr(onProgress);
  const { data } = await w.recognize(canvas);
  const lines = (data.lines || []).map((l) => ({ text: (l.text || '').replace(/\s+$/, ''), conf: l.confidence })).filter((l) => l.text.trim());
  return lines.length ? lines : String(data.text || '').split('\n').filter((t) => t.trim()).map((text) => ({ text, conf: data.confidence }));
}
export async function stopOcr() { try { await ocrWorker?.terminate(); } catch { /* ignore */ } ocrWorker = null; }

// returns { pages: [{ lines, ocr }], method: 'text'|'ocr'|'mixed', pageCount, truncated }
export async function readFile(file, onProgress = () => {}) {
  const kind = fileKind(file);
  if (!kind) throw new Error('Please choose a PDF, JPG or PNG file.');
  if (file.size > MAX_BYTES) throw new Error('This file is larger than 15 MB. Please choose a smaller file.');
  if (kind === 'image') {
    onProgress('Opening the image...');
    const canvas = await canvasFromImage(file);
    const lines = await ocrCanvas(canvas, onProgress);
    return { pages: [{ lines, ocr: true }], method: 'ocr', pageCount: 1, truncated: false };
  }
  onProgress('Opening the PDF...');
  await loadScript(PDFJS);
  const pdfjs = window.pdfjsLib; pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  let pdf;
  try { pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; }
  catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password and upload it again.');
    throw new Error('This PDF could not be opened. It may be damaged.');
  }
  const pages = []; let ocrPages = 0, textPages = 0, truncated = false;
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress(`Reading page ${i} of ${pdf.numPages}...`);
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const items = tc.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width }));
    const lines = buildLinesFromItems(items);
    if (lines.join('').replace(/\s/g, '').length >= 40) { pages.push({ lines, ocr: false }); textPages++; continue; }
    if (ocrPages >= MAX_OCR_PAGES) { truncated = true; continue; }
    onProgress(`Page ${i} is a scan. Reading it with OCR...`);
    const vp = page.getViewport({ scale: 2.2 });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    pages.push({ lines: await ocrCanvas(c, (m) => onProgress(`Page ${i}: ${m}`)), ocr: true }); ocrPages++;
  }
  try { pdf.destroy?.(); } catch { /* ignore */ }
  return { pages, method: ocrPages && textPages ? 'mixed' : ocrPages ? 'ocr' : 'text', pageCount: pdf.numPages, truncated };
}

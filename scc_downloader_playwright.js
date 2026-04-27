#!/usr/bin/env node
/**
 * SCC Online - PDF Downloader (Playwright version)
 *
 * First run  → opens a real browser so you can log in manually
 *              then saves full session state (cookies + localStorage)
 * Later runs → reuses saved session, no manual login needed
 *
 * Setup:
 *   npm install playwright
 *   npx playwright install chromium
 *   node scc_downloader_playwright.js
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ══════════════════════════════════════════════
//  SECTION TO DOWNLOAD
// ══════════════════════════════════════════════
const SECTION = 'Moot Court Resource Materials';
// Change as needed:
// 'Browse Law Reports'
// 'Browse Judgments'
// 'Browse Legislation'
// 'Browse Articles & Short Pieces'
// 'Browse Secondary Material'
// 'Browse Treaties, Conventions, and Instruments'

const DOWNLOAD_DIR    = './SCC_Downloads';
const PROGRESS_FILE   = `./progress_${SECTION.replace(/[^a-z0-9]/gi,'_')}.json`;
const DOCS_FILE       = `./docs_${SECTION.replace(/[^a-z0-9]/gi,'_')}.json`;
const SESSION_FILE    = './scc_session.json';
const SELECTED_COURT  = '00000111111101011111011111111111110101111111111111111111111111111100111111111111111111111111111111111111111111111111111101111111111111111111111101111111111101111111111111111111111111111111111111111111111111011111111110011111101111011111101011111111';
const API_DELAY       = 350;
const DL_DELAY        = 700;
const CONCURRENCY     = 3;   // parallel download pages

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
const sleep    = ms => new Promise(r => setTimeout(r, ms));
const sanitize = s  => (s||'unnamed').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().slice(0,150);

// ─────────────────────────────────────────────
// Phase 0 — Login & save session
// Opens a visible browser. You log in yourself,
// then press Enter in the terminal.
// ─────────────────────────────────────────────
async function loginAndSaveSession() {
  console.log('\n── LOGIN REQUIRED ──────────────────────────────');
  console.log('A browser window will open.');
  console.log('1. Log in at Knimbus (christuniversity.knimbus.com)');
  console.log('2. Navigate through to SCC Online so the session is fully established');
  console.log('3. Come back here and press Enter\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page    = await context.newPage();

  await page.goto('https://christuniversity.knimbus.com/portal/v2/default/login');

  // Wait for user to finish logging in
  await new Promise(resolve => {
    process.stdout.write('Press Enter once you are fully logged in and can see SCC content... ');
    process.stdin.once('data', resolve);
  });

  // Save full state — cookies AND localStorage
  const state = await context.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
  console.log(`\n✓ Session saved to ${SESSION_FILE}\n`);

  await browser.close();
}

// ─────────────────────────────────────────────
// Build a browser context from saved session
// ─────────────────────────────────────────────
async function buildContext(browser) {
  if (!fs.existsSync(SESSION_FILE)) {
    await loginAndSaveSession();
  }
  return browser.newContext({
    storageState: SESSION_FILE,
    acceptDownloads: true,
  });
}

// ─────────────────────────────────────────────
// Tree API — still uses fetch() inside the page
// so it rides the real authenticated session
// ─────────────────────────────────────────────
const basePayload = () => ({
  ReturnOnExit: false, RequiredRows: 500,
  SelectedCourt: SELECTED_COURT, HighlightTree: true,
  IsIclrContent: false, IsJudiciaryPackage: false, SearchText: '',
  IsMootCourtAccessible: 'true', CountryName: 'singapore',
  SearchType: SECTION, IsBrowseBySearch: false,
  UserSubscribedAddonList: ['NoAddOn'],
});

async function callTree(page, details) {
  await sleep(API_DELAY);
  // Run fetch inside the page so cookies are attached automatically
  const result = await page.evaluate(async (payload) => {
    const res = await fetch('https://www.scconline.com/Searcher.svc/SearchBrowseTree', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type':     'application/json; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer':          'https://www.scconline.com/Members/BrowseResult.aspx',
      },
      body: JSON.stringify({ searchDetails: payload }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.d === undefined) throw new Error('Session expired');
    return json.d || [];
  }, details);
  return result;
}

// ─────────────────────────────────────────────
// Recursive discovery (same logic as original)
// ─────────────────────────────────────────────
async function traverse(page, node, ancestors, docs) {
  const title = node.title || (node.key||'').split('$Break$')[0];

  if (node.DOI && !node.hasChildren) {
    docs.push({ doi: node.DOI, title });
    process.stdout.write(`\r    found: ${docs.length} docs   `);
    return;
  }

  let children = node.children || [];

  if (node.hasChildren && (node.isLazy || !children.length)) {
    const lineage     = [...ancestors, title];
    const childLevel  = `Node${lineage.length + 1}`;
    const parentLevel = `Node${lineage.length}`;
    const qParts      = lineage.slice(1).reverse()
      .map((t,i) => `Node${lineage.length - i}:"${t}"`);

    try {
      const r = await callTree(page, {
        ...basePayload(),
        QueryText:  qParts.join(' AND '),
        SearchField: childLevel,
        QueryType:   title,
        parentNode:  parentLevel,
        HasChildren: true,
      });
      children = r?.[0]?.children || [];
    } catch(e) {
      if (e.message.includes('expired')) {
        console.log('\n  Session expired mid-crawl.');
        console.log('  Delete scc_session.json and restart to re-login.\n');
        process.exit(1);
      }
      console.log(`\n  ✗ Failed "${title}": ${e.message}`);
      return;
    }
  }

  for (const child of children) {
    await traverse(page, child, [...ancestors, title], docs);
  }
}

// ─────────────────────────────────────────────
// Download one PDF via Playwright
// Tries direct navigation first (catches the
// download event), falls back to alternate URLs
// ─────────────────────────────────────────────
let progress = {};
let dlCount = 0, skipCount = 0, failCount = 0;
const saveProgress = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));

async function downloadOne(context, doi, title, total, retry = 0) {
  if (progress[doi] === 'done') { skipCount++; return; }

  const fname   = sanitize(title) + '__' + doi.replace(/[^a-zA-Z0-9\-]/g,'_') + '.pdf';
  const outPath = path.join(DOWNLOAD_DIR, fname);

  // Build the viewer URL directly from the DOI
  // enc = base64( doi + "&&&&&40&&&&&Search&&&&&fullscreen&&&&&false&&&&&&&&&&Phrase&&&&&DocumentResult&&&&&false&&&&&&&&&&" )
  const enc     = Buffer.from(doi + '&&&&&40&&&&&Search&&&&&fullscreen&&&&&false&&&&&&&&&&Phrase&&&&&DocumentResult&&&&&false&&&&&&&&&&').toString('base64');
  const viewerUrl = `https://www.scconline.com/Members/DocumentResult.aspx?enc=${enc}`;

  const page = await context.newPage();

  try {
    // Log all network requests to find the PDF endpoint
    let pdfBuf = null;
    const seenUrls = [];

    page.on('response', async (response) => {
      try {
        const url = response.url();
        const ct  = response.headers()['content-type'] || '';
        seenUrls.push({ url, ct, status: response.status() });

        if (ct.includes('pdf') || url.includes('.pdf') || url.includes('DownloadFile') || url.includes('GetPdf') || url.includes('ViewPdf') || url.includes('ShowPdf')) {
          const buf = await response.body();
          if (buf && buf.length > 500 && buf[0] === 0x25 && buf[1] === 0x50) {
            pdfBuf = buf;
            console.log(`\n  [pdf found] ${url} (${buf.length} bytes)`);
          }
        }
      } catch (_) {}
    });

    console.log(`\n  [trying] ${title.slice(0,60)} [${doi}]`);
    try {
      await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.log(`  [nav warn] ${e.message}`);
    }

    // Wait for PDF to load (poll for up to 15s)
    for (let i = 0; i < 15; i++) {
      if (pdfBuf) break;
      await sleep(1000);
    }

    if (!pdfBuf) {
      console.log(`  [no pdf intercepted] dumping last 30 URLs the page requested:`);
      seenUrls.slice(-30).forEach(r => console.log(`    [${r.status}] ${r.ct.slice(0,30).padEnd(30)} ${r.url.slice(0,120)}`));
    }

    if (pdfBuf) {
      fs.writeFileSync(outPath, pdfBuf);
      progress[doi] = 'done';
      saveProgress();
      dlCount++;
      process.stdout.write(`\r  ✓ ${dlCount}/${total}  skip:${skipCount}  fail:${failCount}   `);
      await sleep(DL_DELAY);
      await page.close();
      return;
    }

    // PDF not intercepted via network — try triggering a download via the page's own print/download button
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        page.evaluate(() => {
          // Try common download button selectors SCC uses
          const btn = document.querySelector('#btnDownload, #lnkDownload, .download-btn, [onclick*="download"], [onclick*="Download"], [href*="DownloadFile"]');
          if (btn) btn.click();
        }),
      ]);
      const tmpPath = await download.path();
      if (tmpPath) {
        const buf = fs.readFileSync(tmpPath);
        if (buf.length > 500 && buf[0] === 0x25 && buf[1] === 0x50) {
          fs.copyFileSync(tmpPath, outPath);
          progress[doi] = 'done';
          saveProgress();
          dlCount++;
          process.stdout.write(`\r  ✓ ${dlCount}/${total}  skip:${skipCount}  fail:${failCount}   `);
          await sleep(DL_DELAY);
          await page.close();
          return;
        }
      }
    } catch (_) {}

  } catch (e) {
    console.log(`\n  [err] ${title}: ${e.message}`);
  } finally {
    await page.close().catch(() => {});
  }

  // All strategies failed (retries disabled for debug)

  progress[doi] = 'failed';
  saveProgress();
  failCount++;
  console.log(`\n  ✗ FAILED: ${title} [${doi}]`);
}

// ─────────────────────────────────────────────
// Concurrency pool (same as original)
// ─────────────────────────────────────────────
const runPool = async (tasks, limit) => {
  const q = [...tasks];
  await Promise.all(Array(limit).fill(0).map(async () => {
    while (q.length) await q.shift()();
  }));
};

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log(`║  SCC Downloader (Playwright)                 ║`);
  console.log(`║  Section: ${SECTION.slice(0,36).padEnd(36)} ║`);
  console.log('╚══════════════════════════════════════════════╝\n');

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await buildContext(browser);

  // Navigate to SCC browse page so session is active
  const apiPage = await context.newPage();
  await apiPage.goto('https://www.scconline.com/Members/BrowseResult.aspx', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });



  // Validate API
  process.stdout.write('Testing API... ');
  let rootNodes;
  try {
    const r = await callTree(apiPage, { ...basePayload(), QueryText: '*:*', SearchField: 'Node1' });
    rootNodes = r?.[0]?.children || [];
    if (!rootNodes.length) throw new Error('0 subsections returned');
    console.log(`✓  (${rootNodes.length} subsections found)\n`);
  } catch(e) {
    console.log(`✗  ${e.message}`);
    console.log(`Delete ${SESSION_FILE} and re-run to log in again.\n`);
    await browser.close();
    process.exit(1);
  }

  if (fs.existsSync(PROGRESS_FILE))
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));

  // ── Phase 1: Discovery ──────────────────────
  let allDocs = [];

  if (fs.existsSync(DOCS_FILE)) {
    allDocs = JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8'));
    console.log(`Discovery already done: ${allDocs.length} docs loaded from ${DOCS_FILE}`);
    console.log(`Delete ${DOCS_FILE} to re-scan\n`);
  } else {
    console.log(`PHASE 1 — DISCOVERY (${rootNodes.length} subsections to scan)\n`);

    for (let i = 0; i < rootNodes.length; i++) {
      const node  = rootNodes[i];
      const title = node.title || (node.key||'').split('$Break$')[0];
      process.stdout.write(`[${String(i+1).padStart(2)}/${rootNodes.length}] ${title.slice(0,52).padEnd(53)}`);
      const before = allDocs.length;
      await traverse(apiPage, node, [SECTION], allDocs);
      console.log(`  +${allDocs.length - before} docs  (total: ${allDocs.length})`);
    }

    fs.writeFileSync(DOCS_FILE, JSON.stringify(allDocs, null, 2));
    console.log(`\n✓ Discovery done: ${allDocs.length} documents saved to ${DOCS_FILE}\n`);
  }

  await apiPage.close();

  if (!allDocs.length) {
    console.log('No documents found — check session.\n');
    await browser.close();
    process.exit(1);
  }

  // ── Phase 2: Download ───────────────────────
  const remaining = allDocs.filter(d => progress[d.doi] !== 'done').length;
  console.log('PHASE 2 — DOWNLOAD');
  console.log(`  Total     : ${allDocs.length}`);
  console.log(`  Done      : ${allDocs.length - remaining}`);
  console.log(`  Remaining : ${remaining}`);
  console.log(`  Saving to : ${path.resolve(DOWNLOAD_DIR)}`);
  console.log('\n  Ctrl+C anytime — progress saved, restart to resume\n');

  const testDocs = allDocs.slice(0, 2);
  console.log(`  TEST MODE: only downloading first ${testDocs.length} docs (concurrency=1 for debug)\n`);
  await runPool(
    testDocs.map(d => () => downloadOne(context, d.doi, d.title, testDocs.length)),
    1
  );

  await browser.close();

  console.log('\n\n╔══════════════════════════════════════════════╗');
  console.log('║  Done!                                       ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Downloaded : ${String(dlCount).padEnd(30)}║`);
  console.log(`║  Skipped    : ${String(skipCount).padEnd(30)}║`);
  console.log(`║  Failed     : ${String(failCount).padEnd(30)}║`);
  console.log(`║  Folder     : ${String(DOWNLOAD_DIR).padEnd(30)}║`);
  console.log('╚══════════════════════════════════════════════╝\n');

  if (failCount) console.log('Re-run to retry failed files.\n');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });

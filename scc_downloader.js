#!/usr/bin/env node
/**
 * SCC Online - PDF Downloader
 * Run: node scc_downloader.js
 *
 * WHEN COOKIES EXPIRE — update the values below:
 *   1. Chrome → https://christuniversity.knimbus.com/portal/v2/default/login → login
 *   2. Go to https://www-scconline-com-christuniversity.knimbus.com/
 *   3. F12 → Application → Cookies
 *   4. From christuniversity.knimbus.com  → update KNIMBUS_COOKIES
 *   5. From www.scconline.com             → update SCC_COOKIES
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ══════════════════════════════════════════════
//  KNIMBUS COOKIES
//  (from christuniversity.knimbus.com)
// ══════════════════════════════════════════════
const KNIMBUS_COOKIES = {
  'GCLB':    '"64749ff27da9f435"',
  'orgId':   'org_8f936991-709f-4c4c-9a49-90643639d008',
  '_vid_t':  '1suVOBgipsQCg2tfHA1TojQ0o1HDa5K7ARTMScHD6RTo6pYHxzgt6Xp2WQyxoqGsjY81Q6QTdoqLSA==',
  'crisp-client%2Fsession%2F8192fee3-0870-42b7-b06d-f3df8fd5cb2f': 'session_1a4d5d50-7d8d-4125-9cf2-649c20180ea5',
};

// ══════════════════════════════════════════════
//  SCC COOKIES
//  (from www.scconline.com)
// ══════════════════════════════════════════════
const SCC_COOKIES = {
  'ASP.NET_SessionId': 'pvmey4epuq2q3bg0gpo3nffb',
  
  '.ASPXAUTH':         '6A14EDA1332E74F86F024F10DA0D71EA63AD812CD4F8BD6D7E53CE116FEAAD3B6F5B2881AFF191229949A2DA7B330A57FA5D68E7E31FF73BA38A7EBCDB967310E3C97E86CB5A06656D92EA4E5E64E5397C6A2B55C2FE327E7D35BA87973C600E0726B757666CA57D3842AFB7414D74C9B37EC643B387EEC58D24B289E229B1BF2191FE5234387E15C7E21F9A1173005454B29D49F1DF41CC69E1E256F4293070C61811A7',
  'ASLBSA':            '0003a4a84a3be7c57a567bc0c08d9ec2ab0ebf0139f2410152ee29e897974b273e79',
  'ASLBSACORS':        '0003a4a84a3be7c57a567bc0c08d9ec2ab0ebf0139f2410152ee29e897974b273e79',
  'SearchType':        'MootCourtResourceMaterials',
  'AddonAfterUpgrade': 'NoAddOn',
};

// ══════════════════════════════════════════════
//  SECTION TO DOWNLOAD TODAY
// ══════════════════════════════════════════════
const SECTION = 'Moot Court Resource Materials';
// Change this each day:
// 'Browse Law Reports'
// 'Browse Judgments'
// 'Browse Legislation'
// 'Browse Articles & Short Pieces'
// 'Browse Secondary Material'
// 'Browse Treaties, Conventions, and Instruments'

const DOWNLOAD_DIR   = './SCC_Downloads';
const PROGRESS_FILE  = `./progress_${SECTION.replace(/[^a-z0-9]/gi,'_')}.json`;
const DOCS_FILE      = `./docs_${SECTION.replace(/[^a-z0-9]/gi,'_')}.json`;
const SELECTED_COURT = '00000111111101011111011111111111110101111111111111111111111111111100111111111111111111111111111111111111111111111111111101111111111111111111111101111111111101111111111111111111111111111111111111111111111111011111111110011111101111011111101011111111';
const API_DELAY      = 350;
const DL_DELAY       = 700;
const CONCURRENCY    = 3;

// ─────────────────────────────────────────────
// Live cookie jar — merges all cookies, gets
// updated automatically from server responses
// ─────────────────────────────────────────────
let jar = { ...KNIMBUS_COOKIES, ...SCC_COOKIES };

const cookieStr = () => Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ');
const sleep     = ms => new Promise(r => setTimeout(r, ms));
const sanitize  = s  => (s||'unnamed').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().slice(0,150);

function absorbCookies(headers) {
  const raw = headers['set-cookie'] || [];
  for (const line of (Array.isArray(raw) ? raw : [raw])) {
    const part = line.split(';')[0].trim();
    const eq   = part.indexOf('=');
    if (eq > 0) jar[part.slice(0,eq).trim()] = part.slice(eq+1).trim();
  }
}

// ─────────────────────────────────────────────
// HTTP — follows redirects, absorbs cookies
// ─────────────────────────────────────────────
function req(hostname, urlPath, method, bodyObj, extraHeaders) {
  return new Promise((resolve, reject) => {
    const body    = bodyObj ? JSON.stringify(bodyObj) : null;
    const options = {
      hostname,
      path: urlPath,
      method: method || 'GET',
      headers: {
        'Cookie':     cookieStr(),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36',
        'Accept':     'text/html,application/json,*/*',
        ...(body ? {
          'Content-Type':    'application/json; charset=UTF-8',
          'Origin':          `https://${hostname}`,
          'X-Requested-With':'XMLHttpRequest',
          'Referer':         `https://${hostname}/`,
        } : {}),
        ...(extraHeaders || {}),
      },
    };

    const r = https.request(options, res => {
      absorbCookies(res.headers);

      // Follow redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let loc = res.headers.location;
        let nextHost = hostname, nextPath = loc;
        if (loc.startsWith('http')) {
          const u = new URL(loc);
          nextHost = u.hostname;
          nextPath  = u.pathname + u.search;
        }
        return req(nextHost, nextPath, 'GET', null, extraHeaders).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        buf:    Buffer.concat(chunks),
        text:   () => Buffer.concat(chunks).toString('utf8'),
      }));
    });

    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ─────────────────────────────────────────────
// Session handshake: Knimbus → Proxy → SCC
// ─────────────────────────────────────────────
async function handshake() {
  console.log('Establishing session...');

  process.stdout.write('  [1/3] Knimbus... ');
  try {
    const r = await req('christuniversity.knimbus.com', '/', 'GET');
    console.log(`✓ (${r.status})`);
  } catch(e) { console.log(`skipped (${e.message})`); }

  process.stdout.write('  [2/3] Knimbus → SCC proxy... ');
  try {
    const r = await req('www-scconline-com-christuniversity.knimbus.com', '/', 'GET', null, {
      'Referer': 'https://christuniversity.knimbus.com/',
    });
    console.log(`✓ (${r.status})`);
  } catch(e) { console.log(`skipped (${e.message})`); }

  process.stdout.write('  [3/3] SCC session... ');
  try {
    const r = await req('www.scconline.com', '/Members/BrowseResult.aspx', 'GET', null, {
      'Referer': 'https://www-scconline-com-christuniversity.knimbus.com/',
    });
    const ok = r.status === 200 && !r.text().toLowerCase().includes('login');
    console.log(ok ? '✓ logged in' : `status ${r.status}`);
  } catch(e) { console.log(`skipped (${e.message})`); }

  console.log();
}

// ─────────────────────────────────────────────
// Tree API
// ─────────────────────────────────────────────
const basePayload = () => ({
  ReturnOnExit: false, RequiredRows: 500,
  SelectedCourt: SELECTED_COURT, HighlightTree: true,
  IsIclrContent: false, IsJudiciaryPackage: false, SearchText: '',
  IsMootCourtAccessible: 'true', CountryName: 'singapore',
  SearchType: SECTION, IsBrowseBySearch: false,
  UserSubscribedAddonList: ['NoAddOn'],
});

async function callTree(details) {
  await sleep(API_DELAY);
  const r = await req(
    'www.scconline.com',
    '/Searcher.svc/SearchBrowseTree',
    'POST',
    { searchDetails: details },
    { 'Referer': 'https://www.scconline.com/Members/BrowseResult.aspx' }
  );
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const json = JSON.parse(r.buf.toString());
  if (json.d === undefined) throw new Error('Session expired');
  return json.d || [];
}

// ─────────────────────────────────────────────
// Recursive discovery
// ─────────────────────────────────────────────
async function traverse(node, ancestors, docs) {
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
      const r = await callTree({
        ...basePayload(),
        QueryText: qParts.join(' AND '),
        SearchField: childLevel,
        QueryType: title,
        parentNode: parentLevel,
        HasChildren: true,
      });
      children = r?.[0]?.children || [];
    } catch(e) {
      if (e.message.includes('expired')) {
        console.log('\n  Session expired mid-crawl — re-handshaking...');
        await handshake();
        try {
          const r2 = await callTree({
            ...basePayload(),
            QueryText: qParts.join(' AND '),
            SearchField: childLevel,
            QueryType: title,
            parentNode: parentLevel,
            HasChildren: true,
          });
          children = r2?.[0]?.children || [];
        } catch(e2) {
          console.log(`  ✗ Retry failed for "${title}": ${e2.message}`);
          return;
        }
      } else {
        console.log(`\n  ✗ Failed "${title}": ${e.message}`);
        return;
      }
    }
  }

  for (const child of children) {
    await traverse(child, [...ancestors, title], docs);
  }
}

// ─────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────
let progress = {};
let dlCount = 0, skipCount = 0, failCount = 0;
const saveProgress = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));

async function downloadOne(doi, title, total, retry = 0) {
  if (progress[doi] === 'done') { skipCount++; return; }

  const fname   = sanitize(title) + '__' + doi.replace(/[^a-zA-Z0-9\-]/g,'_') + '.pdf';
  const outPath = path.join(DOWNLOAD_DIR, fname);

  for (const ep of [
    `/Members/DownloadFile.aspx?fileType=pdf&doi=${doi}`,
    `/Members/DownloadFile.aspx?doi=${doi}&fileType=pdf`,
    `/DocumentLink/${doi}`,
  ]) {
    try {
      const r   = await req('www.scconline.com', ep, 'GET', null, {
        'Referer': 'https://www.scconline.com/Members/BrowseResult.aspx',
        'Accept':  'application/pdf,*/*',
      });
      const buf = r.buf;
      const isPDF   = buf[0]===0x25 && buf[1]===0x50;
      const notHTML = !buf.slice(0,100).toString().toLowerCase().includes('<html');
      if (buf.length > 500 && (isPDF || notHTML)) {
        fs.writeFileSync(outPath, buf);
        progress[doi] = 'done';
        saveProgress();
        dlCount++;
        process.stdout.write(`\r  ✓ ${dlCount}/${total}  skip:${skipCount}  fail:${failCount}   `);
        await sleep(DL_DELAY);
        return;
      }
    } catch(_) {}
  }

  if (retry < 3) { await sleep(4000*(retry+1)); return downloadOne(doi,title,total,retry+1); }
  progress[doi] = 'failed';
  saveProgress();
  failCount++;
  console.log(`\n  ✗ FAILED: ${title} [${doi}]`);
}

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
  console.log(`║  SCC Downloader                              ║`);
  console.log(`║  Section: ${SECTION.slice(0,36).padEnd(36)} ║`);
  console.log('╚══════════════════════════════════════════════╝\n');

  // Full session handshake first
  await handshake();

  // Validate API works
  process.stdout.write('Testing API... ');
  let rootNodes;
  try {
    const r = await callTree({ ...basePayload(), QueryText:'*:*', SearchField:'Node1' });
    rootNodes = r?.[0]?.children || [];
    if (!rootNodes.length) throw new Error('0 subsections returned');
    console.log(`✓  (${rootNodes.length} subsections found)\n`);
  } catch(e) {
    console.log(`✗  ${e.message}\n`);
    console.log('COOKIES EXPIRED. To refresh:');
    console.log('  1. Chrome → https://christuniversity.knimbus.com/portal/v2/default/login → login');
    console.log('  2. Go to https://www-scconline-com-christuniversity.knimbus.com/');
    console.log('  3. F12 → Application → Cookies');
    console.log('  4. Copy from christuniversity.knimbus.com → paste into KNIMBUS_COOKIES');
    console.log('  5. Copy from www.scconline.com → paste into SCC_COOKIES\n');
    process.exit(1);
  }

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  if (fs.existsSync(PROGRESS_FILE))
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE,'utf8'));

  // ── Phase 1: Discovery ──────────────────────
  let allDocs = [];

  if (fs.existsSync(DOCS_FILE)) {
    allDocs = JSON.parse(fs.readFileSync(DOCS_FILE,'utf8'));
    console.log(`Discovery already done: ${allDocs.length} docs loaded from ${DOCS_FILE}`);
    console.log(`Delete ${DOCS_FILE} to re-scan\n`);
  } else {
    console.log(`PHASE 1 — DISCOVERY (${rootNodes.length} subsections to scan)\n`);

    for (let i = 0; i < rootNodes.length; i++) {
      const node  = rootNodes[i];
      const title = node.title || (node.key||'').split('$Break$')[0];
      process.stdout.write(`[${String(i+1).padStart(2)}/${rootNodes.length}] ${title.slice(0,52).padEnd(53)}`);
      const before = allDocs.length;
      await traverse(node, [SECTION], allDocs);
      console.log(`  +${allDocs.length - before} docs  (total: ${allDocs.length})`);
    }

    fs.writeFileSync(DOCS_FILE, JSON.stringify(allDocs, null, 2));
    console.log(`\n✓ Discovery done: ${allDocs.length} documents saved to ${DOCS_FILE}\n`);
  }

  if (!allDocs.length) {
    console.log('No documents found — check cookies.\n');
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

  await runPool(
    allDocs.map(d => () => downloadOne(d.doi, d.title, allDocs.length)),
    CONCURRENCY
  );

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
// brutal.js
// Upload folder ke banyak repo GitHub
// Fitur: custom nama, jumlah repo, concurrency, delay, safe mode, private, anti rate limit

const https = require('https');
const fs = require('fs');
const path = require('path');

// === baca argumen ===
const args = process.argv.slice(2);
let token = '';
let baseName = 'repo';
let count = 1;
let concurrency = 5;
let delay = 1000;
let folder = '.';
let isPrivate = false;
let safeMode = false;
let fileDelay = 200;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1];
  if (a === '--token' && v) { token = v; i++; }
  else if (a === '--name' && v) { baseName = v; i++; }
  else if (a === '--count' && v) { count = parseInt(v) || 1; i++; }
  else if (a === '--concurrency' && v) { concurrency = parseInt(v) || 5; i++; }
  else if (a === '--delay' && v) { delay = parseInt(v) || 1000; i++; }
  else if (a === '--folder' && v) { folder = v; i++; }
  else if (a === '--private') { isPrivate = true; }
  else if (a === '--safe') { safeMode = true; }
  else if (a === '--filedelay' && v) { fileDelay = parseInt(v) || 200; i++; }
  else if (a === '--brutal') { concurrency = 10; delay = 0; safeMode = false; fileDelay = 0; }
}

if (!token) {
  console.log('Usage: node brutal.js --token <ghp_xxx> [--name repo] [--count 5] [--concurrency 5] [--delay 1000] [--folder ./dir] [--private] [--safe] [--brutal]');
  process.exit(1);
}

// === warna simpel ===
const c = { reset: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', d: '\x1b[90m' };

// === fungsi request GitHub dengan auto retry & rate limit handling ===
async function gh(method, endpoint, body = null) {
  let attempt = 0;
  while (true) {
    try {
      const result = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'api.github.com',
          path: endpoint,
          method,
          headers: {
            'Authorization': `token ${token}`,
            'User-Agent': 'brutal-upload',
            'Content-Type': 'application/json',
          },
        };
        const req = https.request(opts, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try { resolve(JSON.parse(data)); } catch { resolve(data); }
            } else {
              const retryAfter = parseInt(res.headers['retry-after'] || '10', 10) * 1000;
              reject({ code: res.statusCode, msg: data, retryAfter });
            }
          });
        });
        req.on('error', e => reject({ code: 0, msg: e.message, retryAfter: 10000 }));
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
      return result;
    } catch (err) {
      attempt++;
      if ((err.code === 403 || err.code === 429 || err.code >= 500) && attempt <= 5) {
        const wait = err.retryAfter || (5000 * attempt);
        console.log(`${c.y}Rate limit, nunggu ${wait/1000}s...${c.reset}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw new Error(err.msg || 'Gagal');
    }
  }
}

// === dapatkan semua file (rekursif, skip .git, node_modules, file ini) ===
function getAllFiles(dir, ignorePaths) {
  const ignore = new Set(ignorePaths);
  const results = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, item.name);
    if (ignore.has(fp)) continue;
    if (item.isDirectory()) {
      if (item.name === '.git' || item.name === 'node_modules') continue;
      results.push(...getAllFiles(fp, ignorePaths));
    } else {
      results.push(fp);
    }
  }
  return results;
}

function randomSuffix() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789.-~';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return '.' + s;
}

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

// === progress bar sederhana ===
function progress(current, total, startTime) {
  const pct = ((current / total) * 100).toFixed(0);
  const barLen = 25;
  const filled = Math.round((current / total) * barLen);
  const empty = barLen - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(`\r  [${bar}] ${pct}% (${current}/${total}) ${elapsed}s`);
}

// === upload file ke repo ===
async function uploadFiles(owner, repo, branch, files, baseDir) {
  if (safeMode) {
    // sequential upload
    for (const absPath of files) {
      const rel = path.relative(baseDir, absPath).replace(/\\/g, '/');
      const content = await fs.promises.readFile(absPath);
      const b64 = content.toString('base64');
      await gh('PUT', `/repos/${owner}/${repo}/contents/${rel}`, {
        message: `Add ${rel}`,
        content: b64,
        branch,
      });
      if (fileDelay) await new Promise(r => setTimeout(r, fileDelay));
    }
  } else {
    // parallel upload
    const tasks = files.map(async absPath => {
      const rel = path.relative(baseDir, absPath).replace(/\\/g, '/');
      const content = await fs.promises.readFile(absPath);
      const b64 = content.toString('base64');
      return gh('PUT', `/repos/${owner}/${repo}/contents/${rel}`, {
        message: `Add ${rel}`,
        content: b64,
        branch,
      });
    });
    await Promise.all(tasks);
  }
}

// === buat satu repo & upload ===
async function createRepo(owner, files, baseDir, repoIndex) {
  let repoName = baseName + randomSuffix();
  let repo;
  try {
    repo = await gh('POST', '/user/repos', {
      name: repoName,
      private: isPrivate,
      auto_init: true,
    });
  } catch (e) {
    if (e.message.includes('422') || e.message.includes('already exists')) {
      repoName = baseName + randomSuffix();
      repo = await gh('POST', '/user/repos', {
        name: repoName,
        private: isPrivate,
        auto_init: true,
      });
    } else {
      throw e;
    }
  }
  if (files.length > 0) {
    await uploadFiles(owner, repo.name, repo.default_branch, files, baseDir);
  }
  return repo.html_url;
}

// ==================== MAIN ====================
(async () => {
  console.log(`${c.c}Login ke GitHub...${c.reset}`);
  const user = await gh('GET', '/user');
  const owner = user.login;
  console.log(`${c.g}Akun: ${owner}${c.reset}`);

  const scriptPath = __filename;
  const filePaths = getAllFiles(folder, [scriptPath]);
  const totalSize = filePaths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
  console.log(`File : ${filePaths.length} (${fmtSize(totalSize)})`);
  console.log(`Repo : ${count} | ${isPrivate ? 'Private' : 'Public'}${safeMode ? ' | Safe mode' : ''}`);
  console.log(`Mode : ${concurrency} parallel, delay ${delay}ms\n`);

  const startTotal = Date.now();
  let done = 0;
  let success = 0;
  let failed = 0;
  const repos = [];

  // worker pool
  const queue = Array.from({ length: count }, (_, i) => i + 1);
  const runWorker = async () => {
    while (queue.length > 0) {
      const idx = queue.shift();
      try {
        const repoUrl = await createRepo(owner, filePaths, folder, idx);
        done++;
        success++;
        progress(done, count, startTotal);
        repos.push(repoUrl);
        if (delay > 0 && done < count) await new Promise(r => setTimeout(r, delay));
      } catch (e) {
        done++;
        failed++;
        progress(done, count, startTotal);
        console.log(`\n${c.r}Gagal: ${e.message}${c.reset}`);
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
      }
    }
  };

  const workers = [];
  const maxWorkers = Math.min(concurrency, count);
  for (let i = 0; i < maxWorkers; i++) workers.push(runWorker());
  await Promise.all(workers);

  // final
  process.stdout.write('\r' + ' '.repeat(60) + '\r'); // clear bar
  const totalTime = ((Date.now() - startTotal) / 1000).toFixed(1);
  console.log(`\n${c.g}Selesai dalam ${totalTime}s${c.reset}`);
  console.log(`Berhasil: ${success} repo`);
  if (failed > 0) console.log(`${c.r}Gagal: ${failed} repo${c.reset}`);
  if (repos.length > 0) {
    console.log(`\nDaftar repo:`);
    repos.forEach((url, i) => console.log(`  ${i+1}. ${url}`));
  }
})();
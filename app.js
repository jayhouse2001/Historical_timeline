'use strict';

// ============================================================
// 상수
// ============================================================
const ROW_HEIGHT = 36;
const STORAGE_KEY = 'ht_state_xml_v1';
const RUNTIME_KEY = 'ht_runtime_v1';

const SEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<timeline start="-3000" end="2100">
  <regions>
    <region id="r_asia" name="아시아"/>
  </regions>
  <countries>
    <country id="c_kr" region="r_asia" name="한국"/>
  </countries>
  <entries>
    <entry id="e_demo" name="(예시) 불러오기 버튼으로 data.xml 로드" start="0" end="2100" countries="c_kr" color="#fde68a"/>
  </entries>
  <events/>
</timeline>`;

const COLOR_PALETTE = [
  '#fde68a','#a7f3d0','#bfdbfe','#fbcfe8','#ddd6fe',
  '#fed7aa','#fecaca','#bae6fd','#bbf7d0','#e9d5ff'
];

// ============================================================
// 상태
// ============================================================
let state = null;
let dirHandle = null;  // FileSystemDirectoryHandle (data 폴더 — data.xml + images 저장용)

// ============================================================
// IndexedDB (파일 핸들 영속화)
// ============================================================
function idbOp(mode, fn) {
  return new Promise((resolve) => {
    const req = indexedDB.open('ht_handles', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('h');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('h', mode);
      const store = tx.objectStore('h');
      const r = fn(store);
      tx.oncomplete = () => resolve(r && 'result' in r ? r.result : null);
      tx.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}
const idbGet = k => idbOp('readonly',  s => s.get(k));
const idbSet = (k, v) => idbOp('readwrite', s => s.put(v, k));
const idbDel = k => idbOp('readwrite', s => s.delete(k));

// ============================================================
// File System Access (data 폴더 직접 저장 — data.xml + images/)
// ============================================================
async function connectDir() {
  if (!('showDirectoryPicker' in window)) {
    alert('이 브라우저는 직접 폴더 저장을 지원하지 않습니다.\n"내보내기" 버튼으로 다운로드한 뒤 수동으로 덮어쓰세요.\n(Chrome / Edge 권장)');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') { alert('쓰기 권한이 거부되었습니다.'); return; }
    dirHandle = handle;
    await idbSet('dirHandle', handle);
    await idbDel('fileHandle'); // 옛 파일 핸들 정리
    updateFileStatus();
    if (state) await writeFile(true);
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  }
}

async function disconnectDir() {
  dirHandle = null;
  await idbDel('dirHandle');
  updateFileStatus();
}

async function restoreDirHandle() {
  if (!('showDirectoryPicker' in window)) { updateFileStatus(); return; }
  try {
    const stored = await idbGet('dirHandle');
    if (!stored) { updateFileStatus(); return; }
    const perm = await stored.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') dirHandle = stored;
    // 'prompt' 상태면 폴더 연결 버튼 클릭으로 복구
  } catch (_) {}
  updateFileStatus();
}

async function writeFile(notify = false) {
  if (!dirHandle) return false;
  try {
    const fh = await dirHandle.getFileHandle('data.xml', { create: true });
    const w = await fh.createWritable();
    await w.write(serializeXml(state));
    await w.close();
    if (notify) flashStatus('✓ 저장됨');
    return true;
  } catch (e) {
    console.warn('파일 쓰기 실패:', e);
    dirHandle = null;
    await idbDel('dirHandle');
    updateFileStatus();
    flashStatus('✗ 저장 실패 — 다시 연결 필요');
    return false;
  }
}

async function writeImageToDir(file, filename) {
  if (!dirHandle) throw new Error('폴더 미연결');
  let imagesDir;
  try {
    imagesDir = await dirHandle.getDirectoryHandle('images', { create: true });
  } catch (e) {
    throw new Error('images 폴더 생성 실패: ' + e.message);
  }
  const fh = await imagesDir.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(file);
  await w.close();
}

function updateFileStatus() {
  const btn = document.getElementById('btn-file-connect');
  if (!btn) return;
  if (dirHandle) {
    btn.textContent = '✓ ' + dirHandle.name + '/';
    btn.classList.add('connected');
    btn.title = `${dirHandle.name}/ 폴더 — 편집 시 data.xml + 이미지 자동 저장 (클릭하면 해제)`;
  } else {
    btn.textContent = '📁 폴더 연결';
    btn.classList.remove('connected');
    btn.title = 'data 폴더에 직접 저장하려면 폴더 연결';
  }
}

let _flashTimer;
function flashStatus(text) {
  const btn = document.getElementById('btn-file-connect');
  if (!btn) return;
  btn.textContent = text;
  clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => updateFileStatus(), 1500);
}

// ============================================================
// GitHub 자동 커밋 (브라우저 → GitHub API → repo)
// ============================================================
const GITHUB_KEY = 'ht_github_v1';
let githubConfig = null;   // { owner, repo, branch, path, token }
let lastSha = null;
let _ghTimer = null;
let _ghFlashTimer = null;

function loadGithubConfig() {
  try {
    const raw = localStorage.getItem(GITHUB_KEY);
    if (raw) githubConfig = JSON.parse(raw);
  } catch (_) {}
  updateGithubStatus();
}

function saveGithubConfig(cfg) {
  if (cfg) localStorage.setItem(GITHUB_KEY, JSON.stringify(cfg));
  else localStorage.removeItem(GITHUB_KEY);
  githubConfig = cfg;
  lastSha = null;
  updateGithubStatus();
}

function updateGithubStatus() {
  const btn = document.getElementById('btn-github');
  if (!btn) return;
  if (githubConfig) {
    btn.textContent = `📤 ${githubConfig.owner}/${githubConfig.repo}`;
    btn.classList.add('connected');
    btn.title = `${githubConfig.owner}/${githubConfig.repo}:${githubConfig.branch} ${githubConfig.path} — 자동 커밋 (클릭하면 설정)`;
  } else {
    btn.textContent = '📤 GitHub';
    btn.classList.remove('connected');
    btn.title = 'GitHub 자동 커밋 설정';
  }
}

function flashGhStatus(text, ms = 2000) {
  const btn = document.getElementById('btn-github');
  if (!btn) return;
  btn.textContent = text;
  clearTimeout(_ghFlashTimer);
  _ghFlashTimer = setTimeout(() => updateGithubStatus(), ms);
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${githubConfig.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function ghPathUrl() {
  const { owner, repo, path } = githubConfig;
  const enc = path.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${enc}`;
}

async function ghGetSha() {
  if (!githubConfig) return null;
  const res = await fetch(`${ghPathUrl()}?ref=${encodeURIComponent(githubConfig.branch)}`, {
    headers: ghHeaders(), cache: 'no-store'
  });
  if (res.status === 404) return null; // 새 파일
  if (!res.ok) throw new Error('GET ' + res.status + ': ' + (await res.text()));
  const j = await res.json();
  return j.sha;
}

function utf8ToBase64(s) {
  return btoa(unescape(encodeURIComponent(s)));
}

// repo 안의 data 폴더 경로 (data.xml의 부모 디렉토리)
function ghDataDirInRepo() {
  const p = githubConfig?.path || 'data/data.xml';
  return p.replace(/[^/]+$/, ''); // 'X/data/data.xml' → 'X/data/'
}

// 임의 파일 업로드 (이미지 등). returnedPath = repo 안 경로
async function ghPutFile(repoPath, base64Content, message) {
  if (!githubConfig) throw new Error('GitHub 미연결');
  const enc = repoPath.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${encodeURIComponent(githubConfig.owner)}/${encodeURIComponent(githubConfig.repo)}/contents/${enc}`;

  // 기존 파일 SHA 조회 (있으면 덮어쓰기, 없으면 신규)
  let sha = null;
  try {
    const r = await fetch(`${url}?ref=${encodeURIComponent(githubConfig.branch)}`, {
      headers: ghHeaders(), cache: 'no-store'
    });
    if (r.ok) sha = (await r.json()).sha;
  } catch (_) {}

  const body = {
    message: message || `Upload ${repoPath}`,
    content: base64Content,
    branch: githubConfig.branch
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`PUT ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return repoPath;
}

function arrayBufferToBase64(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// 세션 동안 업로드한 파일을 path → blob URL로 매핑 (Pages 재빌드 전에도 즉시 미리보기)
const imageBlobs = new Map();

function resolveImage(path) {
  if (!path) return '';
  return imageBlobs.get(path) || path;
}

// 이미지 파일 삭제 (로컬 폴더 + GitHub repo 양쪽에서)
async function deleteImageFile(imagePath) {
  if (!imagePath) return;
  if (imagePath.startsWith('data:') || /^https?:\/\//.test(imagePath)) return; // 외부/인라인은 건드릴 수 없음
  const parts = imagePath.split('/');
  const filename = parts[parts.length - 1];
  if (!filename) return;

  if (dirHandle) {
    try {
      const imagesDir = await dirHandle.getDirectoryHandle('images');
      await imagesDir.removeEntry(filename);
    } catch (e) { console.warn('로컬 이미지 삭제 실패:', e); }
  }
  if (githubConfig) {
    try {
      await ghDeleteFile(`${ghDataDirInRepo()}images/${filename}`, `Delete image ${filename}`);
    } catch (e) { console.warn('GitHub 이미지 삭제 실패:', e); }
  }
  if (imageBlobs.has(imagePath)) {
    URL.revokeObjectURL(imageBlobs.get(imagePath));
    imageBlobs.delete(imagePath);
  }
}

async function ghDeleteFile(repoPath, message) {
  if (!githubConfig) return;
  const enc = repoPath.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${encodeURIComponent(githubConfig.owner)}/${encodeURIComponent(githubConfig.repo)}/contents/${enc}`;
  let sha = null;
  try {
    const r = await fetch(`${url}?ref=${encodeURIComponent(githubConfig.branch)}`, { headers: ghHeaders() });
    if (r.ok) sha = (await r.json()).sha;
  } catch (_) {}
  if (!sha) return; // 원격에 파일 없음
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message || `Delete ${repoPath}`, sha, branch: githubConfig.branch })
  });
  if (!res.ok) throw new Error(`DELETE ${res.status}: ${(await res.text()).slice(0, 120)}`);
}

function isImageUsedByOthers(imagePath, currentEntryId) {
  return state.entries.some(e => e.id !== currentEntryId && (e.images || []).includes(imagePath));
}

// 이미지 업로드: data 폴더 연결 시 로컬 저장, GitHub 연결 시 repo에도 업로드
async function uploadImage(file) {
  if (!dirHandle && !githubConfig) {
    throw new Error('폴더 연결 또는 GitHub 연결이 필요합니다 (이미지를 저장할 곳).');
  }
  const safe = file.name.replace(/[^a-zA-Z0-9._\-]/g, '_');
  const ts = Date.now().toString(36);
  const filename = `${ts}_${safe}`;
  const pageRel = `data/images/${filename}`;

  // 둘 다 켜져 있으면 양쪽에 저장
  if (dirHandle) {
    await writeImageToDir(file, filename);
  }
  if (githubConfig) {
    const buf = await file.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    const repoPath = `${ghDataDirInRepo()}images/${filename}`;
    await ghPutFile(repoPath, b64, `Upload image ${filename}`);
  }

  imageBlobs.set(pageRel, URL.createObjectURL(file));
  return pageRel;
}

async function ghCommit() {
  if (!githubConfig) return false;
  const xml = serializeXml(state);
  if (lastSha === null) lastSha = await ghGetSha();

  const body = {
    message: `Update ${githubConfig.path} via web (${new Date().toISOString()})`,
    content: utf8ToBase64(xml),
    branch: githubConfig.branch
  };
  if (lastSha) body.sha = lastSha;

  let res = await fetch(ghPathUrl(), {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  // 충돌 시 한 번 재시도 (다른 기기에서 먼저 커밋한 경우)
  if (res.status === 409 || res.status === 422) {
    lastSha = await ghGetSha();
    if (lastSha) body.sha = lastSha;
    res = await fetch(ghPathUrl(), {
      method: 'PUT',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  if (!res.ok) throw new Error('PUT ' + res.status + ': ' + (await res.text()));
  const j = await res.json();
  lastSha = j.content?.sha || null;
  return true;
}

function ghCommitDebounced() {
  if (!githubConfig) return;
  clearTimeout(_ghTimer);
  flashGhStatus('… 커밋 대기', 5000);
  _ghTimer = setTimeout(async () => {
    flashGhStatus('… 커밋 중', 30000);
    try {
      await ghCommit();
      flashGhStatus('✓ 커밋됨');
    } catch (e) {
      console.error(e);
      flashGhStatus('✗ ' + (e.message || '실패').slice(0, 40), 5000);
    }
  }, 2000);
}

function openGithubModal() {
  const c = githubConfig || {};
  const html = `
    <div style="font-size:12px; color: var(--muted); line-height:1.5;">
      변경 시 GitHub repo의 파일에 자동 커밋합니다 (2초 debounce).<br>
      Personal Access Token은 이 브라우저 localStorage에만 저장됨.<br>
      <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener">Fine-grained PAT 발급</a>:
      이 repo만 선택 → <b>Repository permissions › Contents: Read and write</b>
    </div>
    <div class="row">
      <label>Owner
        <input name="owner" type="text" value="${escAttr(c.owner)}" placeholder="jayhouse" required>
      </label>
      <label>Repo
        <input name="repo" type="text" value="${escAttr(c.repo)}" placeholder="world-history" required>
      </label>
    </div>
    <div class="row">
      <label>브랜치
        <input name="branch" type="text" value="${escAttr(c.branch || 'main')}" required>
      </label>
      <label>파일 경로
        <input name="path" type="text" value="${escAttr(c.path || 'Historical_timeline/data/data.xml')}" placeholder="Historical_timeline/data/data.xml" required>
      </label>
    </div>
    <label>Personal Access Token
      <input name="token" type="password" value="${escAttr(c.token)}" placeholder="github_pat_..." required>
    </label>
  `;
  openModal('GitHub 자동 커밋 설정', html,
    form => {
      const cfg = {
        owner: form.owner.value.trim(),
        repo: form.repo.value.trim(),
        branch: form.branch.value.trim() || 'main',
        path: form.path.value.trim() || 'data.xml',
        token: form.token.value.trim()
      };
      if (!cfg.owner || !cfg.repo || !cfg.token) { alert('Owner / Repo / Token 은 필수입니다.'); return false; }
      saveGithubConfig(cfg);
      flashGhStatus('연결됨');
      return undefined; // 일반 저장 흐름 (persist→render)을 발동하지 않으려면 false 반환해도 OK; 여기선 진행
    },
    githubConfig ? () => { saveGithubConfig(null); } : null
  );
}

function defaultState() {
  return {
    config: { startYear: -3000, endYear: 2100, pixelsPerYear: 1.0, zoom: 1.0, indicatorYear: 0 },
    regions: [], countries: [], entries: [], events: [], eventTracks: [{ id: 'evt_default', name: '' }]
  };
}

function pxPerYear() { return state.config.pixelsPerYear * state.config.zoom; }
function yearToX(y)  { return (y - state.config.startYear) * pxPerYear(); }
function xToYear(x)  { return state.config.startYear + x / pxPerYear(); }
function totalWidth(){ return (state.config.endYear - state.config.startYear) * pxPerYear(); }

function fmtYear(y) {
  const n = Math.round(y);
  if (n === 0) return '0';
  return n < 0 ? `BC ${-n}` : `${n}`;
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
}

// ============================================================
// XML 직렬화 / 파싱
// ============================================================
function escXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML 파싱 오류: ' + err.textContent);

  const tl = doc.querySelector('timeline');
  if (!tl) throw new Error('<timeline> 요소가 없습니다.');

  const startYear = parseInt(tl.getAttribute('start') || '-3000', 10);
  const endYear   = parseInt(tl.getAttribute('end')   || '2100',  10);

  const regions = [...doc.querySelectorAll('regions > region')].map(el => ({
    id: el.getAttribute('id'),
    name: el.getAttribute('name') || ''
  }));
  const countries = [...doc.querySelectorAll('countries > country')].map(el => ({
    id: el.getAttribute('id'),
    regionId: el.getAttribute('region'),
    name: el.getAttribute('name') || ''
  }));
  const entries = [...doc.querySelectorAll('entries > entry')].map(el => ({
    id: el.getAttribute('id'),
    name: el.getAttribute('name') || '',
    startYear: parseInt(el.getAttribute('start'), 10),
    endYear:   parseInt(el.getAttribute('end'),   10),
    countryIds: (el.getAttribute('countries') || '').split(/\s+/).filter(Boolean),
    color: el.getAttribute('color') || '',
    group: el.getAttribute('group') || '',
    description: el.querySelector('description')?.textContent?.trim() || '',
    images: [...el.querySelectorAll('image')].map(im => im.textContent?.trim()).filter(Boolean)
  }));
  let eventTracks = [...doc.querySelectorAll('eventTracks > eventTrack')].map(el => ({
    id: el.getAttribute('id'),
    name: el.getAttribute('name') || ''
  }));
  if (!eventTracks.length) eventTracks = [{ id: 'evt_default', name: '' }];

  const events = [...doc.querySelectorAll('events > event')].map(el => {
    const endAttr = el.getAttribute('end');
    const trackAttr = el.getAttribute('track');
    return {
      id: el.getAttribute('id'),
      trackId: trackAttr && eventTracks.some(t => t.id === trackAttr) ? trackAttr : eventTracks[0].id,
      year: parseInt(el.getAttribute('year'), 10),
      endYear: endAttr != null && endAttr !== '' ? parseInt(endAttr, 10) : null,
      name: el.getAttribute('name') || '',
      description: el.querySelector('description')?.textContent?.trim() || ''
    };
  });

  return {
    config: { startYear, endYear, pixelsPerYear: 1.0, zoom: state?.config?.zoom ?? 1.0, indicatorYear: state?.config?.indicatorYear ?? 0 },
    regions, countries, entries, events, eventTracks
  };
}

function serializeXml(s) {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out += `<timeline start="${s.config.startYear}" end="${s.config.endYear}">\n\n`;

  out += '  <regions>\n';
  for (const r of s.regions) {
    out += `    <region id="${escXml(r.id)}" name="${escXml(r.name)}"/>\n`;
  }
  out += '  </regions>\n\n';

  out += '  <countries>\n';
  for (const c of s.countries) {
    out += `    <country id="${escXml(c.id)}" region="${escXml(c.regionId)}" name="${escXml(c.name)}"/>\n`;
  }
  out += '  </countries>\n\n';

  out += '  <entries>\n';
  for (const e of s.entries) {
    const attrs =
      `id="${escXml(e.id)}" name="${escXml(e.name)}" ` +
      `start="${e.startYear}" end="${e.endYear}" ` +
      `countries="${escXml(e.countryIds.join(' '))}"` +
      (e.color ? ` color="${escXml(e.color)}"` : '') +
      (e.group ? ` group="${escXml(e.group)}"` : '');
    const imgs = (e.images || []).filter(Boolean);
    if (!e.description && imgs.length === 0) {
      out += `    <entry ${attrs}/>\n`;
    } else {
      out += `    <entry ${attrs}>\n`;
      if (e.description) out += `      <description>${escXml(e.description)}</description>\n`;
      for (const img of imgs) out += `      <image>${escXml(img)}</image>\n`;
      out += `    </entry>\n`;
    }
  }
  out += '  </entries>\n\n';

  out += '  <eventTracks>\n';
  for (const t of (s.eventTracks || [])) {
    out += `    <eventTrack id="${escXml(t.id)}"${t.name ? ` name="${escXml(t.name)}"` : ''}/>\n`;
  }
  out += '  </eventTracks>\n\n';

  out += '  <events>\n';
  for (const ev of s.events) {
    let attrs = `id="${escXml(ev.id)}" track="${escXml(ev.trackId || '')}" year="${ev.year}"`;
    if (ev.endYear != null && !isNaN(ev.endYear)) attrs += ` end="${ev.endYear}"`;
    attrs += ` name="${escXml(ev.name)}"`;
    if (ev.description) {
      out += `    <event ${attrs}>\n`;
      out += `      <description>${escXml(ev.description)}</description>\n`;
      out += `    </event>\n`;
    } else {
      out += `    <event ${attrs}/>\n`;
    }
  }
  out += '  </events>\n\n';

  out += '</timeline>\n';
  return out;
}

// ============================================================
// 영속성 (localStorage 캐시)
// ============================================================
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, serializeXml(state));
    persistRuntime();
  } catch (e) { /* quota 등 무시 */ }
  if (dirHandle) writeFile().catch(() => {});
  if (githubConfig) ghCommitDebounced();
}

function persistRuntime() {
  try {
    localStorage.setItem(RUNTIME_KEY, JSON.stringify({
      zoom: state.config.zoom,
      indicatorYear: state.config.indicatorYear,
      viewOrder: state.viewOrder
    }));
  } catch (_) {}
}

function loadRuntime() {
  try {
    const raw = localStorage.getItem(RUNTIME_KEY);
    if (!raw) return;
    const r = JSON.parse(raw);
    if (typeof r.zoom === 'number') state.config.zoom = r.zoom;
    if (typeof r.indicatorYear === 'number') state.config.indicatorYear = r.indicatorYear;
    if (r.viewOrder) state.viewOrder = r.viewOrder;
  } catch (_) {}
}

// ============================================================
// View order (drag reorder, data.xml에 영향 없음)
// ============================================================
function reconcileViewOrder() {
  if (!state.viewOrder) state.viewOrder = { regions: [], countries: {} };
  if (!state.viewOrder.countries) state.viewOrder.countries = {};
  const knownR = new Set(state.regions.map(r => r.id));
  state.viewOrder.regions = (state.viewOrder.regions || []).filter(id => knownR.has(id));
  for (const r of state.regions) {
    if (!state.viewOrder.regions.includes(r.id)) state.viewOrder.regions.push(r.id);
  }
  for (const r of state.regions) {
    const knownC = new Set(state.countries.filter(c => c.regionId === r.id).map(c => c.id));
    if (!Array.isArray(state.viewOrder.countries[r.id])) state.viewOrder.countries[r.id] = [];
    state.viewOrder.countries[r.id] = state.viewOrder.countries[r.id].filter(id => knownC.has(id));
    for (const c of state.countries.filter(c => c.regionId === r.id)) {
      if (!state.viewOrder.countries[r.id].includes(c.id)) state.viewOrder.countries[r.id].push(c.id);
    }
  }
  for (const rId of Object.keys(state.viewOrder.countries)) {
    if (!knownR.has(rId)) delete state.viewOrder.countries[rId];
  }
}

function getOrderedRegions() {
  if (!state.viewOrder?.regions?.length) return state.regions;
  const map = new Map(state.regions.map(r => [r.id, r]));
  return state.viewOrder.regions.map(id => map.get(id)).filter(Boolean);
}

function getOrderedCountries(regionId) {
  const all = state.countries.filter(c => c.regionId === regionId);
  const ord = state.viewOrder?.countries?.[regionId];
  if (!ord?.length) return all;
  const map = new Map(all.map(c => [c.id, c]));
  return ord.map(id => map.get(id)).filter(Boolean);
}

function getCountryGroup(regionId, countryId) {
  const cs = getOrderedCountries(regionId);
  const idx = cs.findIndex(c => c.id === countryId);
  if (idx < 0) return [countryId];
  const base = baseCountryName(cs[idx].name);
  let left = idx, right = idx;
  while (left > 0 && baseCountryName(cs[left - 1].name) === base) left--;
  while (right < cs.length - 1 && baseCountryName(cs[right + 1].name) === base) right++;
  return cs.slice(left, right + 1).map(c => c.id);
}

function reorderRegion(dragId, targetId, isBefore) {
  if (dragId === targetId) return;
  const list = state.viewOrder.regions;
  const cleaned = list.filter(id => id !== dragId);
  const targetIdx = cleaned.indexOf(targetId);
  if (targetIdx < 0) return;
  cleaned.splice(isBefore ? targetIdx : targetIdx + 1, 0, dragId);
  state.viewOrder.regions = cleaned;
}

function reorderCountry(regionId, dragId, targetId, isBefore) {
  const list = state.viewOrder.countries[regionId];
  if (!list) return;
  const dragGroup = getCountryGroup(regionId, dragId);
  const targetGroup = getCountryGroup(regionId, targetId);
  if (dragGroup.includes(targetId)) return;
  const cleaned = list.filter(id => !dragGroup.includes(id));
  const insertIdx = isBefore
    ? cleaned.indexOf(targetGroup[0])
    : cleaned.indexOf(targetGroup[targetGroup.length - 1]) + 1;
  if (insertIdx < 0) return;
  cleaned.splice(insertIdx, 0, ...dragGroup);
  state.viewOrder.countries[regionId] = cleaned;
}

async function loadInitial() {
  // 0) 폴더 연결돼 있으면 그 폴더의 data.xml을 항상 우선 로드 (캐시 무시)
  if (dirHandle) {
    try {
      const fh = await dirHandle.getFileHandle('data.xml');
      const file = await fh.getFile();
      const text = await file.text();
      state = parseXml(text);
      return 'dir';
    } catch (e) { console.warn('dirHandle로 data.xml 읽기 실패:', e); }
  }
  // 1) data.xml fetch (항상 우선 — 캐시 무시)
  try {
    const res = await fetch('data/data.xml?_=' + Date.now(), { cache: 'no-cache' });
    if (res.ok) {
      const text = await res.text();
      state = parseXml(text);
      return 'file';
    }
  } catch (_) { /* file:// 등 */ }
  // 2) fetch 실패 시 localStorage 폴백
  const cached = localStorage.getItem(STORAGE_KEY);
  if (cached) {
    try { state = parseXml(cached); return 'cache'; }
    catch (e) { console.warn('localStorage 캐시 파싱 실패, 무시:', e); }
  }
  // 3) 내장 시드
  state = parseXml(SEED_XML);
  return 'seed';
}

// ============================================================
// 행 레이아웃 (region header + country rows)
// ============================================================
function baseCountryName(name) {
  return (name || '').replace(/\s*\(\d+\)\s*$/, '').trim();
}

function buildRowLayout() {
  const rows = [];
  const countryRowIdx = new Map();
  for (const r of getOrderedRegions()) {
    rows.push({ type: 'region', id: r.id, name: r.name });
    const cs = getOrderedCountries(r.id);
    let prevBase = null;
    for (const c of cs) {
      const base = baseCountryName(c.name);
      countryRowIdx.set(c.id, rows.length);
      rows.push({
        type: 'country', id: c.id, name: c.name, regionId: c.regionId,
        baseName: base,
        mergedWithPrev: prevBase !== null && prevBase === base
      });
      prevBase = base;
    }
  }
  return { rows, countryRowIdx };
}

// ============================================================
// 렌더 - 사이즈
// ============================================================
function applySize() {
  const w = totalWidth();
  document.documentElement.style.setProperty('--content-width', w + 'px');
  const { rows } = buildRowLayout();
  const h = rows.length * ROW_HEIGHT;
  document.getElementById('rows-content').style.height = h + 'px';
  document.getElementById('rows-labels').style.height = h + 'px';
}

// ============================================================
// 렌더 - 가로축 (연도 + 사건)
// ============================================================
function chooseLabelInterval() {
  const px = pxPerYear();
  if (px >= 0.8) return 100;
  if (px >= 0.3) return 200;
  if (px >= 0.15) return 500;
  return 1000;
}

function renderHeader() {
  const axis = document.getElementById('year-axis');
  const tracksWrap = document.getElementById('event-tracks');
  const cornerTracks = document.getElementById('corner-tracks');
  // year-axis 안에 indicator 자식이 있으니 그것만 빼고 비움
  [...axis.querySelectorAll('.year-tick, .year-label')].forEach(el => el.remove());
  tracksWrap.innerHTML = '';
  cornerTracks.innerHTML = '';

  const labelInterval = chooseLabelInterval();
  const minorInterval = labelInterval >= 200 ? labelInterval / 2 : 100;
  const startY = Math.ceil(state.config.startYear / minorInterval) * minorInterval;

  for (let y = startY; y <= state.config.endYear; y += minorInterval) {
    const x = yearToX(y);
    const tick = document.createElement('div');
    tick.className = 'year-tick';
    if (y % labelInterval === 0) tick.classList.add('major');
    if (y === 0) tick.classList.add('zero');
    tick.style.left = x + 'px';
    axis.appendChild(tick);

    if (y % labelInterval === 0) {
      const lbl = document.createElement('div');
      lbl.className = 'year-label major';
      lbl.style.left = x + 'px';
      lbl.textContent = fmtYear(y);
      axis.appendChild(lbl);
    }
  }

  // 사건 오버레이를 year-axis 위로도 연장 (세로 선이 연도 표시 행을 가로지름)
  if (showEventOverlay) {
    for (const ev of state.events) {
      if (hiddenEventIds.has(ev.id)) continue;
      const isRange = ev.endYear != null && !isNaN(ev.endYear) && ev.endYear !== ev.year;
      if (isRange) {
        const x1 = yearToX(ev.year);
        const x2 = yearToX(ev.endYear);
        if (x2 < 0 || x1 > totalWidth()) continue;
        const box = document.createElement('div');
        box.className = 'event-overlay-box axis-overlay';
        box.style.left = x1 + 'px';
        box.style.width = Math.max(2, x2 - x1) + 'px';
        axis.appendChild(box);
      } else {
        if (ev.year < state.config.startYear || ev.year > state.config.endYear) continue;
        const line = document.createElement('div');
        line.className = 'event-overlay-line axis-overlay';
        line.style.left = yearToX(ev.year) + 'px';
        axis.appendChild(line);
      }
    }
  }

  // 트랙(라인)별 헤더 렌더
  const tracks = state.eventTracks?.length ? state.eventTracks : [{ id: 'evt_default', name: '' }];
  tracks.forEach((t, idx) => {
    // 좌측 corner: 트랙 라벨 + 삭제 버튼
    const crow = document.createElement('div');
    crow.className = 'corner-track-row';
    const label = t.name?.trim() || `라인 ${idx + 1}`;
    crow.innerHTML = `
      <span class="track-label">${escHtml(label)}</span>
      <button class="track-del" data-del-track="${escAttr(t.id)}" title="라인 삭제">×</button>
    `;
    cornerTracks.appendChild(crow);

    // 우측: 트랙 마커/막대 영역
    const row = document.createElement('div');
    row.className = 'event-track-row';
    row.dataset.trackId = t.id;
    tracksWrap.appendChild(row);

    // 이 트랙의 사건들 렌더
    for (const ev of state.events) {
      if (ev.trackId !== t.id) continue;
      const isRange = ev.endYear != null && !isNaN(ev.endYear) && ev.endYear !== ev.year;
      const evStart = ev.year;
      const evEnd = isRange ? ev.endYear : ev.year;
      if (evEnd < state.config.startYear || evStart > state.config.endYear) continue;

      const hidden = hiddenEventIds.has(ev.id);
      const onClick = e => { e.stopPropagation(); toggleEventHidden(ev.id); };
      const onDblClick = e => { e.stopPropagation(); openEventModal(ev.id); };
      if (isRange) {
        const x1 = yearToX(evStart);
        const x2 = yearToX(evEnd);
        const range = document.createElement('div');
        range.className = 'event-range' + (hidden ? ' event-hidden' : '');
        range.style.left = x1 + 'px';
        range.style.width = Math.max(2, x2 - x1) + 'px';
        range.dataset.eventId = ev.id;
        range.title = `${ev.name} (${fmtYear(evStart)} ~ ${fmtYear(evEnd)}) — 클릭: 선 표시/숨김, 더블클릭: 편집`;
        range.innerHTML =
          `<div class="bar"></div>` +
          `<div class="label">${escHtml(ev.name)} (${fmtYear(evStart)} ~ ${fmtYear(evEnd)})</div>`;
        range.addEventListener('click', onClick);
        range.addEventListener('dblclick', onDblClick);
        row.appendChild(range);
      } else {
        const m = document.createElement('div');
        m.className = 'event-marker' + (hidden ? ' event-hidden' : '');
        m.style.left = yearToX(evStart) + 'px';
        m.dataset.eventId = ev.id;
        m.title = '클릭: 선 표시/숨김, 더블클릭: 편집';
        m.innerHTML = `<div class="dot"></div><div class="label">${escHtml(ev.name)} (${fmtYear(evStart)})</div>`;
        m.addEventListener('click', onClick);
        m.addEventListener('dblclick', onDblClick);
        row.appendChild(m);
      }
    }
  });

  // corner의 삭제 버튼 이벤트
  cornerTracks.querySelectorAll('[data-del-track]').forEach(btn => {
    btn.addEventListener('click', () => removeEventTrack(btn.dataset.delTrack));
  });
}

// 런타임 플래그 — 저장/영속화 안 함, 페이지 새로고침 시 기본값으로 복귀
let showEventOverlay = true;
let hiddenEventIds = new Set();  // 화면에서 숨길 사건 ID들 (저장 안 됨)

function applyOverlayVisibility() {
  const layer = document.getElementById('events-overlay-layer');
  if (!layer) return;
  layer.style.display = showEventOverlay ? '' : 'none';
}

function toggleEventHidden(id) {
  if (hiddenEventIds.has(id)) hiddenEventIds.delete(id);
  else hiddenEventIds.add(id);
  render();
}

function setupOverlayToggle() {
  const cb = document.getElementById('overlay-toggle');
  if (!cb) return;
  cb.addEventListener('change', () => {
    showEventOverlay = cb.checked;
    applyOverlayVisibility();
  });
}

function updateDeviceStatus() {
  const el = document.getElementById('device-status');
  if (!el) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  // 미디어 쿼리와 동일 기준
  const isMobile = w <= 600 || h <= 500;
  const isTablet = !isMobile && (w <= 1024);
  const kind = isMobile ? 'Mobile' : isTablet ? 'Tablet' : 'PC';
  const orient = w >= h ? 'Landscape' : 'Portrait';
  const dpr = (window.devicePixelRatio || 1).toFixed(1);
  el.textContent = `${kind} · ${orient} · ${w}×${h} @${dpr}x`;
}

function renderEventOverlay() {
  const layer = document.getElementById('events-overlay-layer');
  if (!layer) return;
  layer.innerHTML = '';
  applyOverlayVisibility();
  for (const ev of state.events) {
    if (hiddenEventIds.has(ev.id)) continue;
    const isRange = ev.endYear != null && !isNaN(ev.endYear) && ev.endYear !== ev.year;
    if (isRange) {
      const x1 = yearToX(ev.year);
      const x2 = yearToX(ev.endYear);
      if (x2 < 0 || x1 > totalWidth()) continue;
      const box = document.createElement('div');
      box.className = 'event-overlay-box';
      box.style.left = x1 + 'px';
      box.style.width = Math.max(2, x2 - x1) + 'px';
      layer.appendChild(box);
    } else {
      if (ev.year < state.config.startYear || ev.year > state.config.endYear) continue;
      const line = document.createElement('div');
      line.className = 'event-overlay-line';
      line.style.left = yearToX(ev.year) + 'px';
      layer.appendChild(line);
    }
  }
}

function escHtml(s) {
  const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML;
}

// ============================================================
// 렌더 - 좌측 라벨
// ============================================================
function renderLeftLabels() {
  const root = document.getElementById('rows-labels');
  root.innerHTML = '';
  for (const r of getOrderedRegions()) {
    const block = document.createElement('div');
    block.className = 'region-block';

    const rh = document.createElement('div');
    rh.className = 'region-header';
    rh.draggable = true;
    rh.dataset.dragRegion = r.id;
    rh.innerHTML = `
      <span class="region-name">${escHtml(r.name)}</span>
      <button class="icon" data-edit-region="${r.id}" title="지역 편집">✎</button>
      <button class="icon" data-add-country="${r.id}" title="이 지역에 나라 추가">+</button>
    `;
    block.appendChild(rh);

    const cs = getOrderedCountries(r.id);
    let i = 0;
    while (i < cs.length) {
      const base = baseCountryName(cs[i].name);
      let j = i;
      while (j < cs.length && baseCountryName(cs[j].name) === base) j++;
      const group = cs.slice(i, j);
      const groupSize = group.length;

      const row = document.createElement('div');
      row.className = 'country-row-label' + (groupSize > 1 ? ' merged' : '');
      row.draggable = true;
      row.dataset.dragCountry = group[0].id;
      row.dataset.dragCountryRegion = r.id;
      if (groupSize > 1) row.style.height = (groupSize * ROW_HEIGHT) + 'px';

      const displayName = groupSize > 1 ? base : group[0].name;
      const cidsAttr = group.map(c => c.id).join(',');
      const editTitle = groupSize > 1 ? `첫 항목(${escHtml(group[0].name)}) 편집` : '나라 편집';
      row.innerHTML = `
        <span class="country-name">${escHtml(displayName)}</span>
        <div class="actions">
          <button class="icon" data-edit-country="${group[0].id}" title="${editTitle}">✎</button>
          <button class="icon" data-add-entry-cids="${cidsAttr}" title="시기 추가">+</button>
        </div>
      `;
      block.appendChild(row);
      i = j;
    }
    root.appendChild(block);
  }

  root.querySelectorAll('[data-edit-region]').forEach(btn => {
    btn.addEventListener('click', () => openRegionModal(btn.dataset.editRegion));
  });
  root.querySelectorAll('[data-add-country]').forEach(btn => {
    btn.addEventListener('click', () => openCountryModal(null, btn.dataset.addCountry));
  });
  root.querySelectorAll('[data-edit-country]').forEach(btn => {
    btn.addEventListener('click', () => openCountryModal(btn.dataset.editCountry));
  });
  root.querySelectorAll('[data-add-entry-cids]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cids = btn.dataset.addEntryCids.split(',').filter(Boolean);
      openEntryModal(null, cids);
    });
  });
}

// ============================================================
// 렌더 - 그리드 배경
// ============================================================
function renderGridBg() {
  const bg = document.getElementById('grid-bg');
  bg.innerHTML = '';
  const { rows } = buildRowLayout();

  // 지역 행 배경
  rows.forEach((r, i) => {
    if (r.type === 'region') {
      const strip = document.createElement('div');
      strip.className = 'region-strip';
      strip.style.top = (i * ROW_HEIGHT) + 'px';
      bg.appendChild(strip);
    }
  });
  // 행 구분선 (병합된 sub-row 사이는 건너뜀)
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].type === 'country' && rows[i].mergedWithPrev) continue;
    const sep = document.createElement('div');
    sep.className = (rows[i].type === 'region') ? 'region-sep' : 'row-sep';
    sep.style.top = (i * ROW_HEIGHT) + 'px';
    bg.appendChild(sep);
  }
  // 세로 격자
  const labelInterval = chooseLabelInterval();
  const minorInterval = labelInterval >= 200 ? labelInterval / 2 : 100;
  const startY = Math.ceil(state.config.startYear / minorInterval) * minorInterval;
  for (let y = startY; y <= state.config.endYear; y += minorInterval) {
    const v = document.createElement('div');
    v.className = 'vline';
    if (y % labelInterval === 0) v.classList.add('major');
    if (y === 0) v.classList.add('zero');
    v.style.left = yearToX(y) + 'px';
    bg.appendChild(v);
  }
}

// ============================================================
// 렌더 - 시기 막대 (셀 병합 그룹화)
// ============================================================
function groupContiguous(rowIdxs) {
  const sorted = [...rowIdxs].sort((a,b) => a - b);
  const groups = [];
  let cur = null;
  for (const idx of sorted) {
    if (cur && idx === cur[cur.length - 1] + 1) cur.push(idx);
    else { cur = [idx]; groups.push(cur); }
  }
  return groups;
}

function renderEntries() {
  const layer = document.getElementById('entries-layer');
  layer.innerHTML = '';
  const { countryRowIdx } = buildRowLayout();

  // 1) 모든 바 정의 수집
  const bars = [];
  for (const e of state.entries) {
    const idxs = e.countryIds.map(id => countryRowIdx.get(id)).filter(i => i != null);
    if (idxs.length === 0) continue;
    const groups = groupContiguous(idxs);
    const x1 = yearToX(e.startYear);
    const x2 = yearToX(e.endYear);
    const w = Math.max(2, x2 - x1);
    for (const g of groups) {
      const top = g[0] * ROW_HEIGHT + 2;
      const h   = g.length * ROW_HEIGHT - 4;
      bars.push({
        entry: e, x1, w, top, h,
        rowStart: g[0], rowEnd: g[g.length - 1],
        mergeTop: false, mergeBottom: false, mergeLeft: false, mergeRight: false,
        hideText: false
      });
    }
  }

  // 2) group 별로 묶어서 인접한 변 표시
  const byGroup = new Map();
  for (const b of bars) {
    const gid = b.entry.group;
    if (!gid) continue;
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid).push(b);
  }
  for (const gbars of byGroup.values()) {
    // 면적 가장 큰 바에만 이름 노출
    let primary = gbars[0];
    for (const b of gbars) if ((b.w * b.h) > (primary.w * primary.h)) primary = b;
    for (const b of gbars) if (b !== primary) b.hideText = true;
    // 변별 인접성 판정
    for (let i = 0; i < gbars.length; i++) {
      for (let j = i + 1; j < gbars.length; j++) {
        const a = gbars[i], c = gbars[j];
        const xOverlap = Math.max(a.x1, c.x1) < Math.min(a.x1 + a.w, c.x1 + c.w);
        const yOverlap = Math.max(a.top, c.top) < Math.min(a.top + a.h, c.top + c.h);
        if (a.rowEnd + 1 === c.rowStart && xOverlap) { a.mergeBottom = true; c.mergeTop = true; }
        else if (c.rowEnd + 1 === a.rowStart && xOverlap) { c.mergeBottom = true; a.mergeTop = true; }
        else if (Math.abs((a.x1 + a.w) - c.x1) < 1 && yOverlap) { a.mergeRight = true; c.mergeLeft = true; }
        else if (Math.abs((c.x1 + c.w) - a.x1) < 1 && yOverlap) { c.mergeRight = true; a.mergeLeft = true; }
      }
    }
  }

  // 3) DOM 출력
  for (const b of bars) {
    const e = b.entry;
    let { x1, w, top, h } = b;
    if (b.mergeTop)    { top -= 2; h += 2; }
    if (b.mergeBottom) { h += 2; }
    const bar = document.createElement('div');
    bar.className = 'entry' + (b.hideText ? ' entry-secondary' : '');
    if (e.group) bar.dataset.group = e.group;
    bar.style.left = x1 + 'px';
    bar.style.top = top + 'px';
    bar.style.width = w + 'px';
    bar.style.height = h + 'px';
    bar.style.background = e.color || COLOR_PALETTE[hash(e.id) % COLOR_PALETTE.length];
    if (b.mergeTop)    { bar.style.borderTopColor = 'transparent';    bar.style.borderTopLeftRadius = '0';    bar.style.borderTopRightRadius = '0'; }
    if (b.mergeBottom) { bar.style.borderBottomColor = 'transparent'; bar.style.borderBottomLeftRadius = '0'; bar.style.borderBottomRightRadius = '0'; }
    if (b.mergeLeft)   { bar.style.borderLeftColor = 'transparent';   bar.style.borderTopLeftRadius = '0';    bar.style.borderBottomLeftRadius = '0'; }
    if (b.mergeRight)  { bar.style.borderRightColor = 'transparent';  bar.style.borderTopRightRadius = '0';   bar.style.borderBottomRightRadius = '0'; }
    bar.dataset.entryId = e.id;
    const imgCount = (e.images || []).length;
    if (!b.hideText) {
      bar.innerHTML = `<span class="name">${escHtml(e.name)}</span>` +
                      (imgCount > 0 ? `<span class="img-badge" title="이미지 ${imgCount}장">🖼${imgCount > 1 ? imgCount : ''}</span>` : '');
    }
    bar.addEventListener('click', ev => { ev.stopPropagation(); openEntryModal(e.id); });
    bar.addEventListener('mouseenter', ev => showTooltip(ev, e));
    bar.addEventListener('mousemove',  ev => moveTooltip(ev));
    bar.addEventListener('mouseleave', hideTooltip);
    layer.appendChild(bar);
  }
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ============================================================
// 렌더 - 인디케이터
// ============================================================
function updateIndicator() {
  const y = state.config.indicatorYear;
  const x = yearToX(y);
  document.getElementById('indicator-line').style.left = x + 'px';
  document.getElementById('indicator-handle').style.left = x + 'px';
  const lbl = document.getElementById('indicator-label');
  lbl.style.left = x + 'px';
  lbl.textContent = fmtYear(y);
  const yi = document.getElementById('indicator-year');
  if (document.activeElement !== yi) yi.value = Math.round(y);
}

// ============================================================
// 툴팁
// ============================================================
function showTooltip(evt, e) {
  const tt = document.getElementById('entry-tooltip');
  tt.hidden = false;
  tt.innerHTML =
    `<div class="tt-name">${escHtml(e.name)}</div>` +
    `<div class="tt-period">${fmtYear(e.startYear)} ~ ${fmtYear(e.endYear)} ` +
    `(${e.endYear - e.startYear}년)</div>` +
    ((e.images || []).map(img => `<img src="${escHtml(resolveImage(img))}" alt="" onerror="this.style.display='none'" style="margin-bottom:4px;">`).join('')) +
    (e.description ? `<div class="tt-desc">${escHtml(e.description)}</div>` : '');
  moveTooltip(evt);
}
function moveTooltip(evt) {
  const tt = document.getElementById('entry-tooltip');
  const pad = 14;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  const r = tt.getBoundingClientRect();
  if (x + r.width  > window.innerWidth)  x = evt.clientX - r.width  - pad;
  if (y + r.height > window.innerHeight) y = evt.clientY - r.height - pad;
  tt.style.left = x + 'px';
  tt.style.top  = y + 'px';
}
function hideTooltip() { document.getElementById('entry-tooltip').hidden = true; }

// ============================================================
// 전체 렌더
// ============================================================
function render() {
  applySize();
  renderHeader();
  renderLeftLabels();
  renderGridBg();
  renderEntries();
  renderEventOverlay();
  updateIndicator();
}

function addEventTrack() {
  if (!state.eventTracks) state.eventTracks = [];
  state.eventTracks.push({ id: genId('evt'), name: '' });
  persist(); render();
}

function removeEventTrack(trackId) {
  if (!state.eventTracks?.length) return;
  if (state.eventTracks.length <= 1) {
    alert('마지막 라인은 삭제할 수 없습니다.');
    return;
  }
  const onTrack = state.events.filter(e => e.trackId === trackId).length;
  const msg = onTrack > 0
    ? `이 라인에 사건 ${onTrack}건이 있습니다. 라인과 함께 모두 삭제됩니다. 진행할까요?`
    : '라인을 삭제할까요?';
  if (!confirm(msg)) return;
  state.events = state.events.filter(e => e.trackId !== trackId);
  state.eventTracks = state.eventTracks.filter(t => t.id !== trackId);
  persist(); render();
}

// ============================================================
// 인디케이터 드래그 / 클릭
// ============================================================
function setupIndicator() {
  const axis = document.getElementById('year-axis');
  const handle = document.getElementById('indicator-handle');
  const scroll = document.getElementById('scroll');

  function moveIndicatorFromEvent(evt) {
    const r = axis.getBoundingClientRect();
    const x = evt.clientX - r.left;
    const y = xToYear(x);
    state.config.indicatorYear = clamp(Math.round(y), state.config.startYear, state.config.endYear);
    updateIndicator();
    persist();
  }

  // 핸들 드래그: 인디케이터를 마우스를 따라 이동
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    document.body.style.cursor = 'ew-resize';
    function onMove(ev) { moveIndicatorFromEvent(ev); }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // 연도축 드래그: 타임라인 가로 패닝 (이동 없으면 클릭으로 간주해 인디케이터 이동)
  const PAN_THRESHOLD = 3;
  axis.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startScrollLeft = scroll.scrollLeft;
    let panning = false;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      if (!panning && Math.abs(dx) > PAN_THRESHOLD) {
        panning = true;
        axis.classList.add('panning');
        document.body.style.cursor = 'grabbing';
      }
      if (panning) {
        scroll.scrollLeft = startScrollLeft - dx;
      }
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      axis.classList.remove('panning');
      document.body.style.cursor = '';
      if (!panning) {
        // 거의 안 움직였으면 클릭 — 인디케이터 점프
        moveIndicatorFromEvent(ev);
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });

  document.getElementById('indicator-year').addEventListener('change', e => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v)) {
      state.config.indicatorYear = clamp(v, state.config.startYear, state.config.endYear);
      updateIndicator();
      persist();
    }
  });
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ============================================================
// 사건 트랙 클릭 (빈 곳 클릭 시 추가)
// ============================================================
function setupEventTrack() {
  const tracksWrap = document.getElementById('event-tracks');
  // 이벤트 위임: 라인 행의 빈 영역 클릭 시 해당 라인에 사건 추가
  tracksWrap.addEventListener('click', e => {
    const row = e.target.closest('.event-track-row');
    if (!row) return;
    if (e.target !== row) return; // 마커/막대 클릭은 stopPropagation으로 막힘
    const trackId = row.dataset.trackId;
    const r = row.getBoundingClientRect();
    const y = Math.round(xToYear(e.clientX - r.left));
    openEventModal(null, y, trackId);
  });
}

// ============================================================
// 줌 / 범위 컨트롤
// ============================================================
function setupRangeAndZoom() {
  const zoom = document.getElementById('zoom');
  const zoomVal = document.getElementById('zoom-value');
  zoom.value = state.config.zoom;
  zoomVal.textContent = state.config.zoom.toFixed(1) + '×';
  zoom.addEventListener('input', () => {
    state.config.zoom = parseFloat(zoom.value);
    zoomVal.textContent = state.config.zoom.toFixed(1) + '×';
    render();
    persist();
  });
  const rs = document.getElementById('range-start');
  const re = document.getElementById('range-end');
  rs.value = state.config.startYear;
  re.value = state.config.endYear;
  function applyRange() {
    const a = parseInt(rs.value, 10), b = parseInt(re.value, 10);
    if (isNaN(a) || isNaN(b) || a >= b) return;
    state.config.startYear = a;
    state.config.endYear   = b;
    render(); persist();
  }
  rs.addEventListener('change', applyRange);
  re.addEventListener('change', applyRange);
}

// ============================================================
// 툴바: 추가/내보내기/불러오기/초기화
// ============================================================
function setupToolbar() {
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.action;
      if (a === 'add-region')  openRegionModal(null);
      if (a === 'add-country') openCountryModal(null);
      if (a === 'add-entry')   openEntryModal(null);
      if (a === 'add-event')   openEventModal(null, state.config.indicatorYear);
      if (a === 'export')      exportXml();
      if (a === 'import')      document.getElementById('import-file').click();
      if (a === 'reset')       resetAll();
      if (a === 'connect-file') {
        if (dirHandle) {
          if (confirm(`${dirHandle.name}/ 폴더 연결을 해제하시겠습니까?`)) disconnectDir();
        } else {
          connectDir();
        }
      }
      if (a === 'github') openGithubModal();
    });
  });
  document.getElementById('import-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    const text = await f.text();
    try {
      state = parseXml(text);
      persist(); render();
      alert('불러오기 완료');
    } catch (err) {
      alert('XML 오류: ' + err.message);
    }
    e.target.value = '';
  });
}

function exportXml() {
  const xml = serializeXml(state);
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'data.xml';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

function resetAll() {
  if (!confirm('localStorage 캐시를 지우고 data.xml(없으면 시드)에서 다시 불러옵니다. 계속할까요?')) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(RUNTIME_KEY);
  location.reload();
}

// ============================================================
// 모달 (공통)
// ============================================================
function openModal(title, bodyHtml, onSave, onDelete) {
  const back = document.getElementById('modal-backdrop');
  document.getElementById('modal-title').textContent = title;
  const form = document.getElementById('modal-form');
  form.innerHTML = bodyHtml;
  back.hidden = false;

  const saveBtn = document.getElementById('modal-save');
  const cancelBtn = document.getElementById('modal-cancel');
  const delBtn = document.getElementById('modal-delete');
  delBtn.style.display = onDelete ? '' : 'none';

  function close() {
    back.hidden = true;
    saveBtn.onclick = cancelBtn.onclick = delBtn.onclick = null;
  }
  saveBtn.onclick = () => { if (onSave(form) !== false) { close(); persist(); render(); } };
  cancelBtn.onclick = close;
  delBtn.onclick = async () => {
    if (!confirm('삭제하시겠습니까?')) return;
    const r = onDelete();
    if (r && typeof r.then === 'function') await r;
    close(); persist(); render();
  };

  // 첫 입력에 포커스
  setTimeout(() => form.querySelector('input,textarea,select')?.focus(), 0);
}

// ============================================================
// 모달 - 지역
// ============================================================
function openRegionModal(id) {
  const r = id ? state.regions.find(x => x.id === id) : null;
  const html = `
    <label>이름
      <input name="name" type="text" value="${escAttr(r?.name)}" required>
    </label>
  `;
  openModal(r ? '지역 편집' : '지역 추가', html,
    form => {
      const name = form.name.value.trim();
      if (!name) return false;
      if (r) { r.name = name; }
      else   { state.regions.push({ id: genId('r'), name }); }
    },
    r ? () => {
      // 캐스케이드: 소속 나라 + 그 나라 참조 entry 정리
      const removedCountryIds = state.countries.filter(c => c.regionId === r.id).map(c => c.id);
      state.countries = state.countries.filter(c => c.regionId !== r.id);
      state.entries.forEach(e => { e.countryIds = e.countryIds.filter(cid => !removedCountryIds.includes(cid)); });
      state.entries = state.entries.filter(e => e.countryIds.length > 0);
      state.regions = state.regions.filter(x => x.id !== r.id);
    } : null
  );
}

// ============================================================
// 모달 - 나라
// ============================================================
function openCountryModal(id, defaultRegionId) {
  const c = id ? state.countries.find(x => x.id === id) : null;
  const opts = getOrderedRegions().map(r =>
    `<option value="${escAttr(r.id)}" ${ (c?.regionId || defaultRegionId) === r.id ? 'selected' : ''}>${escHtml(r.name)}</option>`
  ).join('');
  const html = `
    <label>이름
      <input name="name" type="text" value="${escAttr(c?.name)}" required>
    </label>
    <label>지역
      <select name="region" required>${opts}</select>
    </label>
  `;
  openModal(c ? '나라 편집' : '나라 추가', html,
    form => {
      const name = form.name.value.trim();
      const regionId = form.region.value;
      if (!name || !regionId) return false;
      if (c) { c.name = name; c.regionId = regionId; }
      else   { state.countries.push({ id: genId('c'), name, regionId }); }
    },
    c ? () => {
      state.entries.forEach(e => { e.countryIds = e.countryIds.filter(x => x !== c.id); });
      state.entries = state.entries.filter(e => e.countryIds.length > 0);
      state.countries = state.countries.filter(x => x.id !== c.id);
    } : null
  );
}

// ============================================================
// 모달 - 시기 (entry)
// ============================================================
function openEntryModal(id, defaultCountryIds) {
  const e = id ? state.entries.find(x => x.id === id) : null;

  // 단일 country 선택 (기존 다중 entry는 첫 번째만 유지)
  let selectedCid = null;
  if (e?.countryIds?.length) {
    selectedCid = e.countryIds[0];
  } else if (defaultCountryIds?.length) {
    selectedCid = defaultCountryIds[0];
  } else {
    const firstR = getOrderedRegions()[0];
    const firstC = firstR ? getOrderedCountries(firstR.id)[0] : null;
    if (firstC) selectedCid = firstC.id;
  }

  const html = `
    <label>이름
      <input name="name" type="text" value="${escAttr(e?.name)}" required>
    </label>
    <div class="row">
      <label>시작 연도 (BC는 음수)
        <input name="start" type="number" step="1" value="${e?.startYear ?? state.config.indicatorYear}" required>
      </label>
      <label>끝 연도
        <input name="end" type="number" step="1" value="${e?.endYear ?? (state.config.indicatorYear + 100)}" required>
      </label>
    </div>
    <label>색상
      <input name="color" type="color" value="${e?.color || '#bfdbfe'}">
    </label>
    <label>이미지 (여러 장 가능)
      <div style="display:flex; gap:6px;">
        <input name="image-text" type="text" placeholder="data/images/foo.jpg 또는 https://..." style="flex:1;">
        <button type="button" id="add-image-text">＋ 경로 추가</button>
      </div>
      <div style="display:flex; align-items:center; gap:6px; margin-top:4px;">
        <input name="image-upload" type="file" accept="image/*" multiple style="flex:1;">
        <span id="image-upload-status" style="font-size:11px;"></span>
      </div>
      <div id="images-stack" class="images-stack"></div>
    </label>
    <label>설명
      <textarea name="description">${escHtml(e?.description)}</textarea>
    </label>
    <label>소속 지역/나라
      <select name="country" id="country-select"></select>
      <div id="new-country-form" hidden style="margin-top:6px; padding:8px; background: var(--bg-alt); border-radius:4px;">
        <div class="row">
          <label>나라 이름
            <input name="new-country-name" type="text" placeholder="예: 베트남">
          </label>
          <label>지역
            <select name="new-country-region"></select>
          </label>
        </div>
        <label id="new-region-row" hidden style="margin-top:4px;">새 지역 이름
          <input name="new-region-name" type="text" placeholder="예: 동남아시아">
        </label>
        <div style="margin-top:6px; display:flex; gap:6px; justify-content:flex-end;">
          <button type="button" id="cancel-new-country">취소</button>
          <button type="button" id="confirm-new-country" class="primary">추가</button>
        </div>
      </div>
    </label>
  `;

  let countryChanged = false;

  openModal(e ? '시기 편집' : '시기 추가', html,
    form => {
      const name = form.name.value.trim();
      const startYear = parseInt(form.start.value, 10);
      const endYear   = parseInt(form.end.value, 10);
      const color = form.color.value;
      const description = form.description.value.trim();
      const cid = form.country.value;
      const stackEl = form.querySelector('#images-stack');
      const images = [...stackEl.querySelectorAll('.image-preview')].map(d => d.dataset.path).filter(Boolean);
      if (!name || isNaN(startYear) || isNaN(endYear) || !cid || cid === '__NEW__') {
        alert('이름, 연도, 소속 나라는 필수입니다.');
        return false;
      }
      if (endYear <= startYear) { alert('끝 연도는 시작 연도보다 커야 합니다.'); return false; }
      const countryIds = (e && !countryChanged) ? e.countryIds : [cid];
      if (e) {
        Object.assign(e, { name, startYear, endYear, color, images, description, countryIds });
      } else {
        state.entries.push({ id: genId('e'), name, startYear, endYear, color, images, description, countryIds });
      }
    },
    e ? async () => {
      const filesToDelete = (e.images || []).filter(p =>
        p && !p.startsWith('data:') && !/^https?:\/\//.test(p) && !isImageUsedByOthers(p, e.id)
      );
      if (filesToDelete.length > 0) {
        if (confirm(`연결된 이미지 파일 ${filesToDelete.length}개도 함께 삭제할까요?`)) {
          for (const p of filesToDelete) {
            try { await deleteImageFile(p); } catch (err) { console.warn(err); }
          }
        }
      }
      state.entries = state.entries.filter(x => x.id !== e.id);
    } : null
  );

  // ---------- 폼 초기화 ----------
  const form = document.getElementById('modal-form');
  const select = form.querySelector('#country-select');
  const newForm = form.querySelector('#new-country-form');
  const cancelNew = form.querySelector('#cancel-new-country');
  const confirmNew = form.querySelector('#confirm-new-country');
  const newNameInput = newForm.querySelector('[name="new-country-name"]');
  const regionSelect = newForm.querySelector('[name="new-country-region"]');
  const newRegionRow = newForm.querySelector('#new-region-row');
  const newRegionInput = newForm.querySelector('[name="new-region-name"]');

  function rebuildCountrySelect(currentCid) {
    let opts = '';
    let hasAny = false;
    for (const r of getOrderedRegions()) {
      const cs = getOrderedCountries(r.id);
      if (!cs.length) continue;
      hasAny = true;
      opts += `<optgroup label="${escAttr(r.name)}">`;
      for (const c of cs) {
        const sel = c.id === currentCid ? ' selected' : '';
        opts += `<option value="${escAttr(c.id)}"${sel}>${escHtml(c.name)}</option>`;
      }
      opts += `</optgroup>`;
    }
    if (!hasAny) opts += '<option value="" disabled selected>나라가 없습니다 — 아래로 추가</option>';
    opts += `<option value="__NEW__">＋ 새 나라/지역 추가…</option>`;
    select.innerHTML = opts;
  }

  function rebuildRegionSelect() {
    regionSelect.innerHTML = '<option value="">지역 선택…</option>'
      + getOrderedRegions().map(r => `<option value="${escAttr(r.id)}">${escHtml(r.name)}</option>`).join('')
      + '<option value="__NEW__">+ 새 지역…</option>';
    newRegionRow.hidden = true;
    newRegionInput.value = '';
  }

  rebuildCountrySelect(selectedCid);
  rebuildRegionSelect();

  select.addEventListener('change', () => {
    if (select.value === '__NEW__') {
      newForm.hidden = false;
      rebuildCountrySelect(selectedCid); // 이전 선택으로 되돌림
      setTimeout(() => newNameInput.focus(), 0);
    } else {
      selectedCid = select.value;
      countryChanged = true;
    }
  });

  cancelNew.addEventListener('click', () => {
    newForm.hidden = true;
    newNameInput.value = '';
    rebuildRegionSelect();
  });
  regionSelect.addEventListener('change', () => {
    newRegionRow.hidden = regionSelect.value !== '__NEW__';
    if (!newRegionRow.hidden) setTimeout(() => newRegionInput.focus(), 0);
  });
  confirmNew.addEventListener('click', () => {
    const cname = newNameInput.value.trim();
    let rid = regionSelect.value;
    if (!cname) { alert('나라 이름이 필요합니다.'); return; }
    if (!rid)   { alert('지역을 선택하거나 새로 만드세요.'); return; }
    if (rid === '__NEW__') {
      const rname = newRegionInput.value.trim();
      if (!rname) { alert('새 지역 이름이 필요합니다.'); return; }
      const newRegion = { id: genId('r'), name: rname };
      state.regions.push(newRegion);
      rid = newRegion.id;
    }
    const newCountry = { id: genId('c'), name: cname, regionId: rid };
    state.countries.push(newCountry);
    selectedCid = newCountry.id;
    countryChanged = true;
    reconcileViewOrder();
    persist();
    render();

    newNameInput.value = '';
    newForm.hidden = true;
    rebuildRegionSelect();
    rebuildCountrySelect(selectedCid);
  });

  // 다중 이미지 미리보기 스택 (각 카드: 줌/팬/휴지통)
  const stackEl = form.querySelector('#images-stack');
  const textInput = form.querySelector('[name="image-text"]');
  const addTextBtn = form.querySelector('#add-image-text');
  const uploader = form.querySelector('[name="image-upload"]');
  const status = form.querySelector('#image-upload-status');

  function setStatus(text, kind) {
    status.textContent = text;
    status.style.color = kind === 'err' ? 'var(--danger)' : kind === 'ok' ? 'var(--accent)' : 'var(--muted)';
  }

  function createImagePreview(path) {
    const div = document.createElement('div');
    div.className = 'image-preview';
    div.dataset.path = path;
    div.innerHTML = `
      <button type="button" class="trash" title="이 이미지 제거">🗑</button>
      <img src="${escAttr(resolveImage(path))}" alt="" draggable="false"
           onerror="this.style.opacity=0.2" onload="this.style.opacity=1">
      <div class="preview-tools">
        <button type="button" data-zoom="out" title="축소">−</button>
        <button type="button" data-zoom="reset" title="원본 (또는 더블클릭)">⟳</button>
        <button type="button" data-zoom="in" title="확대">+</button>
      </div>
      <span class="resize-hint">↘ 영역 크기조절 / 휠: 줌 / 드래그: 이동</span>
    `;
    const img = div.querySelector('img');
    let scale = 1, panX = 0, panY = 0, dragStartPan = null;
    function applyTransform() { img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`; }
    function resetZoom() { scale = 1; panX = 0; panY = 0; applyTransform(); }
    function zoomAt(cx, cy, factor) {
      const newScale = Math.max(0.1, Math.min(30, scale * factor));
      const ratio = newScale / scale;
      panX = cx - ratio * (cx - panX);
      panY = cy - ratio * (cy - panY);
      scale = newScale;
      applyTransform();
    }
    div.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = div.getBoundingClientRect();
      zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, ev.deltaY < 0 ? 1.15 : 1/1.15);
    }, { passive: false });
    img.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      dragStartPan = { x: ev.clientX, y: ev.clientY, panX, panY };
      div.classList.add('dragging');
    });
    div._onDrag = (ev) => {
      if (!dragStartPan) return;
      panX = dragStartPan.panX + (ev.clientX - dragStartPan.x);
      panY = dragStartPan.panY + (ev.clientY - dragStartPan.y);
      applyTransform();
    };
    div._onDragEnd = () => { dragStartPan = null; };
    div.addEventListener('dblclick', (ev) => {
      if (ev.target.closest('.preview-tools, .trash')) return;
      resetZoom();
    });
    div.querySelector('[data-zoom="in"]').addEventListener('click', () => {
      const r = div.getBoundingClientRect(); zoomAt(r.width/2, r.height/2, 1.25);
    });
    div.querySelector('[data-zoom="out"]').addEventListener('click', () => {
      const r = div.getBoundingClientRect(); zoomAt(r.width/2, r.height/2, 1/1.25);
    });
    div.querySelector('[data-zoom="reset"]').addEventListener('click', resetZoom);
    div.querySelector('.trash').addEventListener('click', async () => {
      const p = div.dataset.path;
      if (!confirm('이 이미지를 제거할까요?\n(파일도 같이 삭제됩니다)')) return;
      const isFile = p && !p.startsWith('data:') && !/^https?:\/\//.test(p);
      if (isFile && !isImageUsedByOthers(p, e?.id)) {
        try { await deleteImageFile(p); } catch (err) { console.warn(err); }
      }
      div.remove();
    });
    return div;
  }

  function appendPreviewAndScroll(path) {
    const el = createImagePreview(path);
    stackEl.appendChild(el);
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 30);
  }

  // 초기 이미지들 렌더
  for (const p of (e?.images || [])) stackEl.appendChild(createImagePreview(p));

  // 경로 텍스트 추가
  addTextBtn.addEventListener('click', () => {
    const v = textInput.value.trim();
    if (!v) { textInput.focus(); textInput.placeholder = '경로를 먼저 입력하세요'; return; }
    appendPreviewAndScroll(v);
    textInput.value = '';
  });
  textInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); addTextBtn.click(); }
  });

  // 파일 업로드 (여러 장 가능)
  uploader?.addEventListener('change', async () => {
    const files = [...(uploader.files || [])];
    if (!files.length) return;
    if (!dirHandle && !githubConfig) {
      setStatus('✗ 먼저 📁 폴더 연결 또는 📤 GitHub 연결 필요', 'err');
      uploader.value = '';
      return;
    }
    setStatus(`업로드 중… (0/${files.length})`, 'info');
    let done = 0;
    for (const f of files) {
      try {
        const path = await uploadImage(f);
        appendPreviewAndScroll(path);
        done++;
        setStatus(`업로드 중… (${done}/${files.length})`, 'info');
      } catch (err) {
        setStatus('✗ ' + (err.message || err), 'err');
        break;
      }
    }
    if (done === files.length) setStatus(`✓ ${done}개 추가됨`, 'ok');
    uploader.value = '';
  });
}

// ============================================================
// 모달 - 사건
// ============================================================
function openEventModal(id, defaultYear, defaultTrackId) {
  const ev = id ? state.events.find(x => x.id === id) : null;
  if (!state.eventTracks?.length) state.eventTracks = [{ id: 'evt_default', name: '' }];

  function buildTrackOpts(currentTrackId) {
    const tracks = state.eventTracks;
    const opts = tracks.map((t, i) =>
      `<option value="${escAttr(t.id)}"${t.id === currentTrackId ? ' selected' : ''}>${escHtml(t.name?.trim() || `라인 ${i+1}`)}</option>`
    ).join('');
    return opts + `<option value="__NEW__">＋ 새 라인 추가</option>`;
  }

  const currentTrack = ev?.trackId || defaultTrackId || state.eventTracks[0].id;
  const trackOpts = buildTrackOpts(currentTrack);

  const yearVal = ev?.year ?? defaultYear ?? 0;
  const endVal = ev?.endYear ?? ev?.year ?? defaultYear ?? 0;
  const html = `
    <label>이름
      <input name="ev_name" type="text" value="${escAttr(ev?.name)}" required>
    </label>
    <label>라인
      <select name="ev_track">${trackOpts}</select>
    </label>
    <div class="row">
      <label>연도(시작)
        <input name="ev_year" type="number" step="1" value="${yearVal}" required>
      </label>
      <label>끝 연도
        <input name="ev_endYear" type="number" step="1" value="${endVal}">
      </label>
    </div>
    <label>설명
      <textarea name="ev_description">${escHtml(ev?.description)}</textarea>
    </label>
  `;
  openModal(ev ? '사건 편집' : '사건 추가', html,
    form => {
      const $ = sel => form.querySelector(sel);
      const name = $('[name="ev_name"]').value.trim();
      const year = parseInt($('[name="ev_year"]').value, 10);
      const endYearRaw = parseInt($('[name="ev_endYear"]').value, 10);
      const endYear = !isNaN(endYearRaw) && endYearRaw !== year ? endYearRaw : null;
      const trackId = $('[name="ev_track"]').value;
      const description = $('[name="ev_description"]').value.trim();
      if (!name || isNaN(year)) { alert('이름과 시작 연도는 필수입니다.'); return false; }
      if (trackId === '__NEW__') { alert('라인을 선택하세요.'); return false; }
      if (endYear != null && endYear < year) { alert('끝 연도는 시작 연도 이상이어야 합니다.'); return false; }
      if (ev) { Object.assign(ev, { name, year, endYear, trackId, description }); }
      else    { state.events.push({ id: genId('ev'), trackId, name, year, endYear, description }); }
    },
    ev ? () => { state.events = state.events.filter(x => x.id !== ev.id); } : null
  );

  // 트랙 새로 추가 핸들러
  const form = document.getElementById('modal-form');
  const trackSel = form.querySelector('[name="ev_track"]');
  if (trackSel) {
    trackSel.addEventListener('change', () => {
      if (trackSel.value !== '__NEW__') return;
      const newTrack = { id: genId('evt'), name: '' };
      state.eventTracks.push(newTrack);
      // 트랙 변경은 사건 저장 전에도 즉시 반영 (헤더에 새 라인 표시)
      persist();
      render();
      trackSel.innerHTML = buildTrackOpts(newTrack.id);
    });
  }
}

function escAttr(s) { return escHtml(s ?? ''); }

// ============================================================
// 초기화
// ============================================================
function setupDragAndDrop() {
  const root = document.getElementById('rows-labels');
  let dragType = null, dragId = null, dragRegionId = null;

  root.addEventListener('dragstart', e => {
    // 버튼/액션 영역에서 시작한 드래그는 차단 (클릭 보호)
    if (e.target.closest('.actions, button')) {
      e.preventDefault(); return;
    }
    const countryEl = e.target.closest('[data-drag-country]');
    const regionEl  = e.target.closest('[data-drag-region]');
    if (countryEl) {
      dragType = 'country';
      dragId = countryEl.dataset.dragCountry;
      dragRegionId = countryEl.dataset.dragCountryRegion;
      countryEl.classList.add('dragging');
    } else if (regionEl) {
      dragType = 'region';
      dragId = regionEl.dataset.dragRegion;
      regionEl.classList.add('dragging');
    } else {
      e.preventDefault(); return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId); // Firefox 요구
  });

  root.addEventListener('dragend', () => {
    root.querySelectorAll('.dragging, .drop-before, .drop-after').forEach(el => {
      el.classList.remove('dragging', 'drop-before', 'drop-after');
    });
    dragType = null; dragId = null; dragRegionId = null;
  });

  function findTarget(e) {
    if (dragType === 'region') {
      const t = e.target.closest('[data-drag-region]');
      if (!t || t.dataset.dragRegion === dragId) return null;
      return t;
    }
    if (dragType === 'country') {
      const t = e.target.closest('[data-drag-country]');
      if (!t || t.dataset.dragCountryRegion !== dragRegionId) return null;
      const grp = getCountryGroup(dragRegionId, dragId);
      if (grp.includes(t.dataset.dragCountry)) return null;
      return t;
    }
    return null;
  }

  root.addEventListener('dragover', e => {
    if (!dragType) return;
    const t = findTarget(e);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = t.getBoundingClientRect();
    const isBefore = e.clientY < rect.top + rect.height / 2;
    root.querySelectorAll('.drop-before, .drop-after').forEach(el => {
      el.classList.remove('drop-before', 'drop-after');
    });
    t.classList.add(isBefore ? 'drop-before' : 'drop-after');
  });

  root.addEventListener('drop', e => {
    if (!dragType) return;
    const t = findTarget(e);
    if (!t) return;
    e.preventDefault();
    const rect = t.getBoundingClientRect();
    const isBefore = e.clientY < rect.top + rect.height / 2;
    if (dragType === 'region') {
      reorderRegion(dragId, t.dataset.dragRegion, isBefore);
    } else {
      reorderCountry(dragRegionId, dragId, t.dataset.dragCountry, isBefore);
    }
    persistRuntime();
    render();
  });
}

// 이미지 미리보기 카드들의 드래그 팬을 위한 전역 디스패처 (한 번만 설정)
function setupImagePreviewGlobal() {
  document.addEventListener('mousemove', (e) => {
    document.querySelectorAll('.image-preview.dragging').forEach(div => {
      if (div._onDrag) div._onDrag(e);
    });
  });
  document.addEventListener('mouseup', () => {
    document.querySelectorAll('.image-preview.dragging').forEach(div => {
      if (div._onDragEnd) div._onDragEnd();
      div.classList.remove('dragging');
    });
  });
}

async function init() {
  await restoreDirHandle();          // 폴더 연결 먼저 복원 → loadInitial이 그 폴더 우선 사용
  const source = await loadInitial();
  loadRuntime();
  reconcileViewOrder();
  setupToolbar();
  setupIndicator();
  setupEventTrack();
  setupRangeAndZoom();
  setupDragAndDrop();
  setupOverlayToggle();
  updateDeviceStatus();
  window.addEventListener('resize', updateDeviceStatus);
  window.addEventListener('orientationchange', updateDeviceStatus);
  setupImagePreviewGlobal();
  loadGithubConfig();
  render();
  if (source === 'cache') {
    console.info('localStorage 캐시에서 복원됨. 변경사항을 보존하려면 "내보내기" 후 data.xml에 덮어쓰세요.');
  }
}
init();

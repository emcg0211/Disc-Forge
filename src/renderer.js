// ── Constants ─────────────────────────────────────────────────────────────────
// Track which input has focus so we can restore it after re-render
let _focusedId  = null;
let _focusedPos = null;  // cursor position
let _renderTimer = null;

function scheduleRender() {
  // Batch rapid state changes (per-keystroke text input) into a single render.
  // Focus/caret are captured HERE — at render time, after every batched
  // keystroke — and restored by attachListeners(), the same restore path the
  // old synchronous flow used; capture-at-render is strictly more accurate.
  clearTimeout(_renderTimer);
  _renderTimer = setTimeout(() => {
    const activeEl = document.activeElement;
    if (activeEl && activeEl.id) {
      _focusedId  = activeEl.id;
      _focusedPos = activeEl.selectionStart ?? null;
    } else if (activeEl && activeEl.classList && activeEl.classList.contains('ig-label-input')) {
      // ig-label-input rows carry data-idx instead of an id.
      _focusedId  = '__iglabel:' + activeEl.dataset.idx;
      _focusedPos = activeEl.selectionStart ?? null;
    }
    render();
  }, 0);
}
const LANGUAGES = ['English','French','Spanish','German','Italian','Portuguese','Japanese','Korean','Mandarin','Cantonese','Russian','Arabic','Hindi','Dutch','Swedish','Norwegian','Danish','Finnish','Polish','Czech','Hungarian','Romanian','Turkish','Greek','Hebrew','Thai','Vietnamese','Indonesian','Malay'];
const AUDIO_FORMATS  = ['DTS-HD Master Audio','Dolby TrueHD','PCM 5.1','PCM 7.1','Dolby Digital 5.1','DTS 5.1','LPCM Stereo'];
const SUBTITLE_FMTS  = ['SRT','ASS','SSA','SUB','VTT','PGS (Blu-ray Native)'];
const VIDEO_FMTS     = ['H.264 AVC','H.265 HEVC','VC-1','MPEG-2'];
const RESOLUTIONS    = ['1080p (1920×1080)','720p (1280×720)','480p (720×480) — may not play on all Blu-ray players, especially HD-only models','480p (720×576) PAL','4K UHD (3840×2160) — for testing only, NOT BD-ROM spec, will not play on standard Blu-ray players'];
const EXTRAS_TYPES   = ['Behind the Scenes','Deleted Scenes','Interviews','Trailers','Featurette','Short Film','Other'];

const VIDEO_QUALITY_MODES = [
  { id: 'passthrough', label: 'Passthrough',         crf: null, mult: 1.0  },
  { id: 'crf18',       label: 'High Quality (CRF 18)', crf: 18,  mult: 0.75 },
  { id: 'crf20',       label: 'Balanced (CRF 20)',     crf: 20,  mult: 0.55 },
  { id: 'crf23',       label: 'Compact (CRF 23)',      crf: 23,  mult: 0.40 },
];
function videoQualityMult(q) {
  const m = VIDEO_QUALITY_MODES.find(x => x.id === q);
  return m ? m.mult : 1.0;
}

// Tabs route by id (string), not array index — so adding/removing tabs never
// shifts the routing. state.tab holds the active tab id.
const TABS = [
  { id:'project',   icon:'🎬', label:'Project'  },
  { id:'chapters',  icon:'≡',  label:'Chapters' },
  { id:'templates', icon:'🖌', label:'Menus'    },
];

// Factory for a fresh project: the single source of truth for the project
// shape. Loading merges saved data over this so missing fields always get
// defaults (see mergeProjectWithDefaults).
function defaultProject() {
  return {
    title: '', description: '', discLabel: '',
    resolution: RESOLUTIONS[0], videoFormat: VIDEO_FMTS[0], outputDir: '', useSplash: false,
    splashPngPath: null, splashDuration: 5, splashColor: '1a1a2e', useIGMenu: false,
    mainVideo: null,
    titles: [],   // additional video titles on the disc
    discSize: 'BD-25',
    audioTracks: [], subtitleTracks: [], chapters: [], extras: [],
    // Vestigial: the legacy FFmpeg-drawtext menu config. The Menu tab that edited
    // it was removed in v1.15.1 (its backend generateMenuImage was never called).
    // Retained only so older saved project files round-trip through save/load.
    menuConfig: {
      theme: 'Cinematic Dark', title: '', subtitle: '',
      primaryColor: '#dbb85a', accentColor: '#c0392b', fontStyle: 'Helvetica Neue',
      titleSize: 'large', titleAlign: 'center',
      buttonStyle: 'outline', buttonLayout: 'horizontal',
      overlayOpacity: 50, showTitle: true, showChapterMenu: true, showLanguageMenu: true,
      backgroundImage: null, backgroundVideo: null,
      customPlayText: 'PLAY', customChaptersText: 'CHAPTERS', customAudioText: 'AUDIO',
      textStroke: false, textStrokeColor: '#000000', textStrokeWidth: 2,
      showEpisodeMenu: true, showAudioMenu: true, showSubtitleMenu: true, showButtonEmojis: true,
      episodeMenuStyle: 'list',  // 'list' or 'grid'
      logoImage: null,
      // ── Feature 4: Enhanced menu customization ──────────────────────────────
      // Gradient background
      gradientEnabled: false, gradientColor1: '#080810', gradientColor2: '#1a1440', gradientDir: 'vertical',
      // Background image effects
      bgBlur: 0, bgBrightness: 100, bgContrast: 100,
      // Font sizing
      titleFontSize: 48, episodeFontSize: 13, fontWeight: 'bold', letterSpacing: 0,
      // Text shadow
      textShadow: false, textShadowColor: '#000000', textShadowBlur: 4,
      textShadowOffsetX: 2, textShadowOffsetY: 2, textColorOpacity: 100,
      // Button styling
      btnBorderRadius: 4, btnBorderColor: '#dbb85a', btnBorderWidth: 1,
      hoverEffect: 'highlight', // highlight, scale, underline, glow
      episodeSpacing: 8, showEpisodeNumbers: true,
      // Disc title overlay
      discTitleOverlay: false, discTitleText: '', discTitleFontSize: 28,
      discTitleColor: '#dbb85a', discTitlePosition: 'top-center',
      // Animated background
      animatedBg: false, animationType: 'pan', // pan, pulse, particles
    },
    igMenuConfig: {
      bgColor: '#1a1a2e', bgImagePath: null, title: '',
      buttonLabels: [],
      buttonBgColor: '#2a2a4a', buttonTextColor: '#ffffff',
      buttonHighlightColor: '#ff8800', fontFamily: 'MenuFont',
      templateId: 'classic',   // v1.13.0 — drives the menu look (see Templates tab)
    },
    // ── v1.19.0 chapter selection sub-menu ──────────────────────────────────────
    // Auto-enabled when chapters exist; drives the Scene Selection screen. The
    // disc-pipeline wiring is deferred (see PR notes) — this is the project model +
    // designer UI. templateId/positions null = reuse the main menu's.
    chapterMenu: {
      enabled: true,            // effective only when chapters.length > 0
      templateId: null,         // null = use the main menu (igMenuConfig) template
      positions: null,          // null = auto-layout (vertical stack ≤6 / 2-col grid 7+)
      label: 'Scene Selection', // label of the button that opens it from the main menu
    },
  };
}

// ── Project schema ─────────────────────────────────────────────────────────────
// Version stamp written into every saved .dfp. Bump when the project shape
// changes incompatibly. Loading rules (see loadProject): missing → v0 legacy
// (console.warn, defaults fill the gaps); newer than this → warn the user but
// still load what we can; always merge over defaultProject() so no field is
// ever undefined.
const PROJECT_SCHEMA_VERSION = 1;

/**
 * Merge a loaded project over the defaults: every key of `defaults` is
 * present in the result; nested objects merge shallowly over their default;
 * arrays are taken whole (or the default when absent/not an array). Pure —
 * also exercised directly by tests/renderer-logic.test.js.
 */
/**
 * Swap titles[index] with its neighbour in direction dir (-1 up / +1 down).
 * Returns a NEW array; out-of-range moves (first item up, last item down)
 * return an unchanged copy. Pure — exercised by tests/renderer-logic.test.js.
 */
function moveTitle(titles, index, dir) {
  const arr = [...(titles || [])];
  const j = index + dir;
  if (index < 0 || index >= arr.length || j < 0 || j >= arr.length) return arr;
  [arr[index], arr[j]] = [arr[j], arr[index]];
  return arr;
}

function mergeProjectWithDefaults(loaded, defaults) {
  const out = {};
  for (const key of Object.keys(defaults)) {
    const def = defaults[key];
    const val = loaded ? loaded[key] : undefined;
    if (val === undefined || val === null) { out[key] = def; continue; }
    if (Array.isArray(def)) { out[key] = Array.isArray(val) ? val : def; continue; }
    if (def && typeof def === 'object') {
      out[key] = (val && typeof val === 'object' && !Array.isArray(val)) ? { ...def, ...val } : def;
      continue;
    }
    out[key] = val;
  }
  return out;
}

// ── In-app dialogs ──────────────────────────────────────────────────────────────
// Replace native alert()/confirm(): those block the renderer process and look
// foreign next to the app's modal system. showInfo = message + OK;
// showConfirm = message + Cancel/OK, OK runs the callback. The callback lives
// in a module variable (not state) because state must stay JSON-ish.
let _dialogOnConfirm = null;
function showInfo(message, title = 'Disc Forge') {
  _dialogOnConfirm = null;
  setState({ appDialog: { kind: 'info', title, message } });
}
function showConfirm(message, onConfirm, { title = 'Are you sure?', confirmLabel = 'OK', checkboxLabel = null } = {}) {
  _dialogOnConfirm = onConfirm;
  setState({ appDialog: { kind: 'confirm', title, message, confirmLabel, checkboxLabel } });
}
function appDialogHTML() {
  const d = state.appDialog;
  if (!d) return '';
  return `<div class="modal-backdrop"><div class="modal-box">
    <div class="modal-title">${esc(d.title)}</div>
    <div class="modal-sub" style="white-space:pre-wrap">${esc(d.message)}</div>
    ${d.checkboxLabel ? `<label style="display:flex;align-items:center;gap:8px;justify-content:center;cursor:pointer;font-size:12px;color:var(--text-secondary);margin-bottom:12px">
      <input type="checkbox" id="app-dialog-checkbox" style="width:14px;height:14px;cursor:pointer">${esc(d.checkboxLabel)}
    </label>` : ''}
    <div class="modal-actions">
      ${d.kind === 'confirm' ? '<button class="btn btn-ghost" id="app-dialog-cancel">Cancel</button>' : ''}
      <button class="btn btn-primary" id="app-dialog-ok">${esc(d.confirmLabel || 'OK')}</button>
    </div></div></div>`;
}

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  tab: 'project',
  appVersion: '',   // populated on boot from app.getVersion() (package.json)
  lightMode: true,
  menusEnabled: false,
  systemFonts: [],  // populated on boot from installed fonts
  tools: { ffmpeg:{found:false}, ffprobe:{found:false}, tsmuxer:{found:false}, makemkv:{found:false} },
  building: false, buildSteps: [], buildCurrentStep: -1,
  buildDone: false, buildError: null, builtIsoPath: null, ffmpegLog: '',
  buildEndTime: null, stepStartTimes: {}, stepDetails: {},
  crfTotalSecs: 0,   // total duration of current CRF encode (for ETA)
  probeCache: {},    // filePath → { duration, videoBitrate, audioStreams }
  project: defaultProject(),
  // ── v1.13.0 menu templates ────────────────────────────────────────────────
  templates: { builtIn: [], user: [], loaded: false },
  templateEditor: {
    selectedId: 'classic',
    designType: 'vertical', // v1.22.0 — 'vertical' | 'horizontal'; drives the design-first selector (auto-detected on selectTemplate)
    activeMenu: 'main', // v1.19.0 — 'main' | 'chapters' (which menu the designer previews/edits)
    draft: null,        // working copy (object) of the selected template
    baseline: null,     // pristine copy for Revert / dirty detection
    error: null,        // validateTemplate error surfaced inline
    previews: {},       // { menu, normal, selected: dataURL } for selectedId
    previewKey: null,   // hash of the draft the previews were rendered from
    menuRendering: false, // true while the full-screen menu preview is in flight
    advancedPalette: false,
    busy: false,
    nameModal: null,    // {mode:'duplicate'|'saveAs', value} — name-entry modal (Electron lacks window.prompt)
    // v1.16.0 thumbnail browser + design editor
    thumbs: {},         // id → full-res preview dataURL (cached, scaled into card canvases)
    fullTemplates: {},  // id → loaded template object (for thumbnail rendering)
    savedFlash: false,  // shows "Saved ✓" briefly after a successful save
    fontFilter: '',     // search text for the font-family dropdown
    // ── v1.18.0 interactive layout editor ──────────────────────────────────────
    livePositions:    null,   // {x,y}[] | null — working copy during drag/between renders
    selectedBtn:      -1,     // index of selected button (-1 = none)
    hoveredBtn:       -1,     // index of hovered button (-1 = none)
    deletedBtns:      [],     // indices hidden via Delete/✕ in the layout editor (preview-only; see _deleteSelectedButton)
    dragging:         false,
    dragOffsetX:      0,
    dragOffsetY:      0,
    showGrid:         false,
    gridSize:         32,
    showSafeAreas:    true,
    showCenter:       true,
  },
  form: {
    audio:    { lang:LANGUAGES[0], fmt:AUDIO_FORMATS[0], label:'', isDefault:false, file:null },
    subtitle: { lang:LANGUAGES[0], fmt:SUBTITLE_FMTS[0], isForced:false, isSDH:false, description:'', file:null },
    chapter:  { name:'', time:'00:00:00', thumb:null },
    extras:   { name:'', type:EXTRAS_TYPES[0], file:null },
  },
  probeData: null,
  embeddedTracks: [],   // auto-detected tracks from added video files
  titleCompatibility: {}, // map of filePath → { compatible, mode, videoCodec, bitrateMbps, reasons }
  burning: false, burnStatus: null, burnMessage: '', burnDone: false, burnError: null,
  burnDriveInfo: null, burnPercent: null,
  // Show onboarding on first launch, unless the user ticked "Don't show again".
  // Persisted alongside other app prefs in localStorage (see disc-forge-theme).
  showWelcome: localStorage.getItem('disc-forge-hide-welcome') !== '1',
  showAbout: false,
};

function uid()      { return Math.random().toString(36).slice(2,9); }
function setState(p){
  Object.assign(state, p);
  // Renders synchronously: tab switches, checkboxes, button clicks must
  // respond immediately. TEXT input goes through setPrjText/setPrjBatched
  // instead, which batch per-keystroke renders via scheduleRender().
  render();
}
function setPrj(p)  { setState({ project: { ...state.project, ...p } }); }
// Text-input path (A1): state updates synchronously on every keystroke, but
// the DOM rebuild is batched to the end of the tick via scheduleRender(),
// which captures focus/caret right before rendering — same restore mechanism
// as before (attachListeners), captured later and therefore more accurately.
function setPrjText(p) {
  Object.assign(state, { project: { ...state.project, ...p } });
  scheduleRender();
}
const setPrjBatched = setPrjText;
function setForm(t,p){ setState({ form: { ...state.form, [t]: { ...state.form[t], ...p } } }); }
function esc(s)     { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  const tools    = await window.discForge.checkTools();
  const homeDir  = await window.discForge.getHomeDir();
  const outputDir = homeDir + '/Desktop';
  const appVersion = await window.discForge.getAppVersion().catch(() => '');
  setState({ tools, appVersion, project: { ...state.project, outputDir } });
  refreshRecents();  // recent-projects list for the welcome screen (non-blocking)
  ensureMenuFont();  // warm the menu-preview font (non-blocking)

  // Load installed system fonts (enumerated once in the main process via font-list).
  // availableFonts() falls back to SAFE_FONTS when this comes back empty.
  try {
    const fonts = await window.discForge.getSystemFonts();
    state.systemFonts = Array.isArray(fonts) ? fonts : [];
  } catch(e) {
    state.systemFonts = [];
  }
  loadTemplates();  // v1.13.0 — populate the Templates tab + build-flow dropdown
  window.discForge.onBuildProgress(handleBuildProgress);
  window.discForge.onFFmpegProgress(line => {
    // CRF encode total-duration sentinel — don't display, just store
    if (line.startsWith('__CRF_START:')) {
      state.crfTotalSecs = parseFloat(line.slice(12)) || 0;
      return;
    }
    // Parse FFmpeg CRF progress line (frame= fps= time= speed=)
    const timeMatch  = line.match(/time=(\d{2}):(\d{2}):([\d.]+)/);
    const speedMatch = line.match(/speed=\s*([\d.]+)x/);
    const fpsMatch   = line.match(/fps=\s*([\d.]+)/);
    const frameMatch = line.match(/frame=\s*(\d+)/);
    if (state.crfTotalSecs > 0 && timeMatch) {
      const currentSecs = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
      const speed = speedMatch ? parseFloat(speedMatch[1]) : 0;
      const fps   = fpsMatch   ? parseFloat(fpsMatch[1])   : 0;
      const frame = frameMatch ? parseInt(frameMatch[1])    : 0;
      let etaStr = '';
      if (speed > 0.01 && state.crfTotalSecs > currentSecs) {
        const remSecs = Math.round((state.crfTotalSecs - currentSecs) / speed);
        if (remSecs > 3) etaStr = ' — ~' + Math.floor(remSecs / 60) + 'm ' + (remSecs % 60) + 's left';
      }
      const pct = state.crfTotalSecs > 0 ? Math.min(100, (currentSecs / state.crfTotalSecs * 100)).toFixed(0) : 0;
      state.ffmpegLog = `CRF encode ${pct}%` + (fps > 0 ? ` · ${fps.toFixed(0)} fps` : '') + (frame > 0 ? ` · frame ${frame}` : '') + etaStr;
    } else {
      if (!timeMatch) state.crfTotalSecs = 0;  // non-progress line resets CRF tracking
      state.ffmpegLog = line;
    }
    const el = document.getElementById('ffmpeg-log');
    if (el) { el.textContent = state.ffmpegLog; }
    appendLog(line);
  });

  // Apply light mode on startup
  const savedTheme = localStorage.getItem('disc-forge-theme');
  if (savedTheme === 'light') state.lightMode = true;
  else if (savedTheme === 'dark') state.lightMode = false;
  document.body.classList.toggle('light-mode', state.lightMode);

  // Non-blocking update check (slight delay so it never blocks first paint).
  setTimeout(checkForUpdate, 3000);
}

// ── Update checker (v1.19.0) ──────────────────────────────────────────────────
// Queries the latest GitHub release on boot and shows a dismissible banner when a
// newer version is available. Fails silently on any network/parse error.
async function checkForUpdate() {
  try {
    const current = state.appVersion; // already populated on boot
    const { latestVersion, releaseUrl } = await window.discForge.checkForUpdate();
    if (!latestVersion || !current) return;
    // Simple numeric semver comparison — split on dots, compare major/minor/patch.
    const parse = v => v.split('.').map(Number);
    const [cMaj, cMin, cPatch] = parse(current);
    const [lMaj, lMin, lPatch] = parse(latestVersion);
    const isNewer =
      lMaj > cMaj ||
      (lMaj === cMaj && lMin > cMin) ||
      (lMaj === cMaj && lMin === cMin && lPatch > cPatch);
    if (isNewer) showUpdateBanner(latestVersion, releaseUrl);
  } catch {}
}

function showUpdateBanner(version, url) {
  if (document.getElementById('update-banner')) return; // don't show twice
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.innerHTML = `
    <span>⬆ Disc Forge ${version} is available.</span>
    <a id="update-download-link" href="#">Download</a>
    <button id="update-dismiss">✕</button>`;
  document.body.appendChild(banner);
  document.getElementById('update-download-link')
    .addEventListener('click', (e) => {
      e.preventDefault();
      if (url) window.discForge.openExternal(url);
    });
  document.getElementById('update-dismiss')
    .addEventListener('click', () => banner.remove());
}

// ── File pickers ──────────────────────────────────────────────────────────────
async function pickFile(filters) {
  const r = await window.discForge.openFileDialog({ filters });
  if (!r) return null;
  // Normalize: may be string (old) or { path, name, size } (new)
  if (typeof r === 'string') return { path: r, name: r.split('/').pop(), size: 0 };
  return r;
}
async function pickChapterThumb() {
  const r = await pickFile([{ name:'Image', extensions:['png','jpg','jpeg','webp'] }]);
  if (r) setForm('chapter', { thumb: r });
}
async function pickOutputDir() {
  const d = await window.discForge.openFolderDialog();
  if (d) setPrj({ outputDir:d });
}

// ── Chapter add/remove ─────────────────────────────────────────────────────────
function addChapter() {
  const f = state.form.chapter; if (!f.name||!f.time) return;
  const chapters = [...state.project.chapters, { id:uid(), name:f.name, time:f.time, thumb:f.thumb }]
    .sort((a,b)=>a.time.localeCompare(b.time));
  setPrj({ chapters });
  setForm('chapter', { name:'', time:'00:00:00', thumb:null });
}
const rmChapter  = id => setPrj({ chapters:       state.project.chapters.filter(t=>t.id!==id) });

// ── Feature 2: Generate chapter thumbnails ────────────────────────────────────
async function generateChapterThumbnails() {
  const p = state.project;
  const videoPath = p.mainVideo?.path || (p.titles && p.titles[0]?.file?.path);
  if (!videoPath) { showInfo('Please add a video file first.'); return; }
  if (p.chapters.length === 0) { showInfo('No chapters defined.'); return; }

  const homeDir = await window.discForge.getHomeDir();
  const thumbDir = homeDir + '/.discforge_thumbs';
  let generated = 0;

  for (const ch of p.chapters) {
    try {
      const outPath = `${thumbDir}/${ch.id}.jpg`;
      const result = await window.discForge.generateChapterThumbnail(videoPath, ch.time, outPath);
      if (result.success) {
        const updated = state.project.chapters.map(c =>
          c.id === ch.id ? { ...c, thumb: { path: result.path, name: `${ch.name}.jpg` } } : c
        );
        state.project = { ...state.project, chapters: updated };
        generated++;
        render();
      }
    } catch(_) {}
  }
  if (generated > 0) render();
}

// ── Build ──────────────────────────────────────────────────────────────────────
async function startBuild() {
  if (state.building) return;
  const p = state.project;
  if (!p.title || (!p.mainVideo && !(p.titles&&p.titles.length>0))) return;

  // ── Disc capacity warning ──────────────────────────────────────────────────
  const BD25_BYTES = 23.3e9;  // usable capacity
  const BD50_BYTES = 46.6e9;
  const allTitleFiles = [
    ...(p.mainVideo ? [{ path: p.mainVideo.path, size: p.mainVideo.size || 0, quality: p.mainVideo.videoQuality }] : []),
    ...(p.titles || []).map(t => ({ path: t.file?.path, size: t.file?.size || 0, quality: t.videoQuality })),
  ];
  let estBytes = 0;
  for (const { path: fp, size, quality } of allTitleFiles) estBytes += estimateTitleBytes(fp, size, quality);
  estBytes = Math.round(estBytes * 1.1);
  const estGb = (estBytes / 1e9).toFixed(1);
  if (estBytes > BD50_BYTES) {
    showConfirm(`⚠ Estimated disc size (~${estGb} GB) exceeds BD-50 capacity (46.6 GB).\n\nConsider splitting into multiple discs. Continue anyway?`,
      () => _startBuildNow(p), { title: 'Disc Capacity Warning', confirmLabel: 'Continue Anyway' });
    return;
  } else if (estBytes > BD25_BYTES && (p.discSize === 'BD-25' || !p.discSize)) {
    showConfirm(`⚠ Estimated disc size (~${estGb} GB) exceeds BD-25 capacity (23.3 GB).\n\nTip: Switch to BD-50 in the sidebar, or split into multiple discs. Continue anyway?`,
      () => _startBuildNow(p), { title: 'Disc Capacity Warning', confirmLabel: 'Continue Anyway' });
    return;
  }
  return _startBuildNow(p);
}

// The build proper — runs after startBuild's capacity gate (directly, or from
// the in-app confirm dialog's callback when the estimate exceeds capacity).
async function _startBuildNow(p) {
  const additionalTitles = p.titles || [];
  const steps = [
    'Muxing main feature audio tracks', 'Validating mux output',
    'Generating menu image', 'Building disc structure',
    ...additionalTitles.map((t, i) => `Processing title ${i + 2}: ${(t.label || t.file?.name || 'Title').slice(0, 35)}`),
    ...(p.extras.length > 0 ? ['Processing special features'] : []),
    'Writing tsMuxeR project', 'Running tsMuxeR', 'Packaging ISO image',
  ];
  state.buildStartTime = Date.now();
  state.buildEndTime = null;
  state.stepStartTimes = {};
  state.stepDetails = {};
  setState({ building:true, buildSteps:steps, buildCurrentStep:0, buildDone:false, buildError:null, builtIsoPath:null, ffmpegLog:'', vlcMsg:null });
  // Include enabled embedded tracks alongside manual tracks
  const includedEmbedded = (state.embeddedTracks||[]).filter(t => t.included !== false);
  const embeddedAudio = includedEmbedded.filter(t => t.role==='audio');
  const embeddedSubs  = includedEmbedded.filter(t => t.role==='subtitle');
  // Passthrough mode: skip FFmpeg mux if main video is BD-compatible AND not CRF-encoding
  const mainCompat = state.titleCompatibility?.[p.mainVideo?.path];
  const mainHasCrf = p.mainVideo?.videoQuality && p.mainVideo.videoQuality !== 'passthrough';
  const buildProject = {
    ...p,
    // menusEnabled lives on state (not project p); forward it so single-title
    // buildDisc can author an interactive menu (it gates on menusEnabled+useIGMenu).
    menusEnabled: state.menusEnabled || false,
    passThroughMode: mainCompat?.compatible === true && !p.forceTranscode && !mainHasCrf,
    forceTranscode: p.forceTranscode || false,
    audioTracks: [
      ...(p.audioTracks||[]).filter(t => !t.excluded),
      ...embeddedAudio.map(t => ({ ...t, file: { path: t.sourceFile, name: t.sourceFileName }, embedded: true })),
    ],
    subtitleTracks: [
      ...(p.subtitleTracks||[]).filter(t => !t.excluded),
      ...embeddedSubs.map(t => ({ ...t, file: { path: t.sourceFile, name: t.sourceFileName }, embedded: true })),
    ],
  };
  // Multi-title routing: 2+ video sources (mainVideo + titles) → per-episode mux pipeline
  // Build per-episode objects: path + audio tracks from the assembled buildProject tracks
  const mainEpPath  = p.mainVideo?.path;
  const allEpisodes = [
    ...(mainEpPath ? [{
      path: mainEpPath,
      audioTracks: buildProject.audioTracks.filter(t => {
        const tp = t.file?.path;
        return !tp || tp === mainEpPath;
      }),
      subtitleTracks: buildProject.subtitleTracks.filter(t => {
        const tp = t.file?.path;
        return !tp || tp === mainEpPath;
      }),
    }] : []),
    ...((p.titles || []).map(t => {
      const ep = t.file?.path;
      if (!ep) return null;
      return {
        path: ep,
        audioTracks: buildProject.audioTracks.filter(at => at.file?.path === ep),
        subtitleTracks: buildProject.subtitleTracks.filter(st => st.file?.path === ep),
      };
    }).filter(Boolean)),
  ];
  let result;
  if (allEpisodes.length >= 2) {
    appendLog(`[Renderer] Multi-title routing: ${allEpisodes.length} episodes → buildMultiTitleDisc`);
    result = await window.discForge.buildMultiTitleDisc({
      episodes: allEpisodes,
      outputDir: p.outputDir,
      discName: p.title,
      fastEncode: false,
      resolution: p.resolution || '1080p (1920×1080)',
      useSplash: p.useSplash || false,
      splashPngPath: p.splashPngPath || null,
      splashDuration: p.splashDuration || 5,
      splashColor: p.splashColor || '1a1a2e',
      useIGMenu: state.menusEnabled && (p.useIGMenu || false),
      menusEnabled: state.menusEnabled || false,
      igMenuConfig: p.igMenuConfig || {},
    });
  } else {
    appendLog(`[Renderer] Single-title routing → buildDisc`);
    result = await window.discForge.buildDisc(buildProject);
  }
  if (result.error) setState({ buildError: result.error });
}
function appendLog(msg) {
  const el = document.getElementById('build-log-panel');
  if (el) {
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
  }
}

function handleBuildProgress(data) {
  if (data.done) {
    state.buildEndTime = Date.now();
    setState({ buildDone:true, builtIsoPath:data.isoPath, builtIsoSize:data.isoSize||0 });
  } else if (data.step !== undefined) {
    const stepIdx = data.step;
    // Record start time for this step if not already set
    if (!state.stepStartTimes[stepIdx]) {
      state.stepStartTimes = { ...state.stepStartTimes, [stepIdx]: Date.now() };
    }
    // Store file-size detail for the previous step if provided
    if (data.detail !== undefined) {
      state.stepDetails = { ...state.stepDetails, [stepIdx]: data.detail };
    }
    setState({ buildCurrentStep: stepIdx });
  }
}
function closeBuildModal() {
  window.discForge.removeAllListeners('build-progress');
  window.discForge.removeAllListeners('ffmpeg-progress');
  window.discForge.onBuildProgress(handleBuildProgress);
  window.discForge.onFFmpegProgress(line => { state.ffmpegLog=line; const el=document.getElementById('ffmpeg-log'); if(el) el.textContent=line; });
  state.buildEndTime = null;
  state.stepStartTimes = {};
  state.stepDetails = {};
  setState({ building:false, buildDone:false, buildError:null, vlcMsg:null });
}
function revealISO() { if (state.builtIsoPath) window.discForge.revealInFinder(state.builtIsoPath); }
async function previewInVLC() {
  if (!state.builtIsoPath) return;
  setState({ vlcMsg: 'Opening in VLC…' });
  const r = await window.discForge.openInVLC(state.builtIsoPath);
  // Success: VLC takes the foreground, so clear the transient message.
  // Failure (e.g. VLC not installed): keep the explanation inline.
  setState({ vlcMsg: r && r.success ? null : (r && r.error) || 'Could not open VLC.' });
}

// ── Probe cache ────────────────────────────────────────────────────────────────
function cacheProbeData(filePath, data) {
  if (!data || !filePath) return;
  const vs = data.streams?.find(s => s.codec_type === 'video');
  const audioStreams = (data.streams || [])
    .filter(s => s.codec_type === 'audio')
    .map(s => ({ codec: s.codec_name || '', bitrate: parseInt(s.bit_rate || 0) }));
  const duration = parseFloat(data.format?.duration || 0);
  const videoBitrate = parseInt(vs?.bit_rate || data.format?.bit_rate || 0);
  state.probeCache = { ...state.probeCache, [filePath]: { duration, videoBitrate, audioStreams } };
}

// Estimate output bytes for a single video file using probe data.
// Video is stream-copied; FLAC/LPCM/TrueHD audio is transcoded to AC3 640kbps.
const LOSSLESS_CODECS = ['flac','pcm_s24le','pcm_s16le','pcm_s32le','pcm_blu','truehd','mlp','dts-hd'];
function estimateTitleBytes(filePath, fileSize, videoQuality) {
  const mult = videoQualityMult(videoQuality);
  const cached = state.probeCache?.[filePath];
  if (!cached || !cached.duration) {
    // No probe data — fall back to 60% of source file size, with quality multiplier
    return (fileSize || 0) * 0.6 * mult;
  }
  const dur = cached.duration;
  // Video: apply quality multiplier (CRF reduces video size)
  const videoBytes = (cached.videoBitrate || 0) * dur / 8;
  // Audio: lossless → AC3 640kbps; otherwise use actual bitrate (unchanged by CRF)
  let audioBytes = 0;
  const audioStreams = cached.audioStreams || [];
  for (const as of audioStreams) {
    const isLossless = LOSSLESS_CODECS.some(c => as.codec.toLowerCase().includes(c));
    if (isLossless || !as.bitrate) {
      audioBytes += 640000 * dur / 8;  // AC3 at 640kbps
    } else {
      audioBytes += as.bitrate * dur / 8;
    }
  }
  if (audioStreams.length === 0) audioBytes = 640000 * dur / 8;
  // Subtitles: 50MB flat per title (unchanged by CRF)
  const subBytes = 50 * 1e6;
  return videoBytes * mult + audioBytes + subBytes;
}

// ── Probe helper ───────────────────────────────────────────────────────────────
function probeDisplay() {
  const d = state.probeData; if (!d) return '';
  const vs = d.streams?.find(s=>s.codec_type==='video');
  const as = d.streams?.find(s=>s.codec_type==='audio');
  const dur = d.format?.duration ? `${Math.floor(d.format.duration/60)}m ${Math.floor(d.format.duration%60)}s` : '?';
  const size= d.format?.size ? `${(d.format.size/1e9).toFixed(2)} GB` : '?';
  const items = [
    ['Duration', dur], ['Size', size],
    ...(vs ? [['Video', `${vs.codec_name?.toUpperCase()} ${vs.width}×${vs.height}`]] : []),
    ...(as ? [['Audio', `${as.codec_name?.toUpperCase()} ${as.channel_layout||''}`]] : []),
    ['Bitrate', d.format?.bit_rate ? Math.round(d.format.bit_rate/1e6)+'Mbps' : '?'],
  ];
  return `<div class="probe-panel">${items.map(([k,v])=>`<div class="probe-item"><div class="probe-key">${k}</div><div class="probe-val">${esc(v)}</div></div>`).join('')}</div>`;
}

// ── v1.13.0 Menu Templates ──────────────────────────────────────────────────────
// Populate the Menus tab list + build-flow dropdown, then select a template (which
// triggers the live preview). (Restored in v1.15.1 — this was accidentally removed
// by the v1.15.1 tab-cleanup deletion, which left the Menus list stuck on "Loading…".)
async function loadTemplates() {
  const r = await window.discForge.templateList();
  if (!r || !r.ok) { appendLog('[Templates] list failed: ' + (r && r.error)); return; }
  state.templates = { builtIn: r.builtIn || [], user: r.user || [], loaded: true };
  const all = [...state.templates.builtIn, ...state.templates.user];
  if (!all.find(t => t.id === state.templateEditor.selectedId)) {
    state.templateEditor.selectedId = all[0] ? all[0].id : 'classic';
  }
  render();
  selectTemplate(state.templateEditor.selectedId);
}

function templateMeta(id) {
  return [...(state.templates.builtIn || []), ...(state.templates.user || [])].find(t => t.id === id) || null;
}
function isReadonly(id) { const m = templateMeta(id); return m ? m.readonly : true; }

async function selectTemplate(id) {
  const r = await window.discForge.templateLoad(id);
  if (!r || !r.ok) { appendLog('[Templates] load failed: ' + (r && r.error)); return; }
  const ed = state.templateEditor;
  ed.selectedId = id;
  ed.draft = r.template;
  ed.baseline = JSON.parse(JSON.stringify(r.template));
  // Auto-detect the design type from the selected template's layout so the
  // design toggle reflects the active template (e.g. on first load).
  ed.designType = (r.template.button && r.template.button.layout === 'horizontal') ? 'horizontal' : 'vertical';
  ed.error = null;
  ed.previews = {};
  ed.previewKey = null;
  // Fresh layout-editor state for the newly selected template (positions are
  // copied lazily from template.button.positions on first drag).
  ed.livePositions = null;
  ed.selectedBtn = -1;
  ed.hoveredBtn = -1;
  ed.dragging = false;
  ed.deletedBtns = [];   // freshly-selected template shows all sample buttons
  render();
  refreshPreviews();
}

// ── Editor: validation + live preview (debounced) ────────────────────────────────
let _previewTimer = null;
function scheduleValidateAndPreview() {
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(refreshPreviews, 200);  // debounce 200ms
}
async function refreshPreviews() {
  const ed = state.templateEditor;
  const tpl = ed.draft;
  if (!tpl) return;
  // Validate first; on failure the preview pane shows the error instead of rendering.
  const v = await window.discForge.templateValidate(tpl);
  if (!v || !v.ok) {
    ed.error = (v && v.error) || 'invalid template';
    ed.previews = {};
    render();
    return;
  }
  ed.error = null;
  // Render the isolated Normal/Selected button states client-side (browser canvas)
  // — no native module / IPC, so it works on every machine.
  let selected = null, normal = null;
  try {
    await ensureMenuFont();
    selected = renderButtonPreviewLocal(tpl, tpl.button.selectedFill, 'Play Episode 1');
    normal   = renderButtonPreviewLocal(tpl, tpl.button.normalFill,   'Play Episode 2');
  } catch (_) { /* leave nulls — the full-screen preview below is the primary view */ }
  // Keep any prior full-screen menu image while the heavier render re-runs.
  ed.previews = { ...ed.previews, selected, normal };
  render();
  // The full-screen menu scene is heavier — render it on its own 400ms debounce.
  scheduleMenuPreview();
}

// The full-screen 1920×1080 menu preview is heavier than the button crops, so it
// gets a longer 400ms debounce and a "Rendering…" caption while in flight. A
// sequence guard drops stale results so the last edit always wins.
let _menuTimer = null;
let _menuSeq = 0;
function scheduleMenuPreview() {
  clearTimeout(_menuTimer);
  state.templateEditor.menuRendering = true;
  render();  // caption flips to "Rendering…"
  _menuTimer = setTimeout(renderMenuPreview, 400);
}
async function renderMenuPreview() {
  const ed = state.templateEditor;
  const tpl = ed.draft;
  if (!tpl || ed.error) { ed.menuRendering = false; render(); return; }
  const seq = ++_menuSeq;
  let dataUrl = null;
  try {
    // v1.19.0: the menu switcher chooses which menu the TV bezel previews.
    dataUrl = (ed.activeMenu === 'chapters')
      ? await renderChapterMenuPreviewLocal(tpl, state.project.chapters)
      : await renderMenuPreviewLocal(tpl, ed.deletedBtns);
  } catch (_) {
    dataUrl = null;  // never leave the pane stuck — fall back to the button states
  }
  if (seq !== _menuSeq) return;  // a newer render started — drop this stale result
  ed.menuRendering = false;
  ed.previews = { ...ed.previews, menu: dataUrl };
  render();
}

// ── Client-side menu preview rendering ──────────────────────────────────────────
// The preview is drawn entirely in the renderer with the browser's built-in
// Canvas, so it never depends on the main-process native node-canvas module —
// which macOS Gatekeeper blocks on unsigned, downloaded (quarantined) apps,
// leaving the old IPC-based preview hung on "Rendering…". This mirrors the disc
// menu: background (image-cover or solid colour) + buttons, with the label drawn
// in the border/text palette colour (matching how the disc quantises white text).
let _menuFontPromise = null;
function ensureMenuFont() {
  if (_menuFontPromise) return _menuFontPromise;
  _menuFontPromise = (async () => {
    try {
      if (typeof FontFace === 'undefined' || !document.fonts) return false;
      const face = new FontFace('MenuFont', "url('assets/fonts/MenuFont.ttf')");
      await face.load();
      document.fonts.add(face);
      return true;
    } catch (_) { return false; }  // fall back to a system font
  })();
  return _menuFontPromise;
}

function _yuvCss(e) {
  const [r, g, b] = window.discForge.color.yuvToRgb(e.Y, e.Cr, e.Cb);
  return `rgb(${r},${g},${b})`;
}
function _fillCss(tpl, fill) {
  if (fill && Array.isArray(fill.rgb)) return `rgb(${fill.rgb[0]},${fill.rgb[1]},${fill.rgb[2]})`;
  const e = tpl.palette.find(p => p.id === (fill && fill.entry));
  return e ? _yuvCss(e) : '#888';
}

// Trace a button outline (rounded-rect / pill / rect) — mirrors menu-builder's
// _buttonShapePath so the client preview matches the disc render.
function _btnShapePath(ctx, x, y, w, h, shape, cornerRadius) {
  const r = shape === 'pill' ? Math.min(h / 2, w / 2)
          : shape === 'rounded' ? Math.max(0, Math.min(cornerRadius || 16, Math.min(w, h) / 2))
          : 0;
  ctx.beginPath();
  if (r === 0) { ctx.rect(x, y, w, h); return; }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Draw one button (fill + border + centered label) at (x,y) on ctx.
function drawTemplateButton(ctx, tpl, fill, label, x, y, opts = {}) {
  const b = tpl.button;
  const w = b.width, h = b.height, border = b.border || 0;
  // fillAlpha (v1.23.0) lets the chapter-thumbnail preview draw buttons as
  // transparent overlays — border + label only — so the frame grab shows through,
  // mirroring the disc (IG buttons are transparent over the thumbnail background).
  // Default 1 keeps every existing caller byte-identical (opaque fill).
  const fillAlpha = (typeof opts.fillAlpha === 'number') ? opts.fillAlpha : 1;
  const shape = (b.shape === 'rounded' || b.shape === 'pill') ? b.shape : 'rect';
  const be = tpl.palette.find(e => e.id === b.borderEntry) || tpl.palette[1] || tpl.palette[0];
  const beCss = _yuvCss(be);

  // Horizontal studio-bar button: fill tile + circular icon placeholder on top + a
  // label below. Mirrors renderButtonBitmap's horizontal path in menu-builder.js.
  if (b.layout === 'horizontal') {
    ctx.fillStyle = _fillCss(tpl, fill);
    if (shape === 'rect') ctx.fillRect(x, y, w, h);
    else { _btnShapePath(ctx, x, y, w, h, shape, b.cornerRadius); ctx.fill(); }
    if (border > 0) {  // thin frame in the border/text color
      ctx.strokeStyle = beCss;
      ctx.lineWidth = border;
      if (shape === 'rect') ctx.strokeRect(x + border / 2, y + border / 2, w - border, h - border);
      else { _btnShapePath(ctx, x + border / 2, y + border / 2, w - border, h - border, shape, b.cornerRadius); ctx.stroke(); }
    }
    // Icon ring (top ~60%): lighter fill + border-color stroke.
    const iconD = b.iconSize || 52;
    const cx = x + w / 2, cy = y + Math.round(h * 0.34);
    ctx.beginPath();
    ctx.arc(cx, cy, iconD / 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = beCss;
    ctx.stroke();
    // Label centered in the bottom band.
    const labelSize = Math.max(10, Math.round(h * 0.30 * ((tpl.font && tpl.font.sizeRatio) || 0.5)));
    const famH = (tpl.font && tpl.font.family) ? `"${tpl.font.family}", ` : '';
    ctx.fillStyle = beCss;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${labelSize}px ${famH}MenuFont, "Helvetica Neue", Arial, sans-serif`;
    if (label) ctx.fillText(label, x + w / 2, y + Math.round(h * 0.80));
    return;
  }

  ctx.fillStyle = _fillCss(tpl, fill);
  if (shape === 'rect') {
    if (fillAlpha > 0) {
      ctx.save(); ctx.globalAlpha = fillAlpha; ctx.fillRect(x, y, w, h); ctx.restore();
    }
    if (border > 0) {  // 4 inset bars so the thickness matches the disc
      ctx.fillStyle = beCss;
      ctx.fillRect(x, y, w, border);
      ctx.fillRect(x, y + h - border, w, border);
      ctx.fillRect(x, y, border, h);
      ctx.fillRect(x + w - border, y, border, h);
    }
  } else {
    if (fillAlpha > 0) {
      ctx.save(); ctx.globalAlpha = fillAlpha;
      _btnShapePath(ctx, x, y, w, h, shape, b.cornerRadius);
      ctx.fill();
      ctx.restore();
    }
    if (border > 0) {  // stroke the same outline, inset so it stays inside the shape
      ctx.strokeStyle = beCss;
      ctx.lineWidth = border;
      _btnShapePath(ctx, x + border / 2, y + border / 2, w - border, h - border, shape, b.cornerRadius);
      ctx.stroke();
    }
  }
  // On the disc, white label text quantises to the border/text entry — use it here.
  const fontSize = Math.max(1, Math.round((h - border * 2) * ((tpl.font && tpl.font.sizeRatio) || 0.5)));
  ctx.fillStyle = beCss;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // The chosen font.family (if any) leads the stack so the preview reflects the
  // user's pick; MenuFont stays as the fallback (the disc encoder always uses it).
  const fam = (tpl.font && tpl.font.family) ? `"${tpl.font.family}", ` : '';
  ctx.font = `${fontSize}px ${fam}MenuFont, "Helvetica Neue", Arial, sans-serif`;
  if (label) ctx.fillText(label, x + w / 2, y + h / 2 + 1);
}

function renderButtonPreviewLocal(tpl, fill, label) {
  const b = tpl.button;
  const cv = document.createElement('canvas');
  cv.width = b.width; cv.height = b.height;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  drawTemplateButton(ctx, tpl, fill, label, 0, 0);
  return cv.toDataURL('image/png');
}

function _loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const t = setTimeout(() => reject(new Error('image timeout')), 5000);
    img.onload  = () => { clearTimeout(t); resolve(img); };
    img.onerror = () => { clearTimeout(t); reject(new Error('image error')); };
    img.src = src;
  });
}

// Custom background image (v1.21.0): the app userData/backgrounds dir, fetched
// once at startup. Templates store only a filename (background.file); the renderer
// joins it onto _bgDir to build a path the main process can read for previews.
let _bgDir = null;
(async () => { try { _bgDir = await window.discForge.bgGetDir(); } catch (_) {} })();

// Resolve a background block to a path the main process can read (getImageDataUrl):
// the portable `file` (→ _bgDir/file) wins; else the legacy absolute imagePath.
function _bgRef(bg) {
  if (!bg) return '';
  if (typeof bg.file === 'string' && bg.file.trim()) return _bgDir ? (_bgDir + '/' + bg.file) : '';
  return _bgImagePath(bg.imagePath);
}

// Canvas-side fit math — a byte-for-byte mirror of computeBackgroundDrawRect() in
// src/lib/menu-builder.js so the preview matches the disc encoder's fit handling.
function _bgDrawRect(fit, iw, ih, FW, FH) {
  if (!iw || !ih) return { dx: 0, dy: 0, dw: FW, dh: FH };
  if (fit === 'stretch') return { dx: 0, dy: 0, dw: FW, dh: FH };
  const scale = fit === 'contain' ? Math.min(FW / iw, FH / ih) : Math.max(FW / iw, FH / ih);
  const dw = iw * scale, dh = ih * scale;
  return { dx: (FW - dw) / 2, dy: (FH - dh) / 2, dw, dh };
}

// Auto-layout positions for the preview — a byte-identical mirror of
// computeAutoPositions() in src/lib/menu-builder.js. The two MUST NOT drift, so
// the preview shows exactly where the disc encoder will place each button.
function _autoPositions(count, bw, bh, gap, fw = 1920, fh = 1080) {
  // Object form (v1.22.0): _autoPositions(tpl, n) — horizontal studio-bar layout.
  // MUST stay byte-identical to computeAutoPositions() in src/lib/menu-builder.js.
  if (count && typeof count === 'object') {
    const tpl = count;
    const b = tpl.button || {};
    const n = (bw != null) ? bw : (b.count != null ? b.count : (b.layout === 'horizontal' ? 4 : 3));
    const FW = 1920, FH = 1080;
    if (b.layout === 'horizontal') {
      const barH = (b.barHeight != null) ? b.barHeight : 140;
      const barY = FH - barH;
      const totalW = n * b.width + (n - 1) * b.gap;
      const startX = Math.round((FW - totalW) / 2);
      const buttonY = Math.round(barY + (barH - b.height) / 2);
      return Array.from({ length: n }, (_, i) => ({ x: startX + i * (b.width + b.gap), y: buttonY }));
    }
    return _autoPositions(n, b.width, b.height, b.gap, FW, FH);
  }
  const totalH = count * bh + (count - 1) * gap;
  const startY = Math.round((fh - totalH) / 2);
  const startX = Math.round((fw - bw) / 2);
  return Array.from({ length: count }, (_, i) => ({
    x: startX,
    y: startY + i * (bh + gap),
  }));
}

// Resolve the 3 sample-button positions for a template: stored positions win,
// missing/null entries fall back to auto-layout. Used by both the preview render
// and the interactive overlay so they always agree.
function _resolvePreviewPositions(tpl) {
  const b = tpl.button;
  // Horizontal layout: a centered row of `count` (default 4) buttons in the bar.
  // Stored positions don't apply to the row layout — it's auto-placed.
  if (b.layout === 'horizontal') {
    return _autoPositions(tpl, b.count != null ? b.count : 4);
  }
  const auto = _autoPositions(3, b.width, b.height, b.gap);
  const stored = Array.isArray(b.positions) ? b.positions : null;
  return auto.map((a, i) =>
    (stored && stored[i] && stored[i].x != null) ? { x: stored[i].x, y: stored[i].y } : { ...a }
  );
}

async function renderMenuPreviewLocal(tpl, hiddenIdx = []) {
  const FW = 1920, FH = 1080;
  const cv = document.createElement('canvas');
  cv.width = FW; cv.height = FH;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  await ensureMenuFont();

  // Background: a real image (drawn to cover) wins; else the solid colour. The
  // image is fetched as a data: URL via the main process so the canvas isn't
  // tainted (a file:// image would make toDataURL throw).
  await _drawPreviewBackground(ctx, tpl, FW, FH);

  const b = tpl.button;
  // Horizontal layout: draw the studio bar behind the buttons, then a centered row.
  _drawMenuBar(ctx, tpl, FW, FH);

  const pos = _resolvePreviewPositions(tpl);
  const samples = (b.layout === 'horizontal')
    ? _horizontalSamples(b)
    : [
        [b.normalFill,   'Play Movie'],
        [b.selectedFill, 'Scene Selection'],
        [b.normalFill,   'Special Features'],
      ];
  samples.forEach(([fill, label], i) => {
    if (hiddenIdx.includes(i)) return;   // button deleted in the layout editor
    if (!pos[i]) return;
    drawTemplateButton(ctx, tpl, fill, label, pos[i].x, pos[i].y);
  });
  return cv.toDataURL('image/png');
}

// Studio-bar fill (horizontal layout only). Drawn before the buttons so they sit on
// top. Mirrors _barDrawboxFilter() in menu-builder.js (the burned-disc bar).
function _drawMenuBar(ctx, tpl, FW, FH) {
  const b = tpl.button;
  if (!b || b.layout !== 'horizontal' || !b.barColor) return;
  const barH = (b.barHeight != null) ? b.barHeight : 140;
  const barY = FH - barH;
  const op = (typeof b.barOpacity === 'number') ? b.barOpacity : 1;
  ctx.save();
  ctx.globalAlpha = op;
  ctx.fillStyle = '#' + String(b.barColor).replace(/^#/, '');
  ctx.fillRect(0, barY, FW, barH);
  ctx.restore();
}

// Sample [fill, label] pairs for a horizontal preview: `count` (default 4) buttons,
// the first one selected to mirror the disc's defaultSelectedButtonIdRef highlight.
const _HORIZ_LABELS = ['Play', 'Scenes', 'Audio', 'Extras', 'Setup', 'Trailers', 'Chapters', 'Exit'];
function _horizontalSamples(b) {
  const n = b.count != null ? b.count : 4;
  return Array.from({ length: n }, (_, i) => [i === 0 ? b.selectedFill : b.normalFill, _HORIZ_LABELS[i % _HORIZ_LABELS.length]]);
}

// Human label for a sample button index, used by the "Deleted buttons" restore
// chips. Mirrors the sample labels drawn by renderMenuPreviewLocal so a chip names
// the button the user actually removed; falls back to a 1-based ordinal.
const _VERT_LABELS = ['Play Movie', 'Scene Selection', 'Special Features'];
function _sampleButtonLabel(tpl, i) {
  const b = (tpl && tpl.button) || {};
  if (b.layout === 'horizontal') return _HORIZ_LABELS[i % _HORIZ_LABELS.length];
  return _VERT_LABELS[i] || `Button ${i + 1}`;
}

// Paint the template's background (image-cover or solid colour) onto a 1920×1080
// context. Shared by the main-menu and chapter-menu previews.
async function _drawPreviewBackground(ctx, tpl, FW, FH) {
  const bg = tpl.background || {};
  const fillSolid = () => {
    ctx.fillStyle = bg.color && /^#/.test(bg.color) ? bg.color : ('#' + (bg.color || '000000'));
    ctx.fillRect(0, 0, FW, FH);
  };
  const ref = (bg.type === 'image') ? _bgRef(bg) : '';
  if (!ref) { fillSolid(); return; }   // solid, or image with no usable reference yet
  try {
    const dataUrl = await window.discForge.getImageDataUrl(ref);
    if (!dataUrl) { fillSolid(); return; }   // file missing on disk → graceful fallback
    const img = await _loadImage(dataUrl);
    if (bg.fit === 'contain') fillSolid();   // 'contain' letterboxes against the fallback color
    const r = _bgDrawRect(bg.fit, img.width, img.height, FW, FH);
    ctx.drawImage(img, r.dx, r.dy, r.dw, r.dh);
  } catch (_) { fillSolid(); }
}

// ── v1.19.0 chapter-menu preview ────────────────────────────────────────────────
// Mirrors how buildChapterMenuDisplaySet lays out the disc menu: up to 6 chapter
// buttons (vertical stack) labelled from the real chapter names, plus a "Main Menu"
// back button below. The first chapter is drawn in the selected fill to reflect the
// disc's defaultSelectedButtonIdRef highlight. With no chapters yet it shows three
// placeholders so the layout still reads.
async function renderChapterMenuPreviewLocal(tpl, chapters) {
  const FW = 1920, FH = 1080;
  const cv = document.createElement('canvas');
  cv.width = FW; cv.height = FH;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  await ensureMenuFont();
  await _drawPreviewBackground(ctx, tpl, FW, FH);

  const b = tpl.button;
  const list = Array.isArray(chapters) ? chapters.slice(0, 6) : [];
  const labels = list.length
    ? list.map((c, i) => (c && c.name && c.name.trim()) ? c.name.trim() : `Chapter ${i + 1}`)
    : ['Chapter 1', 'Chapter 2', 'Chapter 3'];

  const pos = _autoPositions(labels.length, b.width, b.height, b.gap);
  const lowestY = pos.reduce((m, p) => Math.max(m, p.y), 0);
  const backPos = { x: Math.round((FW - b.width) / 2), y: lowestY + b.height + b.gap * 2 };

  // v1.23.0: when a source video is set, paint a frame-grab thumbnail behind each
  // chapter cell (commercial-Blu-ray scene-selection look), then a dark scrim so the
  // button borders/labels stay readable. Mirrors generateChapterMenuVideo on the
  // disc. Falls back silently to the solid-color buttons if no video / a grab fails.
  const proj = state.project || {};
  const videoPath = proj.mainVideo?.path || (proj.titles && proj.titles[0]?.file?.path);
  let drewThumbs = false;
  if (videoPath && list.length && window.discForge.extractChapterThumb) {
    for (let i = 0; i < labels.length && i < list.length; i++) {
      const ch = list[i] || {};
      const ts = (ch.time != null && ch.time !== '') ? ch.time : (ch.startTime != null ? ch.startTime : 0);
      try {
        const dataUrl = await window.discForge.extractChapterThumb({ videoPath, timestamp: ts, width: b.width, height: b.height });
        if (dataUrl) {
          const img = await _loadImage(dataUrl);
          ctx.drawImage(img, pos[i].x, pos[i].y, b.width, b.height);
          drewThumbs = true;
        }
      } catch (_) { /* this cell falls back to its solid button below */ }
    }
  }
  if (drewThumbs) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, FW, FH);
    ctx.restore();
  }

  labels.forEach((label, i) => {
    const fill = (i === 0) ? b.selectedFill : b.normalFill;  // first button highlighted
    // Over thumbnails: selected cell keeps a translucent highlight; normal cells draw
    // border + label only (no fill) so the frame grab shows through.
    const opts = drewThumbs ? { fillAlpha: (i === 0) ? 0.5 : 0 } : {};
    drawTemplateButton(ctx, tpl, fill, label, pos[i].x, pos[i].y, opts);
  });
  drawTemplateButton(ctx, tpl, b.normalFill, 'Main Menu', backPos.x, backPos.y, drewThumbs ? { fillAlpha: 0 } : {});
  return cv.toDataURL('image/png');
}

// ── v1.18.0 Interactive layout overlay ───────────────────────────────────────────
// A transparent canvas over the TV-screen preview. For custom templates it lets
// the user drag the 3 sample buttons anywhere on the 1920×1080 frame; for built-in
// templates it renders the same guides/outlines but is non-interactive. The drag
// loop NEVER calls render() — it mutates state.templateEditor.livePositions and
// redraws only the overlay; render() (and the disc-accurate menu re-render) fires
// once on mouseup via updateDraft().
let _overlayHandlers = null;

// Radius (CSS px) of the ✕ delete badge drawn at the selected button's top-right
// corner. Shared by renderOverlay (draw) and _deleteIconHitTest (click).
const DELETE_ICON_R = 7;   // 14px diameter, per spec

// Lazily populate the working position list from the draft (stored positions win,
// missing entries fall back to auto-layout). Returns the live array.
function _ensureLivePositions() {
  const ed = state.templateEditor;
  if (!ed.livePositions && ed.draft) ed.livePositions = _resolvePreviewPositions(ed.draft);
  return ed.livePositions;
}

// Indices of buttons whose bounding boxes intersect any other button.
function _overlapSet(positions, bw, bh) {
  const set = new Set();
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i], b = positions[j];
      if (a.x < b.x + bw && a.x + bw > b.x && a.y < b.y + bh && a.y + bh > b.y) {
        set.add(i); set.add(j);
      }
    }
  }
  return set;
}
// Does the current preview (live or resolved) have any overlapping buttons?
function _hasPreviewOverlap() {
  const ed = state.templateEditor;
  if (!ed.draft) return false;
  const positions = ed.livePositions || _resolvePreviewPositions(ed.draft);
  return _overlapSet(positions, ed.draft.button.width, ed.draft.button.height).size > 0;
}

// Disc-space (1920×1080) coordinates of a mouse event over the overlay.
function _overlayToDisc(e, overlay) {
  const rect = overlay.getBoundingClientRect();
  return {
    discX: Math.round((e.clientX - rect.left) * (1920 / rect.width)),
    discY: Math.round((e.clientY - rect.top)  * (1080 / rect.height)),
  };
}

// Draw the guides + button outlines + handles onto the overlay canvas.
function renderOverlay(overlay) {
  if (!overlay) return;
  const ed = state.templateEditor;
  const tpl = ed.draft;
  if (!tpl) return;
  const ctx = overlay.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // logical coords = CSS pixels
  const displayW = overlay.width / dpr;
  const displayH = overlay.height / dpr;
  if (displayW < 1 || displayH < 1) return;

  // 1. Clear
  ctx.clearRect(0, 0, displayW, displayH);

  const scaleX = displayW / 1920, scaleY = displayH / 1080;
  const b = tpl.button;
  const bw = b.width, bh = b.height;
  const positions = ed.livePositions || _resolvePreviewPositions(tpl);

  // 2. Grid
  if (ed.showGrid) {
    const gs = ed.gridSize;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= 1920; x += gs) {
      ctx.beginPath(); ctx.moveTo(x * scaleX, 0); ctx.lineTo(x * scaleX, displayH); ctx.stroke();
    }
    for (let y = 0; y <= 1080; y += gs) {
      ctx.beginPath(); ctx.moveTo(0, y * scaleY); ctx.lineTo(displayW, y * scaleY); ctx.stroke();
    }
  }

  // 3. Center guides
  if (ed.showCenter) {
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(960 * scaleX, 0); ctx.lineTo(960 * scaleX, displayH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 540 * scaleY); ctx.lineTo(displayW, 540 * scaleY); ctx.stroke();
    ctx.setLineDash([]);
  }

  // 4. Safe-area guides
  if (ed.showSafeAreas) {
    // Action safe: 5% inset
    ctx.strokeStyle = 'rgba(219, 184, 90, 0.35)';
    ctx.lineWidth = 0.75;
    ctx.strokeRect(96 * scaleX, 54 * scaleY, (1920 - 192) * scaleX, (1080 - 108) * scaleY);
    ctx.fillStyle = 'rgba(219, 184, 90, 0.45)';
    ctx.font = `${Math.max(7, Math.round(16 * scaleX))}px monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('ACTION SAFE', 98 * scaleX, 66 * scaleY + 8 * scaleY);

    // Title safe: 10% inset
    ctx.strokeStyle = 'rgba(255, 140, 0, 0.4)';
    ctx.strokeRect(192 * scaleX, 108 * scaleY, (1920 - 384) * scaleX, (1080 - 216) * scaleY);
    ctx.fillStyle = 'rgba(255, 140, 0, 0.55)';
    ctx.fillText('TITLE SAFE', 194 * scaleX, 120 * scaleY + 8 * scaleY);
  }

  // 5. Button outlines + index + handles
  const overlaps = _overlapSet(positions, bw, bh);
  positions.forEach((p, i) => {
    if (ed.deletedBtns.includes(i)) return;   // hidden via Delete/✕ — draw nothing for it
    const rx = p.x * scaleX, ry = p.y * scaleY, rw = bw * scaleX, rh = bh * scaleY;
    const isSelected = i === ed.selectedBtn;
    const isHovered  = i === ed.hoveredBtn;

    _btnShapePath(ctx, rx, ry, rw, rh, (b.shape === 'rounded' || b.shape === 'pill') ? b.shape : 'rect',
      Number.isInteger(b.cornerRadius) ? b.cornerRadius * scaleX : 0);
    if (isSelected)      { ctx.strokeStyle = '#dbb85a'; ctx.lineWidth = 2; ctx.setLineDash([]); }
    else if (isHovered)  { ctx.strokeStyle = 'rgba(219,184,90,0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([]); }
    else                 { ctx.strokeStyle = 'rgba(219,184,90,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]); }
    ctx.stroke();
    ctx.setLineDash([]);

    // Button index number (centered)
    ctx.fillStyle = isSelected ? 'rgba(219,184,90,0.9)' : 'rgba(219,184,90,0.4)';
    ctx.font = `bold ${Math.max(9, Math.round(22 * scaleX))}px monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), rx + rw / 2, ry + rh / 2);

    // Corner handles (selected only)
    if (isSelected) {
      const hs = 6;
      [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]].forEach(([hx, hy]) => {
        ctx.fillStyle = '#dbb85a';
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      });

      // Delete (✕) icon — small red circle at the top-right corner of the
      // selected button. Clicking it deletes the button (same as the Delete key);
      // _deleteIconHitTest() recomputes this exact geometry for hit detection.
      ctx.beginPath();
      ctx.arc(rx + rw, ry, DELETE_ICON_R, 0, Math.PI * 2);
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      const xr = DELETE_ICON_R * 0.45;
      ctx.beginPath();
      ctx.moveTo(rx + rw - xr, ry - xr); ctx.lineTo(rx + rw + xr, ry + xr);
      ctx.moveTo(rx + rw + xr, ry - xr); ctx.lineTo(rx + rw - xr, ry + xr);
      ctx.stroke();
    }
  });

  // 6. Overlap warning — re-stroke intersecting buttons in red
  if (overlaps.size) {
    ctx.strokeStyle = 'rgba(255,80,80,0.8)';
    ctx.lineWidth = 2; ctx.setLineDash([4, 2]);
    overlaps.forEach(i => {
      const p = positions[i];
      _btnShapePath(ctx, p.x * scaleX, p.y * scaleY, bw * scaleX, bh * scaleY,
        (b.shape === 'rounded' || b.shape === 'pill') ? b.shape : 'rect',
        Number.isInteger(b.cornerRadius) ? b.cornerRadius * scaleX : 0);
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  // 7. Position HUD during drag
  if (ed.dragging && ed.selectedBtn >= 0 && positions[ed.selectedBtn]) {
    const p = positions[ed.selectedBtn];
    const hudX = (p.x + bw / 2) * scaleX;
    const hudY = p.y * scaleY - 22;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(hudX - 44, hudY, 88, 17, 4);
    else ctx.rect(hudX - 44, hudY, 88, 17);
    ctx.fill();
    ctx.fillStyle = '#dbb85a'; ctx.font = '10px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`X:${p.x}  Y:${p.y}`, hudX, hudY + 8.5);
  }
}

// ── Overlay mouse handlers (no render() during a drag) ──────────────────────────
function _onOverlayMouseDown(e) {
  const overlay = e.currentTarget;
  const ed = state.templateEditor;
  const tpl = ed.draft;
  if (!tpl) return;
  const { discX, discY } = _overlayToDisc(e, overlay);
  const bw = tpl.button.width, bh = tpl.button.height;
  const positions = _ensureLivePositions();
  if (!positions) return;

  // Click on the selected button's ✕ badge → delete it (before drag/select logic).
  if (_deleteIconHitTest(e, overlay)) { _deleteSelectedButton(); return; }

  let hit = -1;
  for (let i = positions.length - 1; i >= 0; i--) {
    if (ed.deletedBtns.includes(i)) continue;   // can't grab a hidden button
    const p = positions[i];
    if (discX >= p.x && discX <= p.x + bw && discY >= p.y && discY <= p.y + bh) { hit = i; break; }
  }
  ed.selectedBtn = hit;
  if (hit >= 0) {
    ed.dragging = true;
    ed.dragOffsetX = discX - positions[hit].x;
    ed.dragOffsetY = discY - positions[hit].y;
    overlay.style.cursor = 'grabbing';
  }
  renderOverlay(overlay);
  _updatePositionInputs();
}

function _onOverlayMouseMove(e) {
  const overlay = e.currentTarget;
  const ed = state.templateEditor;
  const tpl = ed.draft;
  if (!tpl) return;
  const { discX, discY } = _overlayToDisc(e, overlay);
  const bw = tpl.button.width, bh = tpl.button.height;
  const positions = ed.livePositions;

  if (ed.dragging && positions) {
    const i = ed.selectedBtn;
    let newX = Math.round(discX - ed.dragOffsetX);
    let newY = Math.round(discY - ed.dragOffsetY);
    if (ed.showGrid) {
      const gs = ed.gridSize;
      newX = Math.round(newX / gs) * gs;
      newY = Math.round(newY / gs) * gs;
    }
    newX = Math.max(0, Math.min(newX, 1920 - bw));
    newY = Math.max(0, Math.min(newY, 1080 - bh));
    positions[i] = { x: newX, y: newY };
    overlay.style.cursor = 'grabbing';
    renderOverlay(overlay);
    _updatePositionInputs();
    return;
  }

  if (positions) {
    let hovered = -1;
    for (let i = positions.length - 1; i >= 0; i--) {
      if (ed.deletedBtns.includes(i)) continue;   // hidden buttons aren't hoverable
      const p = positions[i];
      if (discX >= p.x && discX <= p.x + bw && discY >= p.y && discY <= p.y + bh) { hovered = i; break; }
    }
    if (hovered !== ed.hoveredBtn) {
      ed.hoveredBtn = hovered;
      renderOverlay(overlay);
    }
    overlay.style.cursor = hovered >= 0 ? 'grab' : 'crosshair';
  }
}

function _onOverlayMouseUp(e) {
  const ed = state.templateEditor;
  if (!ed.dragging) return;
  ed.dragging = false;
  e.currentTarget.style.cursor = 'grab';
  _commitLivePositions();   // single render() + disc-accurate preview re-render
}

function _onOverlayMouseLeave(e) {
  const ed = state.templateEditor;
  if (ed.dragging) { _onOverlayMouseUp(e); return; }
  ed.hoveredBtn = -1;
  renderOverlay(e.currentTarget);
}

// True when the mouse event lands on the selected button's ✕ delete badge.
// Mirrors the badge geometry drawn in renderOverlay (top-right corner, radius
// DELETE_ICON_R in CSS px). Returns false when no button is selected.
function _deleteIconHitTest(e, overlay) {
  const ed = state.templateEditor;
  const i = ed.selectedBtn;
  if (i < 0 || !ed.draft || !overlay) return false;
  const positions = ed.livePositions || _resolvePreviewPositions(ed.draft);
  const p = positions[i];
  if (!p) return false;
  const rect = overlay.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const scaleX = rect.width / 1920, scaleY = rect.height / 1080;
  const ix = (p.x + ed.draft.button.width) * scaleX;   // badge centre (top-right corner)
  const iy = p.y * scaleY;
  const dx = (e.clientX - rect.left) - ix;
  const dy = (e.clientY - rect.top)  - iy;
  return (dx * dx + dy * dy) <= (DELETE_ICON_R + 3) * (DELETE_ICON_R + 3);   // +3px slop
}

// Document-level keydown for the layout editor: Delete/Backspace removes the
// selected button. Attached once at startup (see the Start block) — NOT per
// render — so it never stacks duplicate listeners. Ignored while typing in a
// field so Backspace keeps deleting text there.
function _onLayoutKeydown(e) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (state.tab !== 'templates') return;
  const ed = state.templateEditor;
  if (!ed.draft || isReadonly(ed.selectedId) || ed.selectedBtn < 0) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  e.preventDefault();
  _deleteSelectedButton();
}

// Delete the currently-selected sample button from the layout editor.
//
// The template model has no per-button "exists" flag — the disc's button set is
// driven by the project's menu items, and a template only stores per-button
// *positions*. So "deleting" a button here means two things, both reversible:
//   1. it is hidden from the editor preview (state.templateEditor.deletedBtns),
//   2. any custom coordinate stored for it is removed (set to null) so the entry
//      reverts to its auto-layout default.
// This is exactly the "resets to the auto-layout default" behaviour the spec
// allows. "Revert to saved" restores every button (see revertTemplate /
// isDirty, which treat a non-empty deletedBtns as a pending change).
function _deleteSelectedButton() {
  const ed = state.templateEditor;
  if (isReadonly(ed.selectedId) || !ed.draft) return;
  const i = ed.selectedBtn;
  if (i < 0) return;
  if (!ed.deletedBtns.includes(i)) ed.deletedBtns.push(i);
  ed.selectedBtn = -1;
  ed.hoveredBtn = -1;
  // Remove this button's stored position entry (null = auto-layout). updateDraft
  // re-renders the controls and re-renders both previews (which now skip the
  // hidden index). When the draft carries no custom positions there is nothing
  // to null — the deletedBtns hide alone drives the preview update.
  updateDraft(t => {
    if (Array.isArray(t.button.positions) && t.button.positions[i] != null) {
      t.button.positions[i] = null;
    }
  });
}

// Commit the working positions into the draft (triggers render + preview). Each
// stored entry is clamped to the on-frame range so validateTemplate always passes.
function _commitLivePositions() {
  const ed = state.templateEditor;
  if (!ed.livePositions || !ed.draft) return;
  const bw = ed.draft.button.width, bh = ed.draft.button.height;
  const snapshot = ed.livePositions.map(p => ({
    x: Math.max(0, Math.min(Math.round(p.x), 1920 - bw)),
    y: Math.max(0, Math.min(Math.round(p.y), 1080 - bh)),
  }));
  ed.livePositions = snapshot.map(p => ({ ...p }));
  updateDraft(t => {
    const existing = (t.button.positions || []).slice();
    snapshot.forEach((p, i) => { existing[i] = { ...p }; });
    t.button.positions = existing;
  });
}

// Sync the X/Y number inputs + button selector to the current selection. Skips
// whichever control has focus so it never fights the user mid-edit.
function _updatePositionInputs() {
  const ed = state.templateEditor;
  const i = ed.selectedBtn;
  const positions = ed.livePositions;
  const xEl = document.getElementById('tpl-pos-x');
  const yEl = document.getElementById('tpl-pos-y');
  const sel = document.getElementById('tpl-pos-btn-select');
  if (sel && i >= 0 && document.activeElement !== sel) sel.value = String(i);
  if (i < 0 || !positions || !positions[i]) return;
  if (xEl && document.activeElement !== xEl) xEl.value = positions[i].x;
  if (yEl && document.activeElement !== yEl) yEl.value = positions[i].y;
}

// Alignment / distribution / reset tools. Each operates on the resolved sample
// positions and commits (which re-renders + re-renders the disc-accurate preview).
function _applyAlign(kind) {
  const ed = state.templateEditor;
  const tpl = ed.draft;
  if (!tpl || isReadonly(ed.selectedId)) return;
  const bw = tpl.button.width, bh = tpl.button.height;

  if (kind === 'stack') {
    ed.livePositions = null;
    updateDraft(t => { delete t.button.positions; });
    return;
  }

  const cur = (_ensureLivePositions() || []).map(p => ({ ...p }));
  if (kind === 'centerFrame') { _commitPositions(_autoPositions(3, bw, bh, tpl.button.gap)); return; }

  if (kind === 'left') {
    const minX = Math.min(...cur.map(p => p.x));
    cur.forEach(p => { p.x = minX; });
  } else if (kind === 'right') {
    const maxR = Math.max(...cur.map(p => p.x + bw));
    cur.forEach(p => { p.x = maxR - bw; });
  } else if (kind === 'centerH') {
    const x = Math.round((1920 - bw) / 2);
    cur.forEach(p => { p.x = x; });
  } else if (kind === 'centerV') {
    const y = Math.round((1080 - bh) / 2);
    cur.forEach(p => { p.y = y; });
  } else if (kind === 'distV') {
    const order = cur.map((_, i) => i).sort((a, b) => cur[a].y - cur[b].y);
    const top = cur[order[0]].y, bot = cur[order[order.length - 1]].y, n = order.length;
    order.forEach((bi, k) => { cur[bi].y = Math.round(top + (bot - top) * (n > 1 ? k / (n - 1) : 0)); });
  } else if (kind === 'distH') {
    const order = cur.map((_, i) => i).sort((a, b) => cur[a].x - cur[b].x);
    const left = cur[order[0]].x, right = cur[order[order.length - 1]].x, n = order.length;
    order.forEach((bi, k) => { cur[bi].x = Math.round(left + (right - left) * (n > 1 ? k / (n - 1) : 0)); });
  }
  _commitPositions(cur);
}

// Commit an arbitrary positions array (used by the alignment tools).
function _commitPositions(newPositions) {
  state.templateEditor.livePositions = newPositions.map(p => ({ x: p.x, y: p.y }));
  _commitLivePositions();
}

// Re-initialize the overlay after every full render: size it to the screen,
// (re)wire the drag handlers (custom templates only), and paint the guides.
function initLayoutOverlay() {
  const overlay = document.getElementById('layout-overlay');
  if (!overlay) return;
  const ed = state.templateEditor;
  const rect = overlay.getBoundingClientRect();
  const dpr  = window.devicePixelRatio || 1;
  if (rect.width < 1 || rect.height < 1) {
    requestAnimationFrame(() => initLayoutOverlay());   // layout not ready yet
    return;
  }
  overlay.width  = Math.round(rect.width  * dpr);
  overlay.height = Math.round(rect.height * dpr);

  const editable = !isReadonly(ed.selectedId) && !!ed.draft;
  overlay.style.cursor        = editable ? 'crosshair' : 'default';
  overlay.style.pointerEvents = editable ? 'auto' : 'none';

  if (_overlayHandlers) {
    overlay.removeEventListener('mousedown',  _overlayHandlers.down);
    overlay.removeEventListener('mousemove',  _overlayHandlers.move);
    overlay.removeEventListener('mouseup',    _overlayHandlers.up);
    overlay.removeEventListener('mouseleave', _overlayHandlers.leave);
    _overlayHandlers = null;
  }
  if (editable) {
    _overlayHandlers = {
      down:  _onOverlayMouseDown,
      move:  _onOverlayMouseMove,
      up:    _onOverlayMouseUp,
      leave: _onOverlayMouseLeave,
    };
    overlay.addEventListener('mousedown',  _overlayHandlers.down);
    overlay.addEventListener('mousemove',  _overlayHandlers.move);
    overlay.addEventListener('mouseup',    _overlayHandlers.up);
    overlay.addEventListener('mouseleave', _overlayHandlers.leave);
  }
  renderOverlay(overlay);
}

// Apply an edit to the working draft, keep fill colors consistent with the
// palette, preserve focus, re-render, and re-validate+preview (debounced).
function updateDraft(mutate) {
  const ed = state.templateEditor;
  if (!ed.draft) return;
  const activeEl = document.activeElement;
  if (activeEl && activeEl.id) { _focusedId = activeEl.id; _focusedPos = activeEl.selectionStart ?? null; }
  mutate(ed.draft);
  syncTemplateFills(ed.draft);
  render();
  scheduleValidateAndPreview();
}

// Keep button.normalFill / selectedFill rgb+hex in sync with their palette
// entries (the encoder + preview read these; they must match the palette).
function syncTemplateFills(tpl) {
  for (const key of ['normalFill', 'selectedFill']) {
    const f = tpl.button[key];
    const e = tpl.palette.find(p => p.id === f.entry);
    if (e) {
      const rgb = window.discForge.color.yuvToRgb(e.Y, e.Cr, e.Cb);
      f.rgb = rgb;
      f.hex = window.discForge.color.rgbToHex(rgb);
    }
  }
}

function isDirty() {
  const ed = state.templateEditor;
  // A pending button deletion (deletedBtns) counts as dirty so Save/Revert enable
  // and "Revert to saved" can restore the hidden buttons.
  if (ed.deletedBtns && ed.deletedBtns.length) return true;
  return !!(ed.draft && ed.baseline && JSON.stringify(ed.draft) !== JSON.stringify(ed.baseline));
}

// Name-entry modal, shared by Duplicate and Save As (Electron has no window.prompt).
// state.templateEditor.nameModal = { mode:'duplicate'|'saveAs', value }
function openNameModal(mode) {
  const meta = templateMeta(state.templateEditor.selectedId);
  const base = (state.templateEditor.draft && state.templateEditor.draft.name) || (meta && meta.name) || 'Template';
  state.templateEditor.nameModal = { mode, value: base + ' copy' };
  render();
}
function duplicateSelected() { openNameModal('duplicate'); }
function cancelNameModal() { state.templateEditor.nameModal = null; render(); }
async function confirmNameModal() {
  const nm = state.templateEditor.nameModal;
  if (!nm) return;
  const input = document.getElementById('tpl-name-modal-input');
  const name = (input && input.value.trim()) || 'Template copy';
  state.templateEditor.nameModal = null;
  let r;
  if (nm.mode === 'duplicate') {
    // Copies the on-disk source template.
    r = await window.discForge.templateDuplicate(state.templateEditor.selectedId, name);
  } else {
    // Save As: persists the current (edited) draft under a new, unique name.
    r = await window.discForge.templateSaveAs(state.templateEditor.draft, name);
  }
  if (!r || !r.ok) { showInfo('Could not save: ' + (r && r.error)); render(); return; }
  await loadTemplates();
  await selectTemplate(r.id);
}

function nameModalHTML() {
  const nm = state.templateEditor.nameModal;
  const isDup = nm.mode === 'duplicate';
  return `<div class="modal-backdrop"><div class="modal-box" style="max-width:420px;text-align:left">
    <div class="modal-title">${isDup ? 'Duplicate template' : 'Save As'}</div>
    <div class="modal-sub">${isDup ? 'Create an editable copy under a new name.' : 'Save the current edits as a new template. The name must be unique.'}</div>
    <input type="text" id="tpl-name-modal-input" value="${esc(nm.value || '')}" placeholder="Template name" style="width:100%;margin:14px 0">
    <div class="modal-actions">
      <button class="btn btn-ghost" id="tpl-name-modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="tpl-name-modal-ok">${isDup ? 'Create' : 'Save As'}</button>
    </div>
  </div></div>`;
}

// ── Save / Revert / Delete (Phase 4C) ────────────────────────────────────────────
async function saveTemplate() {
  const ed = state.templateEditor;
  if (!ed.draft || isReadonly(ed.selectedId)) return;
  const r = await window.discForge.templateSave(ed.draft);
  if (!r || !r.ok) { showInfo('Could not save: ' + (r && r.error)); return; }
  invalidateThumb(r.id);          // the saved look changed → re-render its thumbnail
  await loadTemplates();
  await selectTemplate(r.id);     // re-reads from disk → baseline reset, dirty cleared
  state.templateEditor.savedFlash = true;
  render();
  ensureThumbnails();
  setTimeout(() => { state.templateEditor.savedFlash = false; render(); }, 2000);
}
function revertTemplate() {
  const ed = state.templateEditor;
  if (!ed.baseline) return;
  ed.draft = JSON.parse(JSON.stringify(ed.baseline));
  ed.error = null;
  ed.deletedBtns = [];     // restore any buttons deleted in the layout editor
  ed.livePositions = null; // re-derive from the restored draft on next interaction
  ed.selectedBtn = -1;
  render();
  refreshPreviews();
}
function deleteTemplate() {
  const ed = state.templateEditor;
  if (isReadonly(ed.selectedId)) return;
  const meta = templateMeta(ed.selectedId);
  showConfirm(`Delete the template “${meta ? meta.name : ed.selectedId}”? This cannot be undone.`, async () => {
    const r = await window.discForge.templateDelete(ed.selectedId);
    if (!r || !r.ok) { showInfo('Could not delete: ' + (r && r.error)); return; }
    await loadTemplates();  // loadTemplates re-selects a valid template (first built-in)
    state.templateEditor.selectedId = 'classic';
    await selectTemplate('classic');
  }, { title: 'Delete Template', confirmLabel: 'Delete' });
}

// Dropdown <option>s for the build flow + editor list.
function templateOptionsHTML(selectedId) {
  const all = [...(state.templates.builtIn || []), ...(state.templates.user || [])];
  if (all.length === 0) return `<option value="classic" selected>Classic</option>`;
  return all.map(t =>
    `<option value="${esc(t.id)}" ${t.id === selectedId ? 'selected' : ''}>${esc(t.name)}${t.readonly ? ' (built-in)' : ''}</option>`
  ).join('');
}

function _paletteHex(entry) {
  const rgb = window.discForge.color.yuvToRgb(entry.Y, entry.Cr, entry.Cb);
  return '#' + window.discForge.color.rgbToHex(rgb);
}
function _entryRoles(tpl, id) {
  const roles = [];
  if (tpl.button.normalFill.entry === id)   roles.push('Normal fill');
  if (tpl.button.selectedFill.entry === id) roles.push('Selected fill');
  if (tpl.button.borderEntry === id)        roles.push('Border / text');
  if (roles.length === 0) roles.push('Background');
  return roles.join(', ');
}

// Live preview pane: a full-screen 16:9 menu scene displayed inside a cinematic
// flat-screen-TV bezel (the hero element of the Menus tab). The isolated
// Normal/Selected button PNGs sit in a collapsible detail below. On a validation
// error, the pane shows the error banner instead.
// v1.19.0 — the chapter sub-menu is "active" (designable + buildable) only when
// the project has chapters and the chapter menu is enabled.
function _chapterMenuActive() {
  const p = state.project;
  return !!(p.chapterMenu && p.chapterMenu.enabled && Array.isArray(p.chapters) && p.chapters.length > 0);
}

let _lastSelForFade = null;   // drives the opacity fade only on template switch
function previewHTML() {
  const ed = state.templateEditor;
  if (ed.error) return `<div class="tpl-error">⚠ ${esc(ed.error)}</div>`;
  // The Main/Chapter switcher only appears when a chapter menu exists; otherwise
  // force the designer back to the main menu so a stale selection can't linger.
  const chapActive = _chapterMenuActive();
  if (!chapActive && ed.activeMenu !== 'main') ed.activeMenu = 'main';
  const switcher = chapActive ? `
    <div class="menu-switcher">
      <button class="menu-switch-btn ${ed.activeMenu === 'main' ? 'active' : ''}" data-menu="main">Main Menu</button>
      <button class="menu-switch-btn ${ed.activeMenu === 'chapters' ? 'active' : ''}" data-menu="chapters">Chapter Select</button>
    </div>` : '';
  const menu = ed.previews.menu;
  // Fade in only when the browsed template actually changed — not on every
  // keystroke in the editor (which would make the preview flicker constantly).
  const fade = (ed.selectedId !== _lastSelForFade) ? ' tv-fade' : '';
  _lastSelForFade = ed.selectedId;
  const caption = ed.menuRendering
    ? 'Rendering…'
    : (menu ? 'Preview — 3 sample buttons, center of 1920×1080 frame'
            : 'Full-screen preview unavailable on this Mac — the disc menu will still build correctly. See button states below.');
  // Deleted-buttons section: one restore chip per button hidden via the ✕ badge or
  // Delete key. Restoring removes the index from deletedBtns (see attachListeners)
  // so the button reappears in the preview. Hidden entirely when nothing is deleted.
  const deleted = (ed.deletedBtns || []).slice().sort((a, b) => a - b);
  const deletedSection = deleted.length ? `
    <div class="tpl-deleted">
      <span class="tpl-deleted-title">Deleted buttons</span>
      <div class="tpl-deleted-chips">
        ${deleted.map(i => `<button class="tpl-deleted-chip" data-restore-btn="${i}" title="Restore this button">
          <span class="tpl-deleted-name">${esc(_sampleButtonLabel(ed.draft, i))}</span>
          <span class="tpl-deleted-add">+ Restore</span>
        </button>`).join('')}
      </div>
    </div>` : '';
  const btn = (src, label) => `<div class="tpl-preview-col">
      <span class="tpl-preview-label">${label}</span>
      ${src ? `<img class="tpl-preview-img" src="${src}" alt="${label} button preview">`
            : `<div class="tpl-preview-img" style="width:300px;height:40px"></div>`}
    </div>`;
  return `
    ${switcher}
    <div class="tv-assembly">
      <div class="tv-bezel">
        <div class="tv-screen${fade}">
          ${menu ? `<img src="${menu}" id="menu-preview-img" alt="Full menu preview">`
                 : `<div class="tv-screen-empty">${esc(caption)}</div>`}
          <canvas id="layout-overlay" class="layout-overlay"></canvas>
        </div>
      </div>
      <div class="tv-stand-shadow"></div>
    </div>
    <div class="tpl-menu-preview-caption">${esc(caption)}</div>
    ${deletedSection}
    <details class="tpl-btn-detail">
      <summary>Button states</summary>
      <div class="tpl-preview-row">${btn(ed.previews.normal, 'Normal')}${btn(ed.previews.selected, 'Selected')}</div>
    </details>`;
}

// "white" / "#rrggbb" → "#rrggbb" for a color <input>.
function _fontColorHex(c) {
  if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) return c;
  if (c === 'white') return '#ffffff';
  if (c === 'black') return '#000000';
  return '#ffffff';
}

// ── v1.16.0 Menus tab — thumbnail browser ───────────────────────────────────────
// Each template gets a small rendered preview card. The full 1920×1080 scene is
// rendered once by renderMenuPreviewLocal and cached as a data URL; paintThumb
// scales it into the card's canvas. Rendering is lazy + staggered so opening the
// tab never freezes the UI.
const THUMB_W = 360, THUMB_H = 202;   // render resolution (2× the 180×101 display)
const SAFE_FONTS = ['Helvetica Neue', 'Arial', 'Georgia', 'Times New Roman',
  'Courier New', 'Futura', 'Gill Sans', 'Optima', 'Palatino'];

let _thumbRunning = false;
const _thumbImgCache = {};   // id → decoded Image of the cached dataURL

function availableFonts() {
  return (state.systemFonts && state.systemFonts.length) ? state.systemFonts : SAFE_FONTS;
}
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _bgImagePath(v) { return typeof v === 'string' ? v : (v && v.path) || ''; }
function _bgImageName(v) { const p = _bgImagePath(v); return p.split('/').pop() || 'image'; }

// Paint a template's cached preview into its browser-thumbnail canvas (scaled).
// Re-queries the DOM each call because render() rebuilds the canvases.
function paintThumb(id) {
  const cv = document.querySelector(`canvas[data-thumb-id="${CSS.escape(id)}"]`);
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const tpl = state.templateEditor.fullTemplates[id];
  const bgHex = (tpl && tpl.background && tpl.background.color)
    ? ('#' + String(tpl.background.color).replace(/^#/, '')) : '#0a0a12';
  ctx.fillStyle = bgHex; ctx.fillRect(0, 0, cv.width, cv.height);   // bg-color placeholder
  const dataUrl = state.templateEditor.thumbs[id];
  if (!dataUrl) return;
  const cached = _thumbImgCache[id];
  if (cached && cached.complete) { ctx.drawImage(cached, 0, 0, cv.width, cv.height); return; }
  const img = new Image();
  img.onload = () => {
    _thumbImgCache[id] = img;
    const c2 = document.querySelector(`canvas[data-thumb-id="${CSS.escape(id)}"]`);
    if (c2) c2.getContext('2d').drawImage(img, 0, 0, c2.width, c2.height);
  };
  img.src = dataUrl;
}

// Paint everything already cached, then lazily render anything missing.
function ensureThumbnails() {
  // The v1.22.0 design-first selector has no thumbnail grid; skip the work
  // entirely unless thumbnail canvases are actually present in the DOM.
  if (!document.querySelector('[data-thumb-id]')) return;
  const all = [...(state.templates.builtIn || []), ...(state.templates.user || [])];
  for (const m of all) paintThumb(m.id);
  if (all.some(m => !state.templateEditor.thumbs[m.id]) && !_thumbRunning) renderMissingThumbnails();
}
async function renderMissingThumbnails() {
  _thumbRunning = true;
  try {
    const all = [...(state.templates.builtIn || []), ...(state.templates.user || [])];
    for (const m of all) {
      if (state.templateEditor.thumbs[m.id]) continue;
      let tpl = state.templateEditor.fullTemplates[m.id];
      if (!tpl) {
        const r = await window.discForge.templateLoad(m.id);
        if (!r || !r.ok) continue;
        tpl = r.template;
        state.templateEditor.fullTemplates[m.id] = tpl;
      }
      paintThumb(m.id);   // show the bg-color placeholder immediately
      let dataUrl = null;
      try { dataUrl = await renderMenuPreviewLocal(tpl); } catch (_) {}
      if (dataUrl) {
        state.templateEditor.thumbs[m.id] = dataUrl;
        delete _thumbImgCache[m.id];
        paintThumb(m.id);
      }
      await _sleep(30);   // stagger so the UI stays responsive
    }
  } finally { _thumbRunning = false; }
}
// Drop a template's cached thumbnail so it re-renders (after its edit is saved).
function invalidateThumb(id) {
  delete state.templateEditor.thumbs[id];
  delete state.templateEditor.fullTemplates[id];
  delete _thumbImgCache[id];
}

// ── v1.22.0 design-first template selector ───────────────────────────────────────
// Step 1 — pick a Design (Vertical Stack / Horizontal Bar); Step 2 — pick a Color
// Scheme from a dropdown that lists only templates matching the active design type.
function designSelectorHTML() {
  const t  = state.templates;
  const ed = state.templateEditor;
  if (!t.loaded) return `<div class="tpl-list-empty">Loading…</div>`;
  const design = ed.designType || 'vertical';

  const designBtn = (val, label) =>
    `<button class="tpl-design-btn ${design === val ? 'on' : ''}" data-design-type="${esc(val)}">${esc(label)}</button>`;

  const matches = m => ((m.layout || 'vertical') === design);
  const byName  = (a, b) => a.name.localeCompare(b.name);
  const builtIn = t.builtIn.filter(matches).slice().sort(byName);
  const user    = t.user.filter(matches).slice().sort(byName);

  const opt = m => `<option value="${esc(m.id)}" ${m.id === ed.selectedId ? 'selected' : ''}>${esc(m.name)}</option>`;
  let options = builtIn.map(opt).join('');
  if (user.length) options += `<optgroup label="Custom">${user.map(opt).join('')}</optgroup>`;
  if (!options) options = `<option disabled selected>No templates</option>`;

  return `
    <div class="tpl-selector card">
      <div class="tpl-selector-section">
        <div class="tpl-selector-label">Design</div>
        <div class="tpl-design-toggle">
          ${designBtn('vertical', 'Vertical Stack')}
          ${designBtn('horizontal', 'Horizontal Bar')}
        </div>
      </div>
      <div class="tpl-selector-section">
        <div class="tpl-selector-label">Color Scheme</div>
        <select id="tpl-scheme-select" class="tpl-scheme-select">${options}</select>
      </div>
    </div>`;
}

// Switch the active design type. If the currently-selected template doesn't match
// the new type, jump to the first template of that type so the preview follows.
function setDesignType(type) {
  const ed = state.templateEditor;
  if (type !== 'horizontal' && type !== 'vertical') return;
  ed.designType = type;
  const all = [...(state.templates.builtIn || []), ...(state.templates.user || [])];
  const cur = all.find(m => m.id === ed.selectedId);
  if (!cur || (cur.layout || 'vertical') !== type) {
    const first = all
      .filter(m => (m.layout || 'vertical') === type)
      .sort((a, b) => a.name.localeCompare(b.name))[0];
    if (first) { selectTemplate(first.id); return; }  // re-renders + auto-syncs designType
  }
  render();
}

// ── Quick presets (Section E) ───────────────────────────────────────────────────
const TPL_PRESETS = [
  { id: 'dark-cinema', name: 'Dark Cinema', bg: '000000', normal: [150, 116, 40], selected: [224, 186, 86], text: [235, 235, 235], border: 3 },
  { id: 'clean-white', name: 'Clean White', bg: 'f0f0f2', normal: [55, 58, 66], selected: [28, 30, 38], text: [240, 240, 245], border: 2 },
  { id: 'deep-blue',   name: 'Deep Blue',   bg: '0a1733', normal: [22, 44, 110], selected: [64, 132, 255], text: [238, 242, 255], border: 2 },
  { id: 'forest',      name: 'Forest',      bg: '0e2014', normal: [40, 82, 52],  selected: [150, 196, 150], text: [238, 245, 238], border: 2 },
  { id: 'minimal',     name: 'Minimal',     bg: '000000', normal: [38, 38, 44],  selected: [96, 96, 108],  text: [230, 230, 235], border: 1 },
];
function presetsBarHTML() {
  return `<div class="tpl-presets">
    ${TPL_PRESETS.map(p => `<button class="tpl-preset-chip" data-preset="${p.id}" title="${esc(p.name)}">
      <span class="tpl-preset-dot" style="background:#${p.bg}"></span>${esc(p.name)}
    </button>`).join('')}
  </div>`;
}
function applyPreset(p) {
  updateDraft(t => {
    t.background.type = 'solid';
    t.background.color = p.bg;
    const setEntry = (entry, rgb) => {
      const e = t.palette.find(x => x.id === entry);
      if (!e) return;
      const yuv = window.discForge.color.rgbToYuv(rgb[0], rgb[1], rgb[2]);
      e.Y = yuv.Y; e.Cr = yuv.Cr; e.Cb = yuv.Cb;
    };
    setEntry(t.button.borderEntry, p.text);
    setEntry(t.button.normalFill.entry, p.normal);
    setEntry(t.button.selectedFill.entry, p.selected);
    t.button.border = p.border;
  });
}

// ── Collapsible accordion sections (open/closed persisted in localStorage) ───────
function accordionOpen(key) {
  const v = localStorage.getItem('disc-forge-acc-' + key);
  return v === null ? true : v === '1';   // default open
}
function accordionHTML(key, title, inner) {
  const open = accordionOpen(key);
  return `<div class="tpl-acc ${open ? 'open' : ''}">
    <button class="tpl-acc-head" data-accordion="${key}">
      <span class="tpl-acc-chevron">▸</span><span>${esc(title)}</span>
    </button>
    <div class="tpl-acc-body">${inner}</div>
  </div>`;
}

// ── Reusable editor controls ─────────────────────────────────────────────────────
function swatchRowHTML(id, label, hex) {
  return `<div class="tpl-ctl-row">
    <span class="tpl-ctl-label">${esc(label)}</span>
    <label class="tpl-swatch-btn" style="--sw:${hex}">
      <span class="tpl-swatch-fill"></span>
      <input type="color" id="${id}" value="${hex}">
    </label>
  </div>`;
}
function sliderRowHTML(id, label, min, max, step, value, display) {
  return `<div class="tpl-slider-row">
    <span class="tpl-ctl-label">${esc(label)}</span>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">
    <span class="tpl-slider-pill">${esc(display)}</span>
  </div>`;
}

// Read-only summary table shown below the preview for built-in templates.
function builtinSummaryHTML(tpl) {
  const bg = tpl.background;
  const rows = [
    ['Background', bg.type === 'solid' ? `Solid #${esc(bg.color)}` : `Image (${esc(bg.fit)})`],
    ['Button size', `${tpl.button.width} × ${tpl.button.height} px`],
    ['Gap / border', `${tpl.button.gap} px / ${tpl.button.border} px`],
    ['Font', `${esc((tpl.font && tpl.font.family) || tpl.font.file)} · ${Math.round((tpl.font.sizeRatio || 0.5) * 100)}%`],
  ];
  return `<div class="tpl-summary-card">
    <div class="tpl-summary-title">Template details</div>
    <table class="tpl-summary-table">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
  </div>`;
}

// Active-template status line (Part 5): which template the disc will actually use.
function activeStatusHTML() {
  const ed = state.templateEditor;
  const activeId = state.project.igMenuConfig && state.project.igMenuConfig.templateId;
  const activeMeta = templateMeta(activeId);
  const isActive = activeId === ed.selectedId;
  return `<div class="tpl-active-bar">
    <span class="tpl-active-label">Active template: <b>${esc(activeMeta ? activeMeta.name : '—')}</b></span>
    <button class="btn ${isActive ? 'btn-ghost' : 'btn-secondary'} btn-sm" id="tpl-use-active" ${isActive ? 'disabled' : ''}>
      ${isActive ? '✓ In use' : 'Use this template'}
    </button>
  </div>`;
}

// Pulse the "Duplicate to edit" button once, the first time a built-in is viewed.
const _pulsedBuiltins = new Set();
function _pulseBuiltin(id) { if (_pulsedBuiltins.has(id)) return false; _pulsedBuiltins.add(id); return true; }

// Full design editor (custom/user templates) — Sections A–E (Part 3).
function templateEditorHTML(tpl) {
  const ed = state.templateEditor;
  const b = tpl.button, bg = tpl.background;
  const palHex = (entry) => {
    const e = tpl.palette.find(x => x.id === entry);
    return e ? _paletteHex(e) : '#000000';
  };
  const fonts = availableFonts();
  const curFont = (tpl.font && tpl.font.family) || (fonts[0] || 'Helvetica Neue');
  const filter = (ed.fontFilter || '').toLowerCase();
  const shown = fonts.filter(f => !filter || f.toLowerCase().includes(filter));
  const fontOpts = shown.map(f =>
    `<option value="${esc(f)}" ${f === curFont ? 'selected' : ''} style="font-family:'${esc(f)}'">${esc(f)}</option>`).join('')
    || `<option selected>${esc(curFont)}</option>`;

  // SECTION A — Background
  const bgSection = `
    <div class="tpl-segmented">
      <button class="tpl-seg ${bg.type === 'solid' ? 'on' : ''}" data-bg-type="solid">Solid Color</button>
      <button class="tpl-seg ${bg.type === 'image' ? 'on' : ''}" data-bg-type="image">Image</button>
    </div>
    ${bg.type === 'solid' ? `
      <label class="tpl-swatch-wide" style="--sw:#${esc(bg.color)}">
        <span class="tpl-swatch-fill"></span>
        <span class="tpl-swatch-text">#${esc(bg.color)}</span>
        <input type="color" id="tpl-bg-color2" value="#${esc(bg.color)}">
      </label>` : `
      <div class="tpl-dropzone" id="tpl-bg-drop">
        <div class="tpl-dz-icon">🖼</div>
        <div class="tpl-dz-text">Drop an image or click to browse</div>
        <div class="tpl-dz-hint">PNG · JPG · WEBP</div>
      </div>
      ${(bg.file || bg.imagePath) ? `
      <div class="tpl-img-loaded">
        <div class="tpl-img-thumb" id="tpl-bg-thumb"></div>
        <span class="tpl-img-name">${esc(_bgImageName(bg.file || bg.imagePath))}</span>
        <button class="tpl-img-clear" id="tpl-bg-image-clear2" title="Remove image">✕</button>
      </div>` : ''}
      <div class="tpl-ctl-row" style="margin-top:10px">
        <span class="tpl-ctl-label">Fit</span>
        <select id="tpl-bg-fit2" style="width:auto">${['cover', 'contain', 'stretch'].map(f => `<option value="${f}" ${(bg.fit || 'cover') === f ? 'selected' : ''}>${f}</option>`).join('')}</select>
      </div>
      <div class="tpl-dz-hint" style="margin-top:6px">Image is shown as-is on disc menus.</div>`}`;

  // SECTION B — Buttons
  const shape = (b.shape === 'rounded' || b.shape === 'pill') ? b.shape : 'rect';
  const cornerR = Number.isInteger(b.cornerRadius) ? b.cornerRadius : 24;
  const shapeSeg = (val, icon, label) =>
    `<button class="tpl-shape-btn ${shape === val ? 'on' : ''}" data-shape="${val}">
      <span class="tpl-shape-icon">${icon}</span>${label}
    </button>`;
  const btnSection = `
    <div class="tpl-sub-label">Colors</div>
    ${swatchRowHTML('tpl-normal-color', 'Normal', palHex(b.normalFill.entry))}
    ${swatchRowHTML('tpl-sel-color', 'Selected', palHex(b.selectedFill.entry))}
    ${swatchRowHTML('tpl-border-color', 'Border / text', palHex(b.borderEntry))}
    <div class="tpl-sub-label">Shape</div>
    <div class="tpl-shape-seg">
      ${shapeSeg('rect', '▭', 'Rectangle')}
      ${shapeSeg('rounded', '▢', 'Rounded')}
      ${shapeSeg('pill', '⬭', 'Pill')}
    </div>
    ${shape === 'rounded'
      ? sliderRowHTML('tpl-corner-radius', 'Corner radius', 4, 60, 2, cornerR, cornerR + 'px')
      : ''}
    <div class="tpl-sub-label">Size &amp; spacing</div>
    ${sliderRowHTML('tpl-w', 'Width', 200, 1600, 10, b.width, b.width + 'px')}
    ${sliderRowHTML('tpl-h', 'Height', 40, 200, 2, b.height, b.height + 'px')}
    ${sliderRowHTML('tpl-gap', 'Gap', 10, 80, 2, b.gap, b.gap + 'px')}
    <div class="tpl-sub-label">Border</div>
    ${sliderRowHTML('tpl-border', 'Thickness', 0, 12, 1, b.border, b.border + 'px')}`;

  // SECTION B2 — Layout (v1.18.0 interactive editor)
  const lp = ed.livePositions || _resolvePreviewPositions(tpl);
  const selIdx = ed.selectedBtn >= 0 ? ed.selectedBtn : 0;
  const selPos = lp[selIdx] || lp[0] || { x: 0, y: 0 };
  const hasOverlap = _overlapSet(lp, b.width, b.height).size > 0;
  const gs = ed.gridSize;
  const layoutSection = `
    <div class="tpl-layout-hint">Drag buttons on the preview, or set exact coordinates below.</div>
    <div class="tpl-ctl-row">
      <span class="tpl-ctl-label">Button</span>
      <select id="tpl-pos-btn-select">
        ${[0, 1, 2].map(i => `<option value="${i}" ${i === selIdx ? 'selected' : ''}>Button ${i + 1}</option>`).join('')}
      </select>
    </div>
    <div class="tpl-pos-row">
      <span class="tpl-pos-label">X</span>
      <input type="number" id="tpl-pos-x" class="tpl-pos-input" min="0" max="1919" step="1" value="${selPos.x}">
      <span class="tpl-pos-label">Y</span>
      <input type="number" id="tpl-pos-y" class="tpl-pos-input" min="0" max="1079" step="1" value="${selPos.y}">
    </div>
    <div class="tpl-sub-label">Align</div>
    <div class="tpl-align-grid">
      <button class="tpl-align-btn" data-align="left"    title="Align left edges">⊢</button>
      <button class="tpl-align-btn" data-align="right"   title="Align right edges">⊣</button>
      <button class="tpl-align-btn" data-align="centerH" title="Center horizontally">↔</button>
      <button class="tpl-align-btn" data-align="centerV" title="Center vertically">↕</button>
      <button class="tpl-align-btn" data-align="distV"   title="Distribute vertically">⇕</button>
      <button class="tpl-align-btn" data-align="distH"   title="Distribute horizontally">⇔</button>
      <button class="tpl-align-btn" data-align="stack"   title="Reset to auto stack">≡</button>
      <button class="tpl-align-btn" data-align="centerFrame" title="Center all in frame">⊕</button>
    </div>
    <div class="tpl-sub-label">View</div>
    <div class="tpl-view-row">
      <input type="checkbox" id="tpl-show-grid" ${ed.showGrid ? 'checked' : ''}>
      <label for="tpl-show-grid">Grid</label>
      <select id="tpl-grid-size" class="tpl-grid-size-sel">
        ${[8, 16, 32, 48].map(v => `<option value="${v}" ${gs === v ? 'selected' : ''}>${v}px</option>`).join('')}
      </select>
    </div>
    <div class="tpl-view-row">
      <input type="checkbox" id="tpl-show-safe" ${ed.showSafeAreas ? 'checked' : ''}>
      <label for="tpl-show-safe">Safe areas</label>
    </div>
    <div class="tpl-view-row">
      <input type="checkbox" id="tpl-show-center" ${ed.showCenter ? 'checked' : ''}>
      <label for="tpl-show-center">Center guides</label>
    </div>
    ${hasOverlap ? '<div class="tpl-overlap-warn">⚠ Buttons overlap — may cause issues on some players</div>' : ''}`;

  // SECTION C — Typography
  const fontPct = Math.round((tpl.font.sizeRatio || 0.5) * 100) + '%';
  const typoSection = `
    <div class="tpl-ctl-col"><span class="tpl-ctl-label">Font family</span>
      <input type="text" id="tpl-font-search" class="tpl-font-search" placeholder="Search fonts…" value="${esc(ed.fontFilter || '')}">
      <select id="tpl-font-family" class="tpl-font-select" style="font-family:'${esc(curFont)}'">${fontOpts}</select>
    </div>
    ${sliderRowHTML('tpl-font-size2', 'Text size', 0.2, 0.9, 0.05, tpl.font.sizeRatio, fontPct)}
    ${swatchRowHTML('tpl-label-color', 'Label color', palHex(b.borderEntry))}`;

  // SECTION D — Template meta
  const metaSection = `
    <div class="tpl-ctl-col"><span class="tpl-ctl-label">Template name</span>
      <input type="text" id="tpl-name2" value="${esc(tpl.name)}" placeholder="Template name"></div>
    <div class="tpl-ctl-col"><span class="tpl-ctl-label">Description</span>
      <textarea id="tpl-desc" placeholder="Describe this template…" style="min-height:56px">${esc(tpl.description || '')}</textarea></div>
    <div class="tpl-meta-actions">
      <button class="btn btn-ghost btn-sm" id="tpl-revert" ${isDirty() ? '' : 'disabled'}>Revert to saved</button>
      <button class="btn btn-primary btn-sm" id="tpl-save" ${(isDirty() || ed.savedFlash) ? '' : 'disabled'}>${ed.savedFlash ? 'Saved ✓' : 'Save template'}</button>
    </div>
    <button class="btn btn-danger btn-sm" id="tpl-delete" style="margin-top:10px">Delete template</button>`;

  // SECTION A0 — Button layout mode (vertical stack vs horizontal studio bar)
  const isHoriz = b.layout === 'horizontal';
  const barOpacity = (typeof b.barOpacity === 'number') ? b.barOpacity : 0.92;
  const barHeight  = Number.isInteger(b.barHeight) ? b.barHeight : 140;
  const iconSize   = Number.isInteger(b.iconSize) ? b.iconSize : 52;
  const layoutModeSection = `
    <div class="tpl-segmented">
      <button class="tpl-seg ${!isHoriz ? 'on' : ''}" data-layout-mode="vertical">Vertical Stack</button>
      <button class="tpl-seg ${isHoriz ? 'on' : ''}" data-layout-mode="horizontal">Horizontal Bar</button>
    </div>
    ${isHoriz ? `
      <div class="tpl-sub-label">Bottom bar</div>
      ${swatchRowHTML('tpl-bar-color', 'Bar color', '#' + (b.barColor || '111111'))}
      ${sliderRowHTML('tpl-bar-opacity', 'Bar opacity', 0, 1, 0.01, barOpacity, Math.round(barOpacity * 100) + '%')}
      ${sliderRowHTML('tpl-bar-height', 'Bar height', 80, 300, 10, barHeight, barHeight + 'px')}
      ${sliderRowHTML('tpl-icon-size', 'Icon size', 30, 120, 4, iconSize, iconSize + 'px')}
    ` : ''}`;

  return `
    ${presetsBarHTML()}
    ${accordionHTML('layoutmode', 'Button Layout', layoutModeSection)}
    ${accordionHTML('bg', 'Background', bgSection)}
    ${accordionHTML('buttons', 'Buttons', btnSection)}
    ${accordionHTML('layout', 'Layout', layoutSection)}
    ${accordionHTML('type', 'Typography', typoSection)}
    ${accordionHTML('meta', 'Template', metaSection)}`;
}

function pageTemplates() {
  const ed  = state.templateEditor;
  const tpl = ed.draft;
  const ro  = isReadonly(ed.selectedId);

  const head = tpl ? `
    <div class="tpl-center-head">
      <div>
        <div class="tpl-detail-name">${esc(tpl.name)}${(!ro && isDirty()) ? ' •' : ''}</div>
        <div class="tpl-detail-desc">${esc(tpl.description || '')}</div>
      </div>
      <span class="badge ${ro ? 'badge-blue' : 'badge-green'}">${ro ? 'Built-in' : 'Custom'}</span>
    </div>` : '';

  const center = tpl ? `
    ${head}
    ${previewHTML()}
    ${activeStatusHTML()}
    ${ro ? `
      <div class="tpl-builtin-cta">
        <button class="btn tpl-duplicate-btn${_pulseBuiltin(ed.selectedId) ? ' tpl-pulse' : ''}" id="tpl-duplicate">✎ Duplicate to edit</button>
        <span class="tpl-builtin-hint">Built-in templates are read-only. Duplicate one to customize its colors, fonts, and layout.</span>
      </div>
      ${builtinSummaryHTML(tpl)}` : ''}`
    : `<div class="empty-state"><div class="empty-state-icon">🖌</div><div class="empty-state-text">Select a template to view it</div></div>`;

  const showEditor = !!tpl && !ro;
  const right = showEditor ? templateEditorHTML(tpl) : '';

  // A6: users landing here with menus disabled saw a fully interactive
  // designer whose work would never reach the disc. Make the state obvious
  // and enable-able in place (the Project tab toggle stays).
  const menusOffBanner = state.menusEnabled ? '' : `
    <div style="display:flex;align-items:center;gap:12px;background:var(--gold-glow);border:1px solid rgba(219,184,90,0.4);border-radius:10px;padding:12px 16px;margin-bottom:14px">
      <span style="font-size:18px">⚠️</span>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:700;color:var(--gold-bright)">Menus are OFF</div>
        <div style="font-size:12px;color:var(--text-secondary)">Designs here won't be burned to disc until menus are enabled (Beta — may not work on all players).</div>
      </div>
      <button class="btn btn-primary btn-sm" id="menus-banner-enable">Enable Menus</button>
    </div>`;

  return `
    <div class="page-header"><div class="page-header-left">
      <div class="page-title">Menu Designer</div>
      <div class="page-subtitle">Design the look of your interactive disc menu — pick a template, then customize it.</div>
    </div></div>
    ${menusOffBanner}
    <div class="menus-layout ${showEditor ? 'has-editor' : ''}">
      <div class="menus-browser">${designSelectorHTML()}</div>
      <div class="menus-center">${center}</div>
      <div class="menus-editor ${showEditor ? 'open' : ''}">
        <div class="menus-editor-inner card">${right}</div>
      </div>
    </div>`;
}

// ── Render ─────────────────────────────────────────────────────────────────────
function render() {
  document.body.classList.toggle('light-mode', state.lightMode);
  // Save scroll position before re-render
  const scroller = document.querySelector('.content');
  const scrollTop = scroller ? scroller.scrollTop : 0;

  document.getElementById('app').innerHTML = buildHTML();
  attachListeners();

  // Restore scroll position after re-render
  if (scrollTop > 0) {
    const restored = document.querySelector('.content');
    if (restored) restored.scrollTop = scrollTop;
  }
}

function buildHTML() {
  const { tools, project:p, tab, building } = state;
  const canBuild = !!(p.title && (p.mainVideo || (p.titles && p.titles.length > 0)));

  return `
    ${titlebarHTML(tools)}
    <div class="layout">
      ${sidebarHTML(p, canBuild)}
      <div class="main">
        ${tabbarHTML(p, tab)}
        <div class="content">
          ${tab==='project'   ? pageProject(p) : ''}
          ${tab==='chapters'  ? pageChapters(p, state.form.chapter) : ''}
          ${tab==='templates' ? pageTemplates() : ''}
        </div>
      </div>
    </div>
    ${building ? buildModalHTML() : ''}
    ${state.burning ? burnModalHTML() : ''}
    ${state.showWelcome ? welcomeModalHTML() : ''}
    ${state.showAbout ? aboutModalHTML() : ''}
    ${state.templateEditor.nameModal != null ? nameModalHTML() : ''}
    ${state.appDialog ? appDialogHTML() : ''}
  `;
}

// ── Titlebar ───────────────────────────────────────────────────────────────────
function titlebarHTML(tools) {
  const pill = (name, ok) => `<div class="tool-pill ${ok?'ok':'err'}"><div class="tool-dot ${ok?'ok':'err'}"></div>${name}</div>`;
  return `<div class="titlebar">
    <div style="width:72px;-webkit-app-region:no-drag"></div>
    <div class="titlebar-brand">
      <div class="titlebar-logo">💿</div>
      <span class="titlebar-name">Disc Forge</span>
      <span class="titlebar-version">${state.appVersion ? esc(state.appVersion) : ''}</span>
    </div>
    <div class="titlebar-spacer"></div>
    <div class="titlebar-tools">
      <button class="btn btn-ghost btn-sm" id="toggle-theme" style="font-size:14px;padding:4px 8px" title="Toggle theme">${state.lightMode ? '🌙' : '☀'}</button>
      <button class="btn btn-ghost btn-sm" id="about-btn" style="font-size:12px;padding:4px 8px">About</button>
      ${pill('FFmpeg',  tools.ffmpeg.found)}
      ${tools.tsmuxer.found ? pill('tsMuxeR', true) : '<div class="tool-pill warn"><div class="tool-dot warn"></div>tsMuxeR (optional)</div>'}
      ${pill('ffprobe', tools.ffprobe.found)}
    </div>
  </div>`;
}




// ── Sidebar ────────────────────────────────────────────────────────────────────
function discMeterHTML(p) {
  const DISC_SIZES = [
    { label: 'DVD-5',  gb: 4.7,  bytes: 4.7e9  },
    { label: 'BD-25',  gb: 25,   bytes: 25e9   },
    { label: 'BD-50',  gb: 50,   bytes: 50e9   },
    { label: 'BD-100', gb: 100,  bytes: 100e9  },
  ];

  // If we have a built ISO, use its actual size for accuracy.
  // Otherwise estimate per-title using probe data: video bitrate × duration,
  // plus AC3 audio estimate for lossless tracks, plus 50MB subtitle overhead,
  // then add 10% BD structure overhead.
  let usedBytes = 0;
  let usingActual = false;
  let usingProbe = false;

  if (state.builtIsoPath && state.builtIsoSize) {
    usedBytes = state.builtIsoSize;
    usingActual = true;
  } else {
    const allTitleFiles = [
      ...(p.mainVideo ? [{ path: p.mainVideo.path, size: p.mainVideo.size || 0, quality: p.mainVideo.videoQuality }] : []),
      ...(p.titles || []).map(t => ({ path: t.file?.path, size: t.file?.size || 0, quality: t.videoQuality })),
    ];
    let rawBytes = 0;
    let probeHits = 0;
    for (const { path: fp, size, quality } of allTitleFiles) {
      const est = estimateTitleBytes(fp, size, quality);
      rawBytes += est;
      if (fp && state.probeCache?.[fp]) probeHits++;
    }
    // Extras use raw file size (already in output format)
    (p.extras||[]).forEach(t => { if (t.file?.size) rawBytes += t.file.size * 0.6; });
    // Add 10% BD structure/multiplexing overhead
    usedBytes = Math.round(rawBytes * 1.1);
    usingProbe = probeHits > 0;
  }

  const selectedDisc = p.discSize || 'BD-25';
  const currentDisc = DISC_SIZES.find(d => d.label === selectedDisc) || DISC_SIZES[1];

  const pct = Math.min(100, (usedBytes / currentDisc.bytes) * 100);
  const usedGb = (usedBytes / 1e9).toFixed(2);
  const freeGb = Math.max(0, (currentDisc.bytes - usedBytes) / 1e9).toFixed(2);
  const barColor = pct > 90 ? '#e74c3c' : pct > 75 ? '#e67e22' : 'var(--gold)';
  const overFill = usedBytes > currentDisc.bytes;
  const label = usingActual ? usedGb + ' GB (actual ISO)' : (usingProbe ? '~' + usedGb + ' GB (probe estimate)' : '~' + usedGb + ' GB (rough estimate)');

  return `
    <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:12px;font-weight:600;color:var(--text-primary)">${label}</span>
      <select id="disc-size-select" style="font-size:10px;padding:2px 6px;height:22px;width:auto">
        ${DISC_SIZES.map(d => `<option ${selectedDisc===d.label?'selected':''}>${d.label}</option>`).join('')}
      </select>
    </div>
    <div style="background:var(--bg-input);border-radius:6px;height:10px;overflow:hidden;margin-bottom:6px;border:1px solid var(--border-dim)">
      <div style="height:100%;width:${pct.toFixed(1)}%;background:${overFill?'#e74c3c':barColor};border-radius:6px;transition:width 0.3s ease"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-tertiary)">
      <span style="color:${overFill?'#e74c3c':'inherit'}">${pct.toFixed(0)}% full${overFill?' ⚠ Over capacity!':''}</span>
      <span>Space remaining: ${freeGb} GB</span>
    </div>
    ${usingActual ? '' : usingProbe
      ? '<div style="font-size:9px;color:var(--text-tertiary);margin-top:4px;opacity:0.7">Estimate: video bitrate + AC3 audio + subtitles + 10% overhead</div>'
      : '<div style="font-size:9px;color:var(--text-tertiary);margin-top:4px;opacity:0.7">Rough estimate — add videos to get a more accurate size</div>'}
  `;
}

function sidebarHTML(p, canBuild) {
  return `<div class="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-project-title">${esc(p.title) || 'Untitled Project'}</div>
    </div>
    <div class="sidebar-output">
      <div class="sidebar-label">Output</div>
      <div class="output-path">${esc(p.outputDir) || 'Not set'}</div>
      <button class="btn btn-ghost btn-sm btn-full" id="pick-output">📂 Change folder</button>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button class="btn btn-ghost btn-sm" style="flex:1" id="save-project-btn">💾 Save</button>
        <button class="btn btn-ghost btn-sm" style="flex:1" id="load-project-btn">📂 Load</button>
      </div>
    </div>
    <div class="sidebar-disc-meter">
      <div class="sidebar-label">Disc Capacity</div>
      ${discMeterHTML(p)}
    </div>
    <div class="sidebar-spacer"></div>
    <div class="sidebar-build">
      <button class="btn-build" id="build-btn" ${!canBuild?'disabled':''}>
        <span class="btn-build-icon">🔨</span> Build Disc Image
      </button>
      ${!canBuild?'<p style="color:var(--text-tertiary);font-size:11px;text-align:center;margin-top:8px;line-height:1.5">Add a disc title and<br>at least one video to get started</p>':''}
      ${state.builtIsoPath ? `
        <button class="btn btn-ghost btn-full" id="burn-btn" style="margin-top:10px;border-color:rgba(220,80,80,0.4);color:#e05050">
          🔥 Burn to Disc
        </button>` : ''}
    </div>
  </div>`;
}

// ── Tab Bar ────────────────────────────────────────────────────────────────────
function tabbarHTML(p, activeTab) {
  const counts = { chapters: p.chapters.length };
  return `<div class="tabbar">
    ${TABS.map(t=>`
      <button class="tab-btn ${t.id===activeTab?'active':''}" data-tab="${t.id}">
        <span class="tab-icon">${t.icon}</span>
        ${t.label}
        ${counts[t.id]>0?`<span class="tab-count">${counts[t.id]}</span>`:''}
      </button>`).join('')}
  </div>`;
}

// ── Page: Project ─────────────────────────────────────────────────────────────
function pageProject(p) {
  const t = state.tools;

  return `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Project Settings</div>
        <div class="page-subtitle">Configure disc metadata, source video, and output format</div>
      </div>
    </div>



    <div class="card" style="margin-bottom:16px">
      <div class="card-header">
        <div class="card-icon">📋</div>
        <div><div class="card-title">Disc Metadata</div><div class="card-subtitle">Title and description shown in disc menus</div></div>
      </div>
      <div class="card-body">
        <div class="grid-2">
          <div class="field">
            <label class="field-label">Disc Title</label>
            <input type="text" id="proj-title" value="${esc(p.title)}" placeholder="My Feature Film" />
          </div>
          <div class="field">
            <label class="field-label">Disc Label</label>
            <input type="text" id="proj-label" value="${esc(p.discLabel)}" placeholder="MY_FILM_2024" />
          </div>
        </div>
        <div class="field">
          <label class="field-label">Description</label>
          <textarea id="proj-desc" placeholder="Brief description of disc content…">${esc(p.description)}</textarea>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-header">
        <div class="card-icon">⚙️</div>
        <div><div class="card-title">Video Format</div><div class="card-subtitle">Target resolution and codec for the disc</div></div>
      </div>
      <div class="card-body">
        <div class="grid-2">
          <div class="field">
            <label class="field-label">Resolution</label>
            <select id="proj-res">${RESOLUTIONS.map(r=>`<option ${p.resolution===r?'selected':''}>${r}</option>`).join('')}</select>
          </div>
          <div class="field">
            <label class="field-label">Video Codec</label>
            <select id="proj-vcodec">${VIDEO_FMTS.map(r=>`<option ${p.videoFormat===r?'selected':''}>${r}</option>`).join('')}</select>
          </div>
        </div>
        <div style="margin-top:12px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text-secondary)">
            <input type="checkbox" id="menus-enabled" ${state.menusEnabled ? 'checked' : ''} style="width:14px;height:14px">
            Menus (Beta — may not work on all players)
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text-secondary);margin-top:6px">
            <input type="checkbox" id="use-splash" ${p.useSplash ? 'checked' : ''} style="width:14px;height:14px">
            Add splash screen before playback
          </label>
          ${state.menusEnabled ? `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text-secondary);margin-top:6px">
            <input type="checkbox" id="use-ig-menu" ${p.useIGMenu ? 'checked' : ''} style="width:14px;height:14px">
            Add interactive episode menu [experimental]
          </label>` : ''}
          ${p.useIGMenu ? `
          <div style="background:var(--bg-secondary);padding:10px 12px;border-radius:8px;margin-top:8px;display:flex;flex-direction:column;gap:8px">
            <div style="font-size:11px;color:var(--text-tertiary)">Menu appearance — template, background, and button colors — is designed in the <b>Menus</b> tab. Set per-episode button labels below.</div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label style="font-size:12px;color:var(--text-secondary);margin-bottom:2px">Button Labels</label>
              ${(() => {
                const _igTitles = [
                  ...(p.mainVideo ? [p.mainVideo] : []),
                  ...(p.titles || []).map(t => t.file)
                ];
                if (_igTitles.length === 0) return '<span style="font-size:11px;color:var(--text-tertiary)">Add videos above to configure labels</span>';
                return _igTitles.map((f, i) => {
                  const val = esc((p.igMenuConfig?.buttonLabels||[])[i]||'');
                  return '<div style="display:flex;gap:8px;align-items:center">' +
                    '<span style="font-size:11px;color:var(--text-tertiary);min-width:60px">Ep ' + (i+1) + '</span>' +
                    '<input type="text" class="ig-label-input" data-idx="' + i + '" value="' + val + '" placeholder="Play Episode ' + (i+1) + '" style="flex:1;font-size:12px;padding:3px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary)">' +
                    '</div>';
                }).join('');
              })()}
            </div>
          </div>` : ''}
          ${p.useSplash ? `
          <div style="margin-top:8px;padding:10px 12px;background:var(--bg-secondary);border-radius:8px;display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;gap:10px;align-items:center">
              <label style="font-size:12px;color:var(--text-secondary);min-width:52px">Duration</label>
              <select id="splash-duration" style="font-size:12px;padding:3px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary)">
                ${[3,5,8,10].map(d=>`<option value="${d}"${(p.splashDuration||5)===d?' selected':''} >${d}s</option>`).join('')}
              </select>
              <label style="font-size:12px;color:var(--text-secondary);min-width:38px;margin-left:8px">Color</label>
              <input type="color" id="splash-color" value="#${p.splashColor||'1a1a2e'}" style="width:36px;height:24px;cursor:pointer;border:none;border-radius:4px;padding:1px;background:none">
              <span style="font-size:11px;color:var(--text-tertiary)">(fallback when no image)</span>
            </div>
            <div>
              <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">Custom image (optional)</label>
              <div class="drop-zone compact ${p.splashPngPath?'has-file':''}" id="pick-splash-png" style="cursor:pointer">
                <div class="dz-icon" style="width:28px;height:28px;font-size:14px">🖼</div>
                <div class="dz-text">
                  <div class="dz-label ${p.splashPngPath?'active':''}">${p.splashPngPath ? esc(p.splashPngPath.split('/').pop()) : 'Click to choose a PNG image'}</div>
                  <div class="dz-hint">${p.splashPngPath ? '<button class="btn btn-ghost btn-xs" id="clear-splash-png">Remove</button>' : 'PNG · overrides color above'}</div>
                </div>
              </div>
            </div>
          </div>` : ''}
        </div>
      </div>
    </div>

    ${(p.chapters && p.chapters.length > 0) ? `
    <div class="card" style="margin-bottom:16px">
      <div class="card-header">
        <div class="card-icon">🎞️</div>
        <div><div class="card-title">Chapter Menu</div><div class="card-subtitle">A Scene Selection screen generated from your ${p.chapters.length} chapter mark${p.chapters.length === 1 ? '' : 's'}</div></div>
      </div>
      <div class="card-body">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text-secondary)">
          <input type="checkbox" id="chapter-menu-enabled" ${p.chapterMenu?.enabled ? 'checked' : ''} style="width:14px;height:14px">
          Enable Scene Selection menu
        </label>
        ${p.chapterMenu?.enabled ? `
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;gap:10px;align-items:center">
            <label style="font-size:12px;color:var(--text-secondary);min-width:96px">Main-menu label</label>
            <input type="text" id="chapter-menu-label" value="${esc(p.chapterMenu?.label || 'Scene Selection')}" placeholder="Scene Selection" style="flex:1;font-size:12px;padding:3px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary)">
          </div>
          <div style="display:flex;gap:10px;align-items:center">
            <label style="font-size:12px;color:var(--text-secondary);min-width:96px">Template</label>
            <select id="chapter-menu-template" style="flex:1;font-size:12px;padding:3px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary)">
              <option value="" ${!p.chapterMenu?.templateId ? 'selected' : ''}>Same as main menu</option>
              ${templateOptionsHTML(p.chapterMenu?.templateId || '')}
            </select>
          </div>
          <div style="font-size:11px;color:var(--text-tertiary)">Design this screen in the Menus tab — switch to “Chapter Select” above the preview. (Disc output wiring lands in a later update.)</div>
        </div>` : ''}
      </div>
    </div>` : ''}

    <div class="card">
      <div class="card-header">
        <div class="card-icon">🎬</div>
        <div><div class="card-title">Video Titles</div><div class="card-subtitle">Add one or more video files — each becomes a separate title on the disc</div></div>
      </div>
      <div class="card-body">
        <button class="btn btn-primary btn-sm" id="add-title-btn" style="margin-bottom:16px">+ Add Videos</button>
        ${(() => {
          const allTitles = [
            ...(p.mainVideo ? [{ id:'__main__', file: p.mainVideo, label: p.mainVideo.name.replace(/\.[^.]+$/, '') }] : []),
            ...(p.titles || [])
          ];
          if (allTitles.length === 0) return `
            <div class="empty-state">
              <div class="empty-state-icon">🎬</div>
              <div class="empty-state-text">No videos added yet — click + Add Videos to get started</div>
            </div>`;
          return `<div class="track-list">${allTitles.map((t, i) => {
            const compat = state.titleCompatibility?.[t.file?.path];
            const compatBadge = compat
              ? (compat.compatible
                ? `<span class="badge badge-green" title="BD-compatible — passthrough mode">⚡ Passthrough</span>`
                : `<span class="badge badge-orange" title="${esc(compat.reasons?.join(', ') || 'Needs transcoding')}">🔄 Transcode</span>`)
              : '';
            const tQuality = t.videoQuality || 'passthrough';
            const qMode = VIDEO_QUALITY_MODES.find(m => m.id === tQuality) || VIDEO_QUALITY_MODES[0];
            const qualityBadge = tQuality === 'passthrough'
              ? `<span class="badge badge-green" title="Video quality: stream copy, original quality">Copy</span>`
              : `<span class="badge badge-yellow" title="Video quality: CRF ${qMode.crf} re-encode — ${qMode.label}">CRF ${qMode.crf}</span>`;
            const estBytes = estimateTitleBytes(t.file?.path, t.file?.size || 0, tQuality);
            const estGb = estBytes > 0 ? (estBytes / 1e9).toFixed(2) + ' GB' : '';
            return `
            <div class="track-card" style="flex-direction:column;align-items:stretch;gap:8px">
              <div style="display:flex;align-items:center;gap:10px">
                <span class="track-num">${i + 1}</span>
                <div class="track-icon-wrap">🎬</div>
                <div class="track-body">
                  <div class="track-detail" style="font-size:11px">${esc(t.file.name)}</div>
                </div>
                <div class="track-actions">
                  ${i === 0 && p.mainVideo ? '<span class="badge badge-gold">Main</span>' : ''}
                  ${compatBadge}
                  ${qualityBadge}
                  ${(() => {
                    // Reorder arrows for ADDITIONAL titles only (the main video
                    // stays first — its slot determines the passthrough check
                    // and FirstPlay wiring). tIdx = index within project.titles.
                    if (t.id === '__main__') return '';
                    const tIdx = i - (p.mainVideo ? 1 : 0);
                    const last = (p.titles || []).length - 1;
                    return `<button class="btn btn-ghost btn-xs" data-move-title="${tIdx}" data-move-dir="-1" title="Move up" ${tIdx === 0 ? 'disabled' : ''}>↑</button>` +
                           `<button class="btn btn-ghost btn-xs" data-move-title="${tIdx}" data-move-dir="1" title="Move down" ${tIdx >= last ? 'disabled' : ''}>↓</button>`;
                  })()}
                  <button class="btn btn-danger" data-rm-title="${t.id}">✕</button>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;padding-left:60px">
                <label style="font-size:11px;color:var(--text-tertiary);white-space:nowrap">Menu name:</label>
                <input type="text" class="title-label-input" id="tl-${t.id}" data-title-id="${t.id}" value="${esc(t.label || t.file.name.replace(/\.[^.]+$/, ''))}" placeholder="Episode name shown in menu" style="flex:1;font-size:12px;padding:4px 8px" />
              </div>
              <div style="display:flex;align-items:center;gap:8px;padding-left:60px">
                <label style="font-size:11px;color:var(--text-tertiary);white-space:nowrap">Video quality:</label>
                <select class="title-quality-select" data-title-id="${t.id}" style="font-size:11px;padding:3px 6px">
                  ${VIDEO_QUALITY_MODES.map(m => `<option value="${m.id}" ${tQuality === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
                </select>
                ${estGb ? `<span style="font-size:10px;color:var(--text-tertiary)">~${estGb}</span>` : ''}
              </div>
            </div>`;
          }).join('')}</div>
          <div style="margin-top:10px;display:flex;align-items:center;gap:8px">
            <label style="font-size:11px;color:var(--text-tertiary);white-space:nowrap">Apply to all:</label>
            <select id="quality-apply-select" style="font-size:11px;padding:3px 6px">
              ${VIDEO_QUALITY_MODES.map(m => `<option value="${m.id}">${m.label}</option>`).join('')}
            </select>
            <button class="btn btn-ghost btn-sm" id="quality-apply-all">Apply</button>
          </div>
          ${(() => {
            const mainCompat = state.titleCompatibility?.[p.mainVideo?.path];
            if (!mainCompat) return '';
            return `<div style="margin-top:8px;display:flex;align-items:center;gap:10px">
              <label class="check-label" style="font-size:12px">
                <input type="checkbox" id="force-transcode" ${p.forceTranscode?'checked':''} />
                Force re-encode (override passthrough)
              </label>
              ${mainCompat.compatible ? `<span style="font-size:11px;color:var(--text-tertiary)">Estimated: fast (passthrough)</span>` : `<span style="font-size:11px;color:var(--text-tertiary)">Estimated: slower (transcoding)</span>`}
            </div>`;
          })()}`;
        })()}
        ${probeDisplay()}
        <div style="margin-top:12px">
          <div class="info-panel gold">
            <div class="info-panel-title">💡 Encoding pipeline</div>
            <ul>
              <li>First video becomes the main feature; additional videos become separate titles</li>
              <li>Video is stream-copied when the codec is already BD-compatible (no re-encode)</li>
              <li>tsMuxeR compiles the BD navigation — required for hardware player compatibility</li>
              <li>macOS hdiutil packages the final UDF 2.5 + ISO 9660 hybrid disc image</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    ${(state.embeddedTracks.length > 0 || p.audioTracks.length > 0 || p.subtitleTracks.length > 0 || p.chapters.length > 0) ? `
    <div class="card" style="margin-top:16px">
      <div class="card-header">
        <div class="card-icon">📋</div>
        <div><div class="card-title">Track Summary</div><div class="card-subtitle">Select which tracks to burn to disc — uncheck to exclude</div></div>
      </div>
      <div class="card-body">
        ${state.embeddedTracks.length > 0 ? `
          <div style="margin-bottom:16px">
            <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--text-tertiary);text-transform:uppercase;margin-bottom:8px">📹 Embedded Tracks (from video files)</div>
            ${(() => {
              const audio = state.embeddedTracks.filter(t => t.role === 'audio');
              const subs  = state.embeddedTracks.filter(t => t.role === 'subtitle');
              return [
                audio.length > 0 ? `<div style="margin-bottom:10px">
                  <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:6px;font-weight:600">🔊 Audio</div>
                  ${audio.map(t => `
                    <div class="track-card" style="padding:10px 12px;display:flex;align-items:center;gap:12px;margin-bottom:4px">
                      <input type="checkbox" ${t.included!==false?'checked':''} data-toggle-embedded="${t.id}" style="width:16px;height:16px;cursor:pointer;accent-color:var(--gold)" />
                      <div style="flex:1;min-width:0">
                        <div style="font-size:13px;font-weight:600;color:var(--text-primary)">${esc(t.label||t.language)}</div>
                        <div style="font-size:11px;color:var(--text-tertiary)">${t.language} · ${t.codec} · Stream #${t.streamIndex} · ${esc(t.sourceFileName)}</div>
                      </div>
                      <div style="display:flex;gap:4px">
                        <span class="badge badge-blue">${t.language}</span>
                        <span class="badge badge-green">${t.format}</span>
                        ${t.isDefault?'<span class="badge badge-gold">Default</span>':''}
                      </div>
                    </div>`).join('')}
                </div>` : '',
                subs.length > 0 ? `<div>
                  <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:6px;font-weight:600">💬 Subtitles</div>
                  ${subs.map(t => `
                    <div class="track-card" style="padding:10px 12px;display:flex;align-items:center;gap:12px;margin-bottom:4px">
                      <input type="checkbox" ${t.included!==false?'checked':''} data-toggle-embedded="${t.id}" style="width:16px;height:16px;cursor:pointer;accent-color:var(--gold)" />
                      <div style="flex:1;min-width:0">
                        <div style="font-size:13px;font-weight:600;color:var(--text-primary)">${esc(t.description||t.language)}</div>
                        <div style="font-size:11px;color:var(--text-tertiary)">${t.language} · ${t.codec} · Stream #${t.streamIndex}${t.isForced?' · Forced':''}${t.isSDH?' · SDH':''} · ${esc(t.sourceFileName)}</div>
                      </div>
                      <div style="display:flex;gap:4px">
                        <span class="badge badge-blue">${t.language}</span>
                        ${t.isForced?'<span class="badge badge-gold">Forced</span>':''}
                        ${t.isSDH?'<span class="badge badge-purple">SDH</span>':''}
                      </div>
                    </div>`).join('')}
                </div>` : ''
              ].filter(Boolean).join('');
            })()}
          </div>` : ''}
        ${p.audioTracks.length > 0 ? `
          <div style="margin-bottom:16px">
            <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--text-tertiary);text-transform:uppercase;margin-bottom:8px">🔊 Audio Tracks</div>
            ${p.audioTracks.map((t,i) => `
              <div class="track-card" style="padding:10px 12px;display:flex;align-items:center;gap:12px;margin-bottom:6px">
                <input type="checkbox" ${t.excluded?'':'checked'} data-toggle-audio="${t.id}" style="width:16px;height:16px;cursor:pointer;accent-color:var(--gold)" />
                <span class="track-num" style="min-width:24px">${i+1}</span>
                <div style="flex:1;min-width:0">
                  <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:2px">${esc(t.label)||t.language}</div>
                  <div style="font-size:11px;color:var(--text-tertiary)">${t.language} · ${t.format}${t.isDefault?' · <strong>Default</strong>':''}${t.file?(' · '+esc(t.file.name)):''}</div>
                </div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">
                  <span class="badge badge-blue">${t.language}</span>
                  <span class="badge badge-green">${t.format}</span>
                  ${t.isDefault?'<span class="badge badge-gold">Default</span>':''}
                </div>
              </div>`).join('')}
          </div>` : ''}
        ${p.subtitleTracks.length > 0 ? `
          <div style="margin-bottom:16px">
            <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--text-tertiary);text-transform:uppercase;margin-bottom:8px">💬 Subtitle Tracks</div>
            ${p.subtitleTracks.map((t,i) => `
              <div class="track-card" style="padding:10px 12px;display:flex;align-items:center;gap:12px;margin-bottom:6px">
                <input type="checkbox" ${t.excluded?'':'checked'} data-toggle-sub="${t.id}" style="width:16px;height:16px;cursor:pointer;accent-color:var(--gold)" />
                <span class="track-num" style="min-width:24px">${i+1}</span>
                <div style="flex:1;min-width:0">
                  <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:2px">${esc(t.description)||t.language}</div>
                  <div style="font-size:11px;color:var(--text-tertiary)">${t.language} · ${t.format}${t.isForced?' · Forced':''}${t.isSDH?' · SDH':''}${t.file?(' · '+esc(t.file.name)):''}</div>
                </div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">
                  <span class="badge badge-blue">${t.language}</span>
                  ${t.isForced?'<span class="badge badge-gold">Forced</span>':''}
                  ${t.isSDH?'<span class="badge badge-purple">SDH</span>':''}
                </div>
              </div>`).join('')}
          </div>` : ''}
        ${p.chapters.length > 0 ? `
          <div>
            <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--text-tertiary);text-transform:uppercase;margin-bottom:8px">≡ Chapters</div>
            ${p.chapters.map((ch,i) => `
              <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border-dim)">
                <span style="color:var(--gold);font-size:11px;font-weight:700;width:20px">${i+1}</span>
                <div style="flex:1;font-size:13px;color:var(--text-primary)">${esc(ch.name)}</div>
                <span style="font-size:11px;color:var(--text-tertiary)">${ch.time}</span>
              </div>`).join('')}
          </div>` : ''}
      </div>
    </div>` : ''}`;
}

// ── Page: Chapters ─────────────────────────────────────────────────────────────
function pageChapters(p, f) {
  return `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Chapters</div>
        <div class="page-subtitle">Define navigation markers — viewers can jump straight to them with the remote</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" id="import-chapters-btn">📥 Import from Video</button>
        ${p.chapters.length > 0 ? '<button class="btn btn-ghost btn-sm" id="gen-thumbs-btn">🖼 Generate Thumbnails</button>' : ''}
        ${p.chapters.length > 0 ? '<button class="btn btn-ghost btn-sm" id="clear-chapters-btn" style="color:#e05050">🗑 Clear All</button>' : ''}
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><div class="card-icon">➕</div><div><div class="card-title">New Chapter</div></div></div>
      <div class="card-body">
        <div class="grid-2" style="margin-bottom:14px">
          <div class="field"><label class="field-label">Chapter Name</label>
            <input type="text" id="ch-name" value="${esc(f.name)}" placeholder="Opening Scene" /></div>
          <div class="field"><label class="field-label">Timecode HH:MM:SS</label>
            <input type="text" id="ch-time" value="${esc(f.time)}" placeholder="00:00:00" style="font-family:var(--font-mono)" /></div>
        </div>
        <div class="drop-zone compact ${f.thumb?'has-file':''}" id="pick-ch-thumb" style="margin-bottom:14px">
          <div class="dz-icon" style="width:32px;height:32px;font-size:16px">🖼</div>
          <div class="dz-text"><div class="dz-label ${f.thumb?'active':''}">${f.thumb?esc(f.thumb.name):'Chapter thumbnail (optional)'}</div></div>
        </div>
        <button class="btn btn-primary btn-sm" id="add-chapter" ${!f.name||!f.time?'disabled':''}>+ Add Chapter</button>
      </div>
    </div>
    ${p.chapters.length===0
      ? `<div class="empty-state"><div class="empty-state-icon">≡</div><div class="empty-state-text">No chapters yet — add one above, or use Import from Video</div></div>`
      : `<div class="track-list">${p.chapters.map((c,i)=>`
          <div class="track-card">
            <span class="track-num">${i+1}</span>
            ${c.thumb && c.thumb.path
              ? `<img src="file://${c.thumb.path}" style="width:80px;height:45px;object-fit:cover;border-radius:4px;flex-shrink:0;border:1px solid var(--border-dim)" />`
              : `<div class="track-icon-wrap">≡</div>`}
            <div class="track-body"><div class="track-name">${esc(c.name)}</div></div>
            <div class="track-actions">
              <code style="font-family:var(--font-mono);font-size:12px;color:var(--gold);background:rgba(219,184,90,0.1);padding:3px 8px;border-radius:5px;border:1px solid rgba(219,184,90,0.2)">${c.time}</code>
              <button class="btn btn-danger" data-rm-chapter="${c.id}">✕</button>
            </div>
          </div>`).join('')}</div>`}`;
}

// ── Build Modal ────────────────────────────────────────────────────────────────
function buildModalHTML() {
  const { buildSteps:steps, buildCurrentStep:cur, buildDone, buildError, builtIsoPath, builtIsoSize, project:p } = state;
  const pct = steps.length ? Math.round((cur/steps.length)*100) : 0;

  // Elapsed time — frozen once the build finishes so the counter stops ticking
  const now = Date.now();
  if (!state.buildStartTime && !buildDone && !buildError) state.buildStartTime = now;
  const endTs = state.buildEndTime || (buildDone ? now : null);
  const elapsed = state.buildStartTime
    ? Math.floor(((endTs || now) - state.buildStartTime) / 1000)
    : 0;
  function fmtSec(s) { return Math.floor(s/60) + 'm ' + (s%60) + 's'; }
  const elapsedStr = elapsed > 0 ? fmtSec(elapsed) : '';

  // Overall ETA (progress-based)
  let etaStr = '';
  if (!buildDone && pct > 5 && pct < 100 && elapsed > 5) {
    const totalEst = Math.round(elapsed / (pct / 100));
    const remaining = Math.max(0, totalEst - elapsed);
    etaStr = remaining > 0 ? '~' + fmtSec(remaining) + ' remaining' : 'Almost done...';
  }

  // Per-title ETA — average duration of already-completed title steps
  const titleStepIdxs = steps.reduce(function(acc, s, i) {
    if (s.startsWith('Processing title')) acc.push(i); return acc;
  }, []);
  const completedTitleDurations = [];
  for (var ti = 0; ti < titleStepIdxs.length; ti++) {
    const idx = titleStepIdxs[ti];
    const nextIdx = titleStepIdxs[ti + 1] !== undefined ? titleStepIdxs[ti + 1] : idx + 1;
    if (idx < cur && state.stepStartTimes[idx] && state.stepStartTimes[nextIdx]) {
      completedTitleDurations.push(state.stepStartTimes[nextIdx] - state.stepStartTimes[idx]);
    }
  }
  const avgTitleMs = completedTitleDurations.length
    ? completedTitleDurations.reduce(function(a,b){return a+b;},0) / completedTitleDurations.length
    : 0;

  if (buildError) {
    var friendlyError = buildError;
    var hint = '';
    if (buildError.includes('ffmpeg') && buildError.includes('not found')) {
      friendlyError = 'FFmpeg is not installed or could not be found.';
      hint = 'Install FFmpeg via Homebrew: brew install ffmpeg';
    } else if (buildError.includes('tsMuxeR') || buildError.includes('tsmuxer')) {
      friendlyError = 'tsMuxeR could not be found.';
      hint = 'Download tsMuxeR from github.com/justdan96/tsMuxeR or install via Homebrew.';
    } else if (buildError.includes('No such file') || buildError.includes('ENOENT')) {
      friendlyError = 'A required file could not be found.';
      hint = 'Make sure your video files are still accessible and try again.';
    } else if (buildError.includes('Permission denied')) {
      friendlyError = 'Permission denied writing to the output folder.';
      hint = 'Try changing the output folder to your Desktop or Downloads.';
    } else if (buildError.includes('No space left') || buildError.includes('ENOSPC')) {
      friendlyError = 'Not enough disk space to build the disc image.';
      hint = 'Free up disk space and try again. BD-25 images require ~25GB.';
    } else if (buildError.includes('Invalid data') || buildError.includes('moov atom')) {
      friendlyError = 'The video file appears to be corrupted or incomplete.';
      hint = 'Try re-encoding the file with FFmpeg or use a different source.';
    }
    return '<div class="modal-backdrop"><div class="modal-box">' +
      '<div class="modal-disc-icon" style="background:var(--red-dim);border-color:rgba(192,57,43,0.4)">❌</div>' +
      '<div class="modal-title">Build Failed</div>' +
      '<div style="font-size:13px;color:var(--red);margin-bottom:10px;font-weight:500">' + esc(friendlyError) + '</div>' +
      (hint ? '<div style="font-size:12px;color:var(--text-secondary);background:var(--bg-sunken);border:1px solid var(--border-dim);border-radius:6px;padding:8px 12px;margin-bottom:10px">' + esc(hint) + '</div>' : '') +
      '<details style="margin-bottom:12px"><summary style="font-size:11px;color:var(--text-tertiary);cursor:pointer">Show technical details</summary>' +
      '<pre style="background:var(--bg-sunken);border:1px solid var(--border-dim);border-radius:6px;padding:10px;font-size:10px;color:var(--red);text-align:left;max-height:140px;overflow-y:auto;font-family:var(--font-mono);white-space:pre-wrap;margin-top:6px">' + esc(buildError) + '</pre></details>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="close-modal">Close</button></div>' +
      '</div></div>';
  }

  if (buildDone) {
    const isoSizeStr = builtIsoSize ? (builtIsoSize >= 1e9
      ? (builtIsoSize/1e9).toFixed(2) + ' GB'
      : (builtIsoSize/1e6).toFixed(0) + ' MB') : null;
    return '<div class="modal-backdrop"><div class="modal-box">' +
      '<div class="modal-success-ring">✅</div>' +
      '<div class="modal-title" style="color:var(--gold-bright)">Build Complete!</div>' +
      (isoSizeStr ? '<div style="font-size:22px;font-weight:700;color:var(--text-primary);margin-bottom:4px">' + isoSizeStr + '</div>' +
        '<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:10px">ISO file size</div>' : '') +
      '<div class="modal-sub">' + p.audioTracks.length + ' audio · ' + p.subtitleTracks.length + ' subtitles · ' + p.chapters.length + ' chapters · ' + p.extras.length + ' extras</div>' +
      (elapsedStr ? '<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:8px">Completed in ' + elapsedStr + '</div>' : '') +
      '<div class="iso-path">' + esc(builtIsoPath||'') + '</div>' +
      (state.vlcMsg ? '<div style="font-size:12px;color:var(--text-tertiary);margin:6px 0 2px">' + esc(state.vlcMsg) + '</div>' : '') +
      '<div class="modal-actions">' +
      '<button class="btn btn-ghost" id="close-modal">Close</button>' +
      '<button class="btn btn-ghost" id="preview-vlc">▶ Preview in VLC</button>' +
      '<button class="btn btn-primary" id="reveal-iso">Show in Finder</button>' +
      '</div></div></div>';
  }

  const stepsHTML = steps.map(function(s,i) {
    const cls = i<cur?'done':i===cur?'active':'wait';
    const detail = state.stepDetails[i] ? ' <span style="color:var(--text-tertiary);font-size:10px;margin-left:6px">— ' + esc(state.stepDetails[i]) + '</span>' : '';
    // For active title steps, show ETA based on average completed title duration
    let titleEta = '';
    if (cls === 'active' && s.startsWith('Processing title') && avgTitleMs > 0) {
      const remaining = titleStepIdxs.filter(function(j){return j>=i;}).length;
      const etaSec = Math.round(remaining * avgTitleMs / 1000);
      if (etaSec > 3) titleEta = ' <span style="color:var(--text-tertiary);font-size:10px;margin-left:6px">~' + fmtSec(etaSec) + ' remaining</span>';
    }
    return '<div class="build-step"><div class="step-indicator ' + cls + '">' + (i<cur?'✓':i+1) + '</div>' +
      '<span class="step-text ' + cls + '">' + s + detail + titleEta + '</span></div>';
  }).join('');

  return '<div class="modal-backdrop"><div class="modal-box">' +
    '<div class="modal-disc-icon">💿</div>' +
    '<div class="modal-title">Building Disc Image</div>' +
    '<div class="modal-sub"><strong style="color:var(--text-primary)">' + esc(p.title||'Untitled') + '</strong></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-tertiary);margin-bottom:6px">' +
    '<span>' + pct + '% complete' + (elapsedStr ? ' · ' + elapsedStr + ' elapsed' : '') + '</span>' +
    '<span>' + etaStr + '</span></div>' +
    '<div class="progress-bar-wrap" style="margin-bottom:16px"><div class="progress-bar-fill" style="width:' + pct + '%;transition:width 0.5s ease"></div></div>' +
    '<div class="build-steps">' + stepsHTML + '</div>' +
    '<div class="ffmpeg-log" id="ffmpeg-log">' + esc(state.ffmpegLog||'Starting...') + '</div>' +
    '</div></div>';
}

function burnModalHTML() {
  const { burnStatus, burnMessage, burnDone, burnError, burnPercent, burnDriveInfo } = state;

  if (burnError) return `<div class="modal-backdrop"><div class="modal-box">
    <div class="modal-disc-icon" style="background:var(--red-dim);border-color:rgba(192,57,43,0.4)">❌</div>
    <div class="modal-title">Burn Failed</div>
    <pre style="background:var(--bg-sunken);border:1px solid var(--border-dim);border-radius:var(--radius-md);padding:12px;font-size:11px;color:var(--red);text-align:left;max-height:160px;overflow-y:auto;font-family:var(--font-mono);white-space:pre-wrap;margin-bottom:16px">${esc(burnError)}</pre>
    <div class="modal-actions"><button class="btn btn-ghost" id="close-burn-modal">Close</button></div>
  </div></div>`;

  if (burnDone) return `<div class="modal-backdrop"><div class="modal-box">
    <div class="modal-success-ring">💿</div>
    <div class="modal-title" style="color:var(--gold-bright)">Burn Complete!</div>
    <div class="modal-sub" style="white-space:pre-wrap">${esc(burnMessage || 'Burn complete. You may eject the disc.')}</div>
    ${state.ejectMsg ? `<div style="font-size:12px;color:var(--text-tertiary);margin:6px 0 2px">${esc(state.ejectMsg)}</div>` : ''}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="close-burn-modal">Done</button>
      <button class="btn btn-primary" id="eject-disc">⏏ Eject Disc</button>
    </div>
  </div></div>`;

  // Drive info panel
  const drivePanel = burnDriveInfo ? (() => {
    const d = burnDriveInfo;
    const driveName = d.drives?.[0]?.name || 'Optical Drive';
    // Disc-presence detection is not part of the hdiutil burn flow; show the burner
    // name and a neutral status line. (Legacy discStatus is honored if present.)
    const discOk = d.discStatus?.hasDisc;
    const discLabel = d.discStatus
      ? (discOk
          ? (d.discStatus.isBlank ? (d.discStatus.isBD ? 'Blank BD-R detected' : 'Blank disc detected') : 'Disc detected (check it is blank)')
          : 'No disc detected — insert a blank BD-R')
      : 'Writing to the inserted BD-R…';
    return `<div style="background:var(--bg-sunken);border:1px solid var(--border-dim);border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:var(--text-secondary)">
      <div style="font-weight:600;color:var(--text-primary);margin-bottom:4px">💿 ${esc(driveName)}</div>
      <div style="${(d.discStatus && !discOk)?'color:var(--red)':'color:var(--text-secondary)'}">${discLabel}</div>
      ${d.deviceNode ? `<div style="color:var(--text-tertiary);font-family:var(--font-mono);font-size:11px;margin-top:2px">${esc(d.deviceNode)}</div>` : ''}
    </div>`;
  })() : '';

  const pct = burnPercent != null ? burnPercent : (burnStatus==='done'?100:burnStatus==='burning'?30:5);
  const pctLabel = burnPercent != null ? Math.round(burnPercent) + '%' : '';

  return `<div class="modal-backdrop"><div class="modal-box">
    <div class="modal-disc-icon" style="animation:spin 2s linear infinite;display:inline-flex">💿</div>
    <div class="modal-title">Burning Disc</div>
    <div class="modal-sub">Do not eject the disc or close the app.</div>
    ${drivePanel}
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-tertiary);margin-bottom:4px">
      <span>${burnStatus === 'starting' ? 'Preparing...' : burnStatus === 'burning' ? 'Writing...' : 'Finalizing...'}</span>
      <span>${pctLabel}</span>
    </div>
    <div class="progress-bar-wrap" style="margin-bottom:12px">
      <div class="progress-bar-fill" style="width:${pct}%;transition:width 0.5s ease"></div>
    </div>
    <div class="ffmpeg-log" style="text-align:left;max-height:80px;overflow-y:auto">${esc(burnMessage||'Preparing...')}</div>
  </div></div>`;
}

// ── Welcome / Onboarding Modal ────────────────────────────────────────────────
function welcomeModalHTML() {
  const steps = [
    { icon:'🎬', title:'Add your videos', desc:'Go to the Project tab and click "Add Videos" to add one or more MKV, MP4, or M2TS files. Each file becomes a title on the disc.' },
    { icon:'🔊', title:'Choose your tracks', desc:'The app auto-detects all embedded audio and subtitle tracks. Check or uncheck exactly what you want included.' },
    { icon:'🖌', title:'Pick a menu (optional)', desc:'Open the Menus tab, enable menus, and choose a template. A full-screen preview shows exactly how the disc menu will look.' },
    { icon:'🔨', title:'Build & burn', desc:'Click "Build Disc Image" to create your ISO. Once done, insert a blank BD-R and click "Burn to Disc".' },
  ];

  const stepsHTML = steps.map(function(s) {
    // text-align:left — the modal box centers text globally, which made these
    // icon-led rows read ragged (centered text next to a left-anchored icon).
    return '<div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:14px;text-align:left">' +
      '<div style="width:36px;height:36px;border-radius:10px;background:var(--gold-glow);border:1px solid rgba(219,184,90,0.4);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">' + s.icon + '</div>' +
      '<div>' +
      '<div style="font-size:13px;font-weight:700;color:var(--text-primary);margin-bottom:3px">' + s.title + '</div>' +
      '<div style="font-size:12px;color:var(--text-secondary);line-height:1.6">' + s.desc + '</div>' +
      '</div></div>';
  }).join('');

  const recents = state.recentProjects || [];
  const recentsHTML = recents.length === 0 ? '' :
    '<div style="border:1px solid var(--border-dim);border-radius:8px;padding:10px 12px;margin-bottom:16px">' +
    '<div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--text-tertiary);text-transform:uppercase;margin-bottom:6px">Recent Projects</div>' +
    recents.map(p =>
      '<a href="#" class="recent-link" data-recent-path="' + esc(p) + '" title="' + esc(p) + '">' +
      esc(p.split('/').pop()) + ' <span style="color:var(--text-tertiary)">— ' + esc(p.split('/').slice(0, -1).join('/')) + '</span></a>'
    ).join('') +
    '<a href="#" id="clear-recents" class="recent-clear-link">Clear recent</a>' +
    '</div>';

  return '<div class="modal-backdrop"><div class="modal-box" style="max-width:480px">' +
    '<div style="text-align:center;margin-bottom:20px">' +
    '<div style="font-size:48px;margin-bottom:8px">💿</div>' +
    '<div style="font-size:22px;font-weight:700;color:var(--text-primary);margin-bottom:6px">Welcome to Disc Forge</div>' +
    '<div style="font-size:13px;color:var(--text-tertiary)">Professional Blu-ray authoring for macOS</div>' +
    '</div>' +
    recentsHTML +
    stepsHTML +
    '<div style="background:var(--gold-glow);border:1px solid rgba(219,184,90,0.3);border-radius:8px;padding:12px 14px;margin-bottom:16px">' +
    '<div style="font-size:12px;color:var(--gold-bright);font-weight:700;margin-bottom:4px">💡 Quick tip</div>' +
    '<div style="font-size:12px;color:var(--text-secondary);line-height:1.5">Adding a video auto-detects its embedded audio, subtitle, and chapter tracks — review them in the Project tab\'s Track Summary before building.</div>' +
    '</div>' +
    '<label style="display:flex;align-items:center;gap:8px;justify-content:center;cursor:pointer;font-size:12px;color:var(--text-secondary);margin-bottom:14px">' +
    '<input type="checkbox" id="welcome-dont-show" style="width:14px;height:14px;cursor:pointer">' +
    'Don\'t show this again' +
    '</label>' +
    '<div class="modal-actions">' +
    '<button class="btn btn-primary" id="close-welcome" style="width:100%;font-size:15px;padding:12px">Get Started →</button>' +
    '</div>' +
    '</div></div>';
}

// ── About Modal ───────────────────────────────────────────────────────────────
function aboutModalHTML() {
  // The in-app history fell ten releases behind (it ended at v1.15.1 while the
  // app shipped v1.25.0). Recent releases are condensed from CHANGELOG.md —
  // that file remains the authoritative, complete history.
  const versions = [
    { v:'1.25.0', notes:['Eject button and opt-in verify after burn', 'Friendly burn errors, disk-space preflight, mux validation', 'Project files now versioned and safe to load across versions (also fixes menu settings being lost on save)', 'Recent projects, window-state memory, title reordering, in-app dialogs', 'Smoother typing (batched re-renders) and a clear Menus on/off banner'] },
    { v:'1.24.3', notes:['Preview in VLC button after a successful build', 'macOS notifications when builds and burns finish', 'Real burn progress percentage from growisofs', 'npm test + GitHub Actions CI (1080 tests at release)'] },
    { v:'1.24.2', notes:['Horizontal-template buttons now sit inside the bottom bar on disc (they rendered mid-screen)', 'Menu buttons activate via MovieObjects (the pattern of the only menu proven interactive on the LG BP350) — and playback returns to the menu when a title ends'] },
    { v:'1.24.1', notes:['THE menu fix: menus now hold (infinite still) instead of looping every few seconds with dead remote input — still_mode byte was a zero-second timed still since v1.10.6', 'Pre-burn unmount so growisofs never aborts on a mounted or blank disc'] },
    { v:'1.24.0', notes:['Burn BD-R/BD-RE directly via growisofs (hdiutil cannot burn Blu-ray)', 'Single-title discs get a real menu: FirstPlay + TopMenu wired with a Play Movie button', 'Welcome screen gains a do-not-show-again option'] },
    { v:'1.15.1', notes:['UI cleanup — streamlined to three focused tabs: Project, Chapters, and Menus', 'Removed the Video Import, Audio, Subtitles, and Extras tabs (videos now auto-detect their embedded audio/subtitle/chapter tracks when added on the Project tab)', 'Removed the non-functional legacy Menu Design tab (its menu image was never used by the build); the Menus tab is the IG menu system', 'Title-bar version is now read dynamically from the app, so it can never go stale again', 'Tightened the sidebar (removed the duplicate disc-contents summary and capacity card) and tab bar'] },
    { v:'1.15.0', notes:['Full-screen disc menu preview in the Menus tab — a 16:9 TV-style preview of the actual menu', 'Retail-quality redesign of all built-in menu templates'] },
    { v:'1.11.0', notes:['Autoplay-only is now the default — discs build without menus by default for maximum hardware compatibility', 'Menus available as opt-in beta: enable "Menus (Beta)" in Project Settings to access menu design and interactive episode menus', 'Known compatibility issues on some players remain; v1.10.x menu fixes are all preserved on the beta path', 'Menu tab is hidden when menus are disabled; re-enable to access full menu builder', 'v1.10.12+ session will continue menu fix work in parallel'] },
    { v:'1.10.19', notes:['Isolated button state model change — bisecting the v1.10.18 white-screen regression', 'v1.10.18 made 8 simultaneous structural changes (dual display sets, no-WDS, ICS-lead 12012, DTS nibble 0x0, decode budget, invisible-normal state, …) and white-screened on the LG BP350 — worse than v1.10.17 which at least loaded to navy', 'v1.10.19 hard-reverts to the v1.10.17 structural baseline (single display set, WDS present, ICS PTS-DTS=11664, DTS nibble 0x1, 1-based button IDs) and applies ONLY the button state model change', 'State model: normal_state object_id_ref=0xFFFF (invisible), selected_state=activated_state=one bitmap per button, page.defaultSelectedButtonIdRef=0xFFFF, ODS count = button count (was 3×)', 'This isolates the single untested-in-isolation hypothesis: is invisible-normal-state alone what hardware needs?', 'Wire-level + bd_info validation clean; 181+24 tests pass'] },
    { v:'1.10.17', notes:['ROOT CAUSE hardware fix — button_id 1-based (BD spec §5.7.4: valid range [1, 0xEFFF])', 'All 10 prior menu iterations (v1.10.0–v1.10.16) used button_id=0 for the first button; BD spec requires min 1; LG BP350 silently discards the page when defaultSelectedButtonIdRef=0 cannot resolve', 'Fix: shift all button IDs from 0-based to 1-based in buildMenuDisplaySet — 7 field assignments in menu-builder.js', 'Object IDs remain 0-based (Toast also uses object_id=0; only button IDs are spec-constrained)', 'Forensic comparison vs Toast confirmed: Toast uses button IDs 1,2,3; defValidBtn≥1; defSelBtn=0xFFFF', '163 tests pass'] },
    { v:'1.10.16', notes:['CRITICAL hardware fix — ODS decode_time=3 constant (replaces ceil(w×h/90) from v1.10.15)', 'v1.10.15 white-screen regression: our 800×90 buttons produced 800 ticks per ODS, 4800 ticks total overshoot — LG BP350 rejected disc at load time', 'Fix: constant decode_time=3 (Toast empirical minimum, confirmed: 16×16 ODS → 3 ticks); 6 ODS × 3 = 18 ticks total — inside Toast empirical max of 41 ticks', 'DTS chaining structure from v1.10.15 unchanged; only the per-ODS decode budget changed', '151+24 tests pass'] },
    { v:'1.10.15', notes:['CRITICAL hardware fix — ODS DTS decode pipeline: ODS segments now have PTS+DTS (flags2=0xC0) with chained timing: ODS[0].DTS=ICS.DTS, ODS[i].DTS=ODS[i-1].PTS, ODS[i].PTS=DTS+ceil(w×h/90)', 'Hardware BD players use ODS.DTS to schedule object decode jobs in the T-STD model — without DTS, objects were never scheduled and buttons never appeared', 'END.PTS changed from ICS.PTS to last ODS PTS — matching Toast hardware reference', 'Decode_time formula ceil(w×h/90) verified against 4 Toast raw-byte cases (22×22→6, 16×16→3, 16×17→4, 79×46→41)', 'Root cause confirmed by Toast byte comparison (Roxio disc confirmed working on LG BP350) — prior sessions used Clannad (software-only reference)', '149+24 tests pass'] },
    { v:'1.10.14', notes:['CRITICAL hardware fix: PDS/WDS/ODS PES PTS changed from ICS.PTS to ICS.DTS — hardware IG controllers (LG BP350, Xbox) are PTS-gated and compose at ICS.DTS; supporting data was arriving 130ms too late so the display set was silently discarded', 'Root cause confirmed by per-segment PTS extraction from Clannad reference disc: Clannad PDS PTS=53988336 = ICS.DTS; ours was 54000000 = ICS.PTS (wrong)', 'ICS PTS/DTS unchanged; END PTS unchanged at ics_pts; only PDS/WDS/ODS PTS corrected', 'libbluray (software) not affected — it processes segments in arrival order without PTS-gating, which is why buttons rendered in software but not hardware', '162 tests pass (138 IG encoder + 24 video PES DTS)'] },
    { v:'1.10.13', notes:['Silent AC3 audio in menu clips — added silent AC3 audio stream to preroll and menu m2ts; LG BP350 presentation clock fix', '123 tests pass'] },
    { v:'1.10.12', notes:['Video PES DTS fix — BD-ROM requires PTS+DTS for all H.264 video PES (flags2 0x80→0xC0); MKV+B-frames rewriteVideoPesDts; 120/120 PUSI have DTS'] },
    { v:'1.10.11', notes:['Non-monotonic IG arrival timestamps fixed (T-STD violation causing LG BP350 to discard all IG packets)', 'copy_permission_indicator fixed to 0 (was 2 "copy once" — video packets use 0)', 'selectedSoundId/activatedSoundId fixed to 0xFF (no sound) — was 0, which triggers missing Sound.bdmv lookup on some players', '107 unit tests pass'] },
    { v:'1.10.9', notes:['Reverted composition_timeout_pts from video PTS back to 0 — setting it to the video PTS in v1.10.8 caused LG hardware to reject the disc at load time (disc not recognised, navy background never displayed), because the composition appears expired immediately upon parsing. composition_timeout_pts=0 is the universal no-timeout convention and is what all reference discs use. Expected result: disc loads, navy background plays, no interactive buttons (PDS/WDS/ODS audit in next session).'] },
    { v:'1.10.8', notes:['CRITICAL: Removed spurious number_of_composition_objects byte from ICS encodeICS() — libbluray ig_decode.c reads user_timeout_duration then DIRECTLY num_pages; there is no such field at the interactive_composition() level. The spurious 0x00 byte was being decoded as num_pages=0 → zero pages → zero buttons on all hardware players (LG + Xbox both affected)', 'CRITICAL: Fixed stream_model to 0 (Multiplexed/InMux) for our in-mux disc architecture — v1.10.6 had incorrectly set stream_model=1 (OutMux), which tells hardware to look for composition objects in a SubPath that does not exist on our disc', 'Fixed composition_timeout_pts: now passes actual video PTS as composition_timeout_pts in the InMux 10-byte timeout block, preventing hardware from discarding the composition as expired (was previously all-zeros which could be interpreted as PTS=0, already in the past)', 'Libbluray source validation: ig_decode.c and pg_decode.c used as ground truth for all ICS/PDS/WDS/ODS field layouts', 'Unit tests: Phase 5 updated to test correct InMux/OutMux byte encoding with PTS; Phase 6 rewritten to assert num_pages immediately follows user_timeout_duration (81 tests, up from 72)'] },
    { v:'1.10.7', notes:['ICS number_of_composition_objects fix (SUPERSEDED — the byte was actually wrong; see v1.10.8)', 'ICS segment byte added between user_timeout_duration and num_pages; this turned out to be a spurious byte that caused decoders to read num_pages=0'] },
    { v:'1.10.6', notes:['ICS InMux stream_model fix: ICS interaction_model byte bit7 now=1 (InMux), was 0 (OutOfMux with composition_timeout_pts=0 → hardware discarded overlay as expired)', 'MPLS still_mode fix: patchMplsForStill now writes 0x01 to byte[31] (infinite still); prior code wrote to reserved bits of byte[30] leaving byte[31]=0x00 (no-still)', 'Root cause confirmed via byte-level comparison against Beach Boys 50 Live (2012, Eagle Rock) hardware-verified reference disc'] },
    { v:'1.10.5', notes:['PMT IG stream declaration fix: hardware demuxers require the PMT to declare stream_type=0x91 PID=0x1400; CLPI/MPLS alone are not sufficient', 'patchPmtForIG() appends the IG ES entry to the PMT and rewrites the MPEG-2 CRC_32', 'Root cause: LG BD player test — menu background loaded but IG buttons not rendered, direction keys silently ignored'] },
    { v:'1.10.4', notes:['patchMplsForStill off-by-one fix: still_mode bits 6-5 now written to correct byte piOff+30', 'Retina 2x display support in verify_menu_buttons.py'] },
    { v:'1.10.3', notes:['Two-clip preload strategy: 1s preload (00098) initializes VLC vout before menu clip (00099) fires IG overlay', 'MPLS still_mode=2 on menu clip for persistent menu on hardware players', 'MovieObject obj[2]: PLAY_PL(98)→PLAY_PL(99)→JUMP_OBJECT(2)'] },
    { v:'1.10.2', notes:['IG menu button rendering fix: dynamic PTS extraction from video m2ts ensures IG PES PTS >= MPLS in_pts, passing libbluray m2ts_filter', 'Replaces hardcoded fallback PTS with per-disc extracted value for robustness'] },
    { v:'1.10.0', notes:['Tier 2 IG menus: N-button auto-layout (2–9 episodes)', 'Text rendering on buttons via FFmpeg drawtext (SIL Inter font)', 'UI customization panel: button labels, font size, colors'] },
    { v:'1.9.1', notes:['Splash screen fix: both CLPI and MPLS patched for proper first-frame display', 'UI polish for splash/menu toggle'] },
    { v:'1.9.0', notes:['Multi-title episode disc support', 'Separate IPC handler and per-episode tsMuxeR', 'PGS subtitle pipeline', 'IG encoder foundation (59 unit tests)'] },
    { v:'1.5.2', notes:['Video Quality Mode — per-title quality selector: Passthrough (stream copy), High Quality CRF 18, Balanced CRF 20, Compact CRF 23', 'CRF re-encode produces BD-compliant H.264 High Profile output', 'Size estimates update per-title based on selected quality multiplier', 'CRF encode progress shows fps, frame count, and estimated time remaining', 'Apply-to-all quality button for quick global quality changes', 'Quality badge per title: green Copy / yellow CRF N'] },
    { v:'1.5.1', notes:['Accurate disc size estimation: video bitrate + AC3 audio + subtitle overhead via ffprobe', 'Elapsed timer stops when build completes', 'ISO file size shown prominently in success screen', 'Build steps show output file size on completion', 'Per-title ETA based on previous title durations', 'Disc capacity warning if estimate exceeds BD-25 or BD-50', 'Disc capacity fill bar added to Project tab'] },
    { v:'1.5', notes:['Disc burning with real-time progress (growisofs + hdiutil fallback)', 'Chapter thumbnails — auto-generate 160×90 previews per chapter via FFmpeg', 'Passthrough mode — skip FFmpeg transcode for BD-compatible H.264/HEVC titles', 'BD compatibility detection badge per title (Passthrough / Transcode)', 'Enhanced menu customization: 6 new themes (Minimal, Cinema, Vintage, Neon, Grid, Sidebar)', 'Gradient background with direction selector', 'Background image blur/brightness/contrast controls', 'Font size sliders for title (24–96px) and episodes (12–36px)', 'Font weight & letter spacing', 'Text shadow with colour, blur, and X/Y offset', 'Button border radius & hover effects (highlight, scale, underline, glow)', 'Episode spacing & number toggle', 'Disc title overlay with position selector', 'Animated background (pan, pulse, particles)'] },
    { v:'1.4', notes:['Full subtitle support on all episodes (ASS/SRT→PGS conversion via pysubs2 + tsMuxeR)', 'mkvmerge integration for clean multi-track MKV assembly', 'Track name metadata from source MKV', 'Java + BDSup2Sub support for future PGS workflows'] },
    { v:'1.3', notes:['Fix subtitle tracks from episodes 2+ leaking into main tsMuxeR meta', 'Fix missing track= parameter on embedded subtitle entries', 'Multi-title navigation: regenerate index.bdmv + MovieObject.bdmv for N titles', 'Path escaping for filenames containing double-quotes in tsMuxeR meta', 'patchClipId magic guard prevents corrupting non-MPLS/CLPI files'] },
    { v:'1.2', notes:['Burn to BD-R disc directly', 'Interactive menu preview simulator', 'Episode / audio / subtitle menu screens', 'Persistent colour picker with presets', 'Chapter auto-import from video files', 'Custom button text & emoji toggle', 'Text stroke/outline on menu title', 'Logo/watermark image support', 'Project save & load (.dfp files)', 'Build progress with ETA & elapsed time', 'About screen & version history'] },
    { v:'1.1', notes:['Light mode default with dark toggle', 'Multiple video titles per disc', 'Disc capacity meter (DVD-5/BD-25/BD-50/BD-100)', 'Subtitle descriptions per track', 'System font picker', 'Scroll position preserved on re-render', 'Multi-file video selection'] },
    { v:'1.0', notes:['Initial release', 'FFmpeg mux → tsMuxeR BDMV → hdiutil ISO', 'MKV import with ffprobe track detection', '7-tab interface', 'Dark studio theme'] },
  ];
  const vHTML = versions.map(function(ver) {
    return '<div style="margin-bottom:14px;text-align:left">' +
      '<div style="font-size:12px;font-weight:700;color:var(--gold);margin-bottom:4px">v' + ver.v + '</div>' +
      ver.notes.map(function(n) {
        return '<div style="font-size:11px;color:var(--text-secondary);padding:1px 0;padding-left:10px">· ' + n + '</div>';
      }).join('') +
    '</div>';
  }).join('');

  return '<div class="modal-backdrop"><div class="modal-box" style="max-width:440px">' +
    '<div style="text-align:center;margin-bottom:16px">' +
    '<div style="font-size:40px;margin-bottom:6px">💿</div>' +
    '<div class="modal-title" style="font-size:20px">Disc Forge</div>' +
    // Version is read from the app (like the titlebar since v1.15.1) so this
    // headline can never go stale again — it sat at "1.11.0" for ten releases.
    '<div style="font-size:12px;color:var(--gold);font-weight:600;margin-bottom:4px">Version ' + esc(state.appVersion || '—') + '</div>' +
    '<div style="font-size:11px;color:var(--text-tertiary)">Professional Blu-ray authoring for macOS</div>' +
    '</div>' +
    '<div style="max-height:320px;overflow-y:auto;border-top:1px solid var(--border-dim);border-bottom:1px solid var(--border-dim);padding:12px 0;margin-bottom:14px">' +
    '<div style="font-size:10px;letter-spacing:.1em;color:var(--text-tertiary);margin-bottom:10px;text-align:center">VERSION HISTORY</div>' +
    vHTML +
    '<div style="font-size:10px;color:var(--text-tertiary);text-align:center;padding-top:8px">Full history: CHANGELOG.md in the GitHub repository</div>' +
    '</div>' +
    '<div style="font-size:11px;color:var(--text-tertiary);text-align:center;margin-bottom:6px">Powered by FFmpeg · tsMuxeR · growisofs · xorriso</div>' +
    '<div style="font-size:11px;color:var(--text-tertiary);text-align:center;margin-bottom:14px">Copyright © 2026 ETHM</div>' +
    '<div style="text-align:center;margin-bottom:14px"><a id="kofi-link" class="kofi-link" href="#">Support Disc Forge ☕</a></div>' +
    '<div class="modal-actions"><button class="btn btn-ghost" id="close-about">Close</button></div>' +
    '</div></div>';
}

// ── Project Save/Load ──────────────────────────────────────────────────────────
async function saveProject() {
  // Save the COMPLETE project (pre-v1.25 saves cherry-picked fields and
  // silently dropped igMenuConfig — template choice and button labels were
  // lost across save/load), stamped with the schema version.
  const proj = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    ...state.project,
    embeddedTracks: state.embeddedTracks || [],
  };
  const json = JSON.stringify(proj, null, 2);
  const savePath = await window.discForge.saveProjectFile(json);
  if (savePath) {
    showInfo('Project saved to: ' + savePath, 'Project Saved');
  }
}

// Parse + apply a loaded .dfp (shared by the Load button and the welcome
// screen's recent-projects list).
function applyLoadedProject(json) {
  try {
    const proj = JSON.parse(json);
    if (proj.schemaVersion === undefined) {
      console.warn('Loading a pre-versioned (v0) project file — missing fields get defaults.');
    } else if (proj.schemaVersion > PROJECT_SCHEMA_VERSION) {
      showInfo('This project was created with a newer version of Disc Forge. Some settings may not load correctly.');
    }
    state.embeddedTracks = proj.embeddedTracks || [];
    // Merge over the full defaults so every field exists (never undefined),
    // then clamp <select>-backed fields to known values (exact string match).
    const merged = mergeProjectWithDefaults(proj, defaultProject());
    merged.resolution  = RESOLUTIONS.find(r => r === merged.resolution)  || RESOLUTIONS[0];
    merged.videoFormat = VIDEO_FMTS.find(f => f === merged.videoFormat) || VIDEO_FMTS[0];
    setPrj(merged);
    return true;
  } catch(e) {
    showInfo('Failed to load project: ' + e.message);
    return false;
  }
}

async function loadProject() {
  const json = await window.discForge.loadProjectFile();
  if (!json) return;
  applyLoadedProject(json);
  refreshRecents();
}

async function refreshRecents() {
  try { setState({ recentProjects: await window.discForge.recentsList() }); } catch (_) {}
}

async function loadRecentProject(filePath) {
  const r = await window.discForge.loadProjectPath(filePath);
  if (r && r.json) {
    if (applyLoadedProject(r.json)) setState({ showWelcome: false });
    refreshRecents();
  } else {
    await refreshRecents();
    showInfo(r && r.error === 'not-found'
      ? 'File not found — removed from recent projects.'
      : 'Could not open project: ' + ((r && r.error) || 'unknown error'));
  }
}

// ── Listeners ──────────────────────────────────────────────────────────────────
function attachListeners() {
  // Restore focus to previously focused input after re-render
  if (_focusedId) {
    // Check for title-label-input by data-title-id / ig-label-input by data-idx
    let el = document.getElementById(_focusedId);
    if (!el && _focusedId.startsWith('__iglabel:')) {
      el = document.querySelector('.ig-label-input[data-idx="' + _focusedId.slice('__iglabel:'.length) + '"]');
    }
    if (!el) {
      el = document.querySelector('[data-title-id="' + _focusedId + '"]');
    }
    if (el) {
      el.focus();
      if (_focusedPos !== null && el.setSelectionRange) {
        try { el.setSelectionRange(_focusedPos, _focusedPos); } catch(_) {}
      }
    }
    _focusedId  = null;
    _focusedPos = null;
  }
  // Tabs
  document.querySelectorAll('.tab-btn').forEach(el => el.addEventListener('click', () => setState({ tab: el.dataset.tab })));

  // Sidebar
  document.getElementById('build-btn')?.addEventListener('click', startBuild);
  document.getElementById('pick-output')?.addEventListener('click', pickOutputDir);

  // Project
  document.getElementById('proj-title')?.addEventListener('input',  e => setPrjText({ title: e.target.value }));
  document.getElementById('proj-label')?.addEventListener('input',  e => setPrjText({ discLabel: e.target.value }));
  document.getElementById('proj-desc')?.addEventListener('input',   e => setPrjText({ description: e.target.value }));
  document.getElementById('proj-res')?.addEventListener('change',   e => setPrj({ resolution: e.target.value }));
  document.getElementById('force-transcode')?.addEventListener('change', e => setPrj({ forceTranscode: e.target.checked }));
  document.getElementById('proj-vcodec')?.addEventListener('change',e => setPrj({ videoFormat: e.target.value }));
  document.getElementById('menus-enabled')?.addEventListener('change', e => setState({ menusEnabled: e.target.checked }));
  // v1.19.0 chapter (Scene Selection) menu controls
  document.getElementById('chapter-menu-enabled')?.addEventListener('change', e =>
    setPrj({ chapterMenu: { ...state.project.chapterMenu, enabled: e.target.checked } }));
  document.getElementById('chapter-menu-label')?.addEventListener('input', e =>
    setPrjText({ chapterMenu: { ...state.project.chapterMenu, label: e.target.value } }));
  document.getElementById('chapter-menu-template')?.addEventListener('change', e =>
    setPrj({ chapterMenu: { ...state.project.chapterMenu, templateId: e.target.value || null } }));
  document.getElementById('use-splash')?.addEventListener('change',  e => setPrj({ useSplash: e.target.checked }));
  document.getElementById('use-ig-menu')?.addEventListener('change', e => setPrj({ useIGMenu: e.target.checked }));
  // Per-episode menu button labels. Menu appearance (template, background, button
  // colors) is set in the Menus tab — those controls were removed from this tab to
  // avoid duplicating the Menu Designer.
  document.querySelectorAll('.ig-label-input').forEach(el => {
    el.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const labels = [...(state.project.igMenuConfig?.buttonLabels || [])];
      labels[idx] = e.target.value;
      // Batched (A1): per-keystroke renders also LOST focus here before —
      // these inputs have no id, so the old capture missed them entirely;
      // scheduleRender's data-idx capture fixes that too.
      setPrjBatched({ igMenuConfig: { ...state.project.igMenuConfig, buttonLabels: labels } });
    });
  });

  // ── Menus tab (v1.22.0 design-first selector) ───────────────────────────────
  // Step 1 — Design type toggle (Vertical Stack / Horizontal Bar)
  document.querySelectorAll('[data-design-type]').forEach(el =>
    el.addEventListener('click', () => setDesignType(el.dataset.designType)));
  // Step 2 — Color scheme dropdown → switch templates
  document.getElementById('tpl-scheme-select')?.addEventListener('change', e =>
    selectTemplate(e.target.value));

  // Built-in: Duplicate to edit + shared name-entry modal
  document.getElementById('tpl-duplicate')?.addEventListener('click', duplicateSelected);
  document.getElementById('tpl-name-modal-cancel')?.addEventListener('click', cancelNameModal);
  document.getElementById('tpl-name-modal-ok')?.addEventListener('click', confirmNameModal);

  // Active-template indicator (Part 5)
  document.getElementById('tpl-use-active')?.addEventListener('click', () =>
    setPrj({ igMenuConfig: { ...state.project.igMenuConfig, templateId: state.templateEditor.selectedId } }));

  // Collapsible accordions — persist open/closed in localStorage
  document.querySelectorAll('[data-accordion]').forEach(el =>
    el.addEventListener('click', () => {
      const key = el.dataset.accordion;
      localStorage.setItem('disc-forge-acc-' + key, accordionOpen(key) ? '0' : '1');
      render();
    }));

  // Quick presets (Section E)
  document.querySelectorAll('[data-preset]').forEach(el =>
    el.addEventListener('click', () => {
      const p = TPL_PRESETS.find(x => x.id === el.dataset.preset);
      if (!p) return;
      if (isDirty()) {
        showConfirm(`Apply the "${p.name}" preset? This overwrites your current unsaved changes.`,
          () => applyPreset(p), { title: 'Apply Preset', confirmLabel: 'Apply' });
        return;
      }
      applyPreset(p);
    }));

  // SECTION A — Background
  document.querySelectorAll('[data-bg-type]').forEach(el =>
    el.addEventListener('click', () => updateDraft(t => { t.background.type = el.dataset.bgType; })));
  document.getElementById('tpl-bg-color2')?.addEventListener('input', e =>
    updateDraft(t => { t.background.color = e.target.value.replace(/^#/, ''); }));
  document.getElementById('tpl-bg-fit2')?.addEventListener('change', e =>
    updateDraft(t => { t.background.fit = e.target.value; }));
  // Uploaded images are COPIED into app userData/backgrounds (main process) and the
  // template stores the filename only — keeps templates portable (no absolute paths,
  // no base64). bgPick opens a dialog; bgImport copies a dropped file's path.
  const _applyBgFile = (r) => {
    if (!r || !r.file) return;
    if (r.bgDir) _bgDir = r.bgDir;
    updateDraft(t => {
      t.background.type = 'image';
      t.background.file = r.file;
      delete t.background.imagePath;          // drop any stale absolute path
      if (!t.background.fit) t.background.fit = 'cover';
    });
  };
  const _dz = document.getElementById('tpl-bg-drop');
  if (_dz) {
    _dz.addEventListener('click', async () => { _applyBgFile(await window.discForge.bgPick()); });
    _dz.addEventListener('dragover', e => { e.preventDefault(); _dz.classList.add('drag'); });
    _dz.addEventListener('dragleave', () => _dz.classList.remove('drag'));
    _dz.addEventListener('drop', async e => {
      e.preventDefault(); _dz.classList.remove('drag');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && f.path) _applyBgFile(await window.discForge.bgImport(f.path));
    });
  }
  // Remove Image → revert to a solid background (the fallback color stays).
  document.getElementById('tpl-bg-image-clear2')?.addEventListener('click', () =>
    updateDraft(t => { t.background.type = 'solid'; delete t.background.file; delete t.background.imagePath; delete t.background.fit; }));
  // Paint the loaded background-image thumbnail (via the main-process data URL).
  (async () => {
    const bg = state.templateEditor.draft && state.templateEditor.draft.background;
    const thumb = document.getElementById('tpl-bg-thumb');
    const ref = (bg && bg.type === 'image') ? _bgRef(bg) : '';
    if (thumb && ref) {
      try {
        const url = await window.discForge.getImageDataUrl(ref);
        if (url) thumb.style.backgroundImage = `url('${url}')`;
      } catch (_) {}
    }
  })();

  // SECTION A0 — Button layout mode (vertical stack vs horizontal studio bar)
  document.querySelectorAll('[data-layout-mode]').forEach(el =>
    el.addEventListener('click', () => updateDraft(t => {
      const v = el.dataset.layoutMode;
      t.button.layout = v;
      if (v === 'horizontal') {
        // Seed sensible studio-bar defaults the first time the mode is chosen.
        if (!t.button.barColor)   t.button.barColor = '111111';
        if (typeof t.button.barOpacity !== 'number') t.button.barOpacity = 0.92;
        if (!Number.isInteger(t.button.barHeight)) t.button.barHeight = 140;
        if (!Number.isInteger(t.button.iconSize))  t.button.iconSize = 52;
        if (t.button.count == null) t.button.count = 4;
        // Reshape wide vertical buttons into compact horizontal tiles.
        if (t.button.width > 400) t.button.width = 180;
        if (t.button.height < 100) t.button.height = 120;
      }
    })));
  document.getElementById('tpl-bar-color')?.addEventListener('input', e =>
    updateDraft(t => { t.button.barColor = e.target.value.replace(/^#/, ''); }));
  document.getElementById('tpl-bar-opacity')?.addEventListener('input', e =>
    updateDraft(t => { t.button.barOpacity = parseFloat(e.target.value); }));
  document.getElementById('tpl-bar-height')?.addEventListener('input', e =>
    updateDraft(t => { t.button.barHeight = parseInt(e.target.value, 10); }));
  document.getElementById('tpl-icon-size')?.addEventListener('input', e =>
    updateDraft(t => { t.button.iconSize = parseInt(e.target.value, 10); }));

  // SECTION B — Button colors (palette entries) + size/border sliders
  const _setEntryColor = (entry, hex) => {
    const [r, g, b] = window.discForge.color.hexToRgb(hex);
    const yuv = window.discForge.color.rgbToYuv(r, g, b);
    updateDraft(t => { const e = t.palette.find(x => x.id === entry); if (e) { e.Y = yuv.Y; e.Cr = yuv.Cr; e.Cb = yuv.Cb; } });
  };
  const _draftBtn = () => state.templateEditor.draft.button;
  document.getElementById('tpl-normal-color')?.addEventListener('input', e => _setEntryColor(_draftBtn().normalFill.entry, e.target.value));
  document.getElementById('tpl-sel-color')?.addEventListener('input', e => _setEntryColor(_draftBtn().selectedFill.entry, e.target.value));
  document.getElementById('tpl-border-color')?.addEventListener('input', e => _setEntryColor(_draftBtn().borderEntry, e.target.value));
  document.getElementById('tpl-label-color')?.addEventListener('input', e => _setEntryColor(_draftBtn().borderEntry, e.target.value));
  const _btnSlider = (id, key, lo, hi) => document.getElementById(id)?.addEventListener('input', e => {
    const v = Math.max(lo, Math.min(hi, parseInt(e.target.value, 10) || lo));
    updateDraft(t => { t.button[key] = v; });
  });
  _btnSlider('tpl-w', 'width', 200, 1600);
  _btnSlider('tpl-h', 'height', 40, 200);
  _btnSlider('tpl-gap', 'gap', 10, 80);
  _btnSlider('tpl-border', 'border', 0, 12);

  // Button shape (segmented control + conditional corner-radius slider)
  document.querySelectorAll('[data-shape]').forEach(el =>
    el.addEventListener('click', () => updateDraft(t => {
      t.button.shape = el.dataset.shape;
      // Seed a sensible radius when first switching to Rounded so the disc render
      // matches the slider's displayed default (24px).
      if (t.button.shape === 'rounded' && !Number.isInteger(t.button.cornerRadius)) {
        t.button.cornerRadius = 24;
      }
    })));
  document.getElementById('tpl-corner-radius')?.addEventListener('input', e =>
    updateDraft(t => { t.button.cornerRadius = parseInt(e.target.value, 10); }));

  // SECTION C — Typography
  document.getElementById('tpl-font-search')?.addEventListener('input', e => {
    state.templateEditor.fontFilter = e.target.value;
    _focusedId = 'tpl-font-search'; _focusedPos = e.target.selectionStart;
    render();
  });
  document.getElementById('tpl-font-family')?.addEventListener('change', e =>
    updateDraft(t => { t.font.family = e.target.value; }));
  document.getElementById('tpl-font-size2')?.addEventListener('input', e =>
    updateDraft(t => { t.font.sizeRatio = parseFloat(e.target.value); }));

  // SECTION B2 — Layout (v1.18.0 interactive editor)
  const _layoutOverlay = () => document.getElementById('layout-overlay');
  document.getElementById('tpl-pos-btn-select')?.addEventListener('change', e => {
    state.templateEditor.selectedBtn = parseInt(e.target.value, 10) || 0;
    _ensureLivePositions();
    _updatePositionInputs();
    renderOverlay(_layoutOverlay());
  });
  const _onPosInput = (axis) => (e) => {
    const ed = state.templateEditor;
    const tpl = ed.draft; if (!tpl) return;
    const positions = _ensureLivePositions();
    let i = ed.selectedBtn; if (i < 0) i = ed.selectedBtn = 0;
    if (!positions[i]) return;
    const bw = tpl.button.width, bh = tpl.button.height;
    let v = parseInt(e.target.value, 10); if (!Number.isFinite(v)) v = 0;
    if (axis === 'x') positions[i] = { x: Math.max(0, Math.min(v, 1920 - bw)), y: positions[i].y };
    else              positions[i] = { x: positions[i].x, y: Math.max(0, Math.min(v, 1080 - bh)) };
    renderOverlay(_layoutOverlay());
    _updatePositionInputs();
  };
  document.getElementById('tpl-pos-x')?.addEventListener('input', _onPosInput('x'));
  document.getElementById('tpl-pos-y')?.addEventListener('input', _onPosInput('y'));
  document.getElementById('tpl-pos-x')?.addEventListener('blur', _commitLivePositions);
  document.getElementById('tpl-pos-y')?.addEventListener('blur', _commitLivePositions);
  document.querySelectorAll('[data-align]').forEach(el =>
    el.addEventListener('click', () => _applyAlign(el.dataset.align)));
  document.getElementById('tpl-show-grid')?.addEventListener('change', e => {
    state.templateEditor.showGrid = e.target.checked; renderOverlay(_layoutOverlay());
  });
  document.getElementById('tpl-grid-size')?.addEventListener('change', e => {
    state.templateEditor.gridSize = parseInt(e.target.value, 10) || 32; renderOverlay(_layoutOverlay());
  });
  document.getElementById('tpl-show-safe')?.addEventListener('change', e => {
    state.templateEditor.showSafeAreas = e.target.checked; renderOverlay(_layoutOverlay());
  });
  document.getElementById('tpl-show-center')?.addEventListener('change', e => {
    state.templateEditor.showCenter = e.target.checked; renderOverlay(_layoutOverlay());
  });

  // SECTION D — Template meta
  document.getElementById('tpl-name2')?.addEventListener('input', e =>
    updateDraft(t => { t.name = e.target.value; }));
  document.getElementById('tpl-desc')?.addEventListener('input', e =>
    updateDraft(t => { t.description = e.target.value; }));
  document.getElementById('tpl-revert')?.addEventListener('click', revertTemplate);
  document.getElementById('tpl-save')?.addEventListener('click', saveTemplate);
  document.getElementById('tpl-delete')?.addEventListener('click', deleteTemplate);

  // Restore chips — bring back an individual button hidden in the layout editor.
  document.querySelectorAll('[data-restore-btn]').forEach(el => {
    el.addEventListener('click', () => {
      const i = parseInt(el.getAttribute('data-restore-btn'), 10);
      const ed = state.templateEditor;
      ed.deletedBtns = ed.deletedBtns.filter(x => x !== i);
      refreshPreviews();
    });
  });

  // Lazily render any missing browser thumbnails once the canvases exist.
  if (state.tab === 'templates') ensureThumbnails();
  document.getElementById('splash-duration')?.addEventListener('change', e => setPrj({ splashDuration: parseInt(e.target.value, 10) }));
  document.getElementById('splash-color')?.addEventListener('input',   e => setPrj({ splashColor: e.target.value.slice(1) }));
  document.getElementById('pick-splash-png')?.addEventListener('click', async () => {
    const r = await pickFile([{ name: 'Image', extensions: ['png'] }]);
    if (r) setPrj({ splashPngPath: r });
  });
  document.getElementById('clear-splash-png')?.addEventListener('click', e => { e.stopPropagation(); setPrj({ splashPngPath: null }); });

  // Light mode toggle
  document.getElementById('toggle-theme')?.addEventListener('click', () => {
    const isLight = !state.lightMode;
    localStorage.setItem('disc-forge-theme', isLight ? 'light' : 'dark');
    setState({ lightMode: isLight });
  });


  // Add additional titles - multi-file picker
  document.getElementById('add-title-btn')?.addEventListener('click', async () => {
    const files = await window.discForge.openFilesDialog({
      filters:[{ name:'Video', extensions:['mkv','mp4','ts','m2ts','avi','mov','wmv','vob'] }]
    });
    if (!files || !files.length) return;
    let mainVideo = state.project.mainVideo;
    let existingTitles = [...(state.project.titles||[])];
    const toAdd = [...files];
    if (!mainVideo && toAdd.length > 0) {
      mainVideo = toAdd.shift();
    }
    const newTitles = toAdd.map(f => ({ id:uid(), file:f, label:f.name.replace(/\.[^.]+$/, '') }));
    setPrj({ mainVideo, titles: [...existingTitles, ...newTitles] });

    // Auto-probe all added files to detect embedded tracks
    const allFiles = mainVideo && !state.project.mainVideo ? [mainVideo, ...toAdd] : [...files];
    const existingEmbedded = state.embeddedTracks || [];
    for (const f of allFiles) {
      const filePath = f.path || f.name;
      if (!filePath) continue;
      // Skip if already probed
      if (existingEmbedded.some(t => t.sourceFile === filePath)) continue;
      const probe = await window.discForge.probeFile(filePath);
      if (!probe.success || !probe.data) continue;
      cacheProbeData(filePath, probe.data);
      const streams = probe.data.streams || [];
      const detected = streams
        .filter(s => s.codec_type === 'audio' || s.codec_type === 'subtitle')
        .map(s => {
          const lang = (s.tags?.language || s.tags?.LANGUAGE || 'und').toLowerCase();
          const langMap = {eng:'English',fre:'French',fra:'French',spa:'Spanish',deu:'German',ger:'German',
            ita:'Italian',por:'Portuguese',jpn:'Japanese',kor:'Korean',zho:'Mandarin',chi:'Mandarin',
            rus:'Russian',ara:'Arabic',hin:'Hindi',nld:'Dutch',swe:'Swedish',nor:'Norwegian',
            dan:'Danish',fin:'Finnish',pol:'Polish',ces:'Czech',hun:'Hungarian',ron:'Romanian',
            tur:'Turkish',ell:'Greek',heb:'Hebrew',tha:'Thai',vie:'Vietnamese',ind:'Indonesian',
            msa:'Malay'};
          const language = langMap[lang] || 'English';
          const codec = s.codec_name || '';
          const fmtMap = {'dts':'DTS-HD Master Audio','truehd':'Dolby TrueHD','ac3':'Dolby Digital 5.1',
            'eac3':'Dolby Digital 5.1','aac':'Dolby Digital 5.1','flac':'PCM 5.1','pcm_s24le':'PCM 5.1',
            'pcm_s16le':'LPCM Stereo','subrip':'SRT','srt':'SRT','ass':'ASS','pgs':'PGS (Blu-ray Native)',
            'hdmv_pgs_subtitle':'PGS (Blu-ray Native)','vtt':'VTT','dvd_subtitle':'SRT'};
          const format = fmtMap[codec] || (s.codec_type === 'audio' ? 'DTS-HD Master Audio' : 'SRT');
          const title = s.tags?.title || s.tags?.TITLE || '';
          const isDefault = s.disposition?.default === 1;
          const isForced = s.disposition?.forced === 1;
          const isSDH = title.toLowerCase().includes('sdh') || title.toLowerCase().includes('cc');
          return {
            id: uid(),
            sourceFile: filePath,
            sourceFileName: f.name,
            streamIndex: s.index,
            codec: codec,
            role: s.codec_type,
            language,
            format,
            label: title || language,
            description: title || '',
            isDefault,
            isForced,
            isSDH,
            included: true,  // checked by default
            trackIndex: s.index,
          };
        });
      state.embeddedTracks = [...(state.embeddedTracks||[]), ...detected];

      // Auto-import chapters if none exist yet
      const chapters = probe.data.chapters || [];
      if (chapters.length > 0 && state.project.chapters.length === 0) {
        const newChapters = chapters.map((ch, idx) => {
          const startSec = parseFloat(ch.start_time || 0);
          const h = Math.floor(startSec / 3600);
          const m2 = Math.floor((startSec % 3600) / 60);
          const s = Math.floor(startSec % 60);
          const time = String(h).padStart(2,'0') + ':' + String(m2).padStart(2,'0') + ':' + String(s).padStart(2,'0');
          const name = (ch.tags && (ch.tags.title || ch.tags.TITLE)) || ('Chapter ' + (idx+1));
          return { id: uid(), name, time };
        });
        state.project = { ...state.project, chapters: newChapters };
        console.log('Auto-imported ' + newChapters.length + ' chapters');
      }

      // Feature 3: detect BD compatibility for passthrough mode
      try {
        const compat = await window.discForge.detectBdCompatibility(filePath);
        state.titleCompatibility = { ...state.titleCompatibility, [filePath]: compat };
      } catch(_) {}
    }
  render();
});

  document.querySelectorAll('.title-label-input').forEach(input => {
    // Save on every keystroke directly into state — no render() so focus is never lost
    input.addEventListener('input', e => {
      const id = input.dataset.titleId;
      const val = e.target.value;
      state.project = {
        ...state.project,
        titles: (state.project.titles||[]).map(t =>
          t.id === id ? { ...t, label: val } : t
        )
      };
    });
    // No render on blur — value is already in state
    input.addEventListener('keydown', e => {
      e.stopPropagation();
    });
  });

  // Video quality selector per title
  document.querySelectorAll('.title-quality-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const id  = sel.dataset.titleId;
      const quality = e.target.value;
      if (id === '__main__') {
        setPrj({ mainVideo: { ...state.project.mainVideo, videoQuality: quality } });
      } else {
        setPrj({ titles: (state.project.titles||[]).map(t => t.id === id ? { ...t, videoQuality: quality } : t) });
      }
    });
  });

  // Apply quality to all titles
  document.getElementById('quality-apply-all')?.addEventListener('click', () => {
    const quality = document.getElementById('quality-apply-select')?.value || 'passthrough';
    const p = state.project;
    const newMainVideo = p.mainVideo ? { ...p.mainVideo, videoQuality: quality } : null;
    const newTitles = (p.titles||[]).map(t => ({ ...t, videoQuality: quality }));
    setPrj({ mainVideo: newMainVideo, titles: newTitles });
  });

  // Remove title
  // Title reordering (↑/↓ on additional-title rows). setPrj re-renders, which
  // also refreshes the disc-size estimate and any visible menu/chapter preview.
  document.querySelectorAll('[data-move-title]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.moveTitle, 10);
      const dir = parseInt(btn.dataset.moveDir, 10);
      setPrj({ titles: moveTitle(state.project.titles, idx, dir) });
    });
  });
  document.querySelectorAll('[data-rm-title]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.rmTitle;
      if (id === '__main__') {
        // Promote first additional title to main, or clear mainVideo
        const titles = [...(state.project.titles||[])];
        if (titles.length > 0) {
          const newMain = titles.shift();
          setPrj({ mainVideo: newMain.file, titles });
        } else {
          setPrj({ mainVideo: null });
        }
      } else {
        setPrj({ titles: (state.project.titles||[]).filter(t => t.id !== id) });
      }
    });
  });

  // Embedded track toggles
  document.querySelectorAll('[data-toggle-embedded]').forEach(el => {
    el.addEventListener('change', () => {
      const id = el.dataset.toggleEmbedded;
      state.embeddedTracks = state.embeddedTracks.map(t => t.id===id ? {...t, included: el.checked} : t);
      render();
    });
  });

  // Track inclusion toggles on Project tab
  document.querySelectorAll('[data-toggle-audio]').forEach(el => {
    el.addEventListener('change', () => {
      const id = el.dataset.toggleAudio;
      setPrj({ audioTracks: state.project.audioTracks.map(t => t.id===id ? {...t, excluded: !el.checked} : t) });
    });
  });
  document.querySelectorAll('[data-toggle-sub]').forEach(el => {
    el.addEventListener('change', () => {
      const id = el.dataset.toggleSub;
      setPrj({ subtitleTracks: state.project.subtitleTracks.map(t => t.id===id ? {...t, excluded: !el.checked} : t) });
    });
  });


  // Chapters
  document.getElementById('ch-name')?.addEventListener('input', e => { _focusedId='ch-name'; _focusedPos=e.target.selectionStart; Object.assign(state,{form:{...state.form,chapter:{...state.form.chapter,name:e.target.value}}}); render(); });
  document.getElementById('ch-time')?.addEventListener('input', e => { _focusedId='ch-time'; _focusedPos=e.target.selectionStart; Object.assign(state,{form:{...state.form,chapter:{...state.form.chapter,time:e.target.value}}}); render(); });
  document.getElementById('pick-ch-thumb')?.addEventListener('click', pickChapterThumb);
  document.getElementById('add-chapter')?.addEventListener('click', addChapter);
  document.querySelectorAll('[data-rm-chapter]').forEach(el => el.addEventListener('click', () => rmChapter(el.dataset.rmChapter)));


  // Modal
  // Import chapters from video file
  document.getElementById('import-chapters-btn')?.addEventListener('click', async () => {
    const p = state.project;
    const videoPath = p.mainVideo?.path || (p.titles&&p.titles[0]?.file?.path);
    if (!videoPath) { showInfo('Please add a video file first.'); return; }
    const probe = await window.discForge.probeFile(videoPath);
    if (!probe.success || !probe.data) { showInfo('Could not probe video file.'); return; }
    const chapters = probe.data.chapters || [];
    if (chapters.length === 0) { showInfo('No chapter markers found in this video file.'); return; }
    const newChapters = chapters.map((ch, idx) => {
      const startSec = parseFloat(ch.start_time || 0);
      const h = Math.floor(startSec / 3600);
      const m2 = Math.floor((startSec % 3600) / 60);
      const s = Math.floor(startSec % 60);
      const time = String(h).padStart(2,'0') + ':' + String(m2).padStart(2,'0') + ':' + String(s).padStart(2,'0');
      const name = (ch.tags && (ch.tags.title || ch.tags.TITLE)) || ('Chapter ' + (idx+1));
      return { id: uid(), name, time };
    });
    setPrj({ chapters: newChapters });
    showInfo('Imported ' + newChapters.length + ' chapters!');
  });
  document.getElementById('gen-thumbs-btn')?.addEventListener('click', generateChapterThumbnails);
  document.getElementById('clear-chapters-btn')?.addEventListener('click', () => {
    showConfirm('Clear all chapters?', () => setPrj({ chapters: [] }), { title: 'Clear Chapters', confirmLabel: 'Clear' });
  });

  document.getElementById('close-modal')?.addEventListener('click', closeBuildModal);
  document.getElementById('about-btn')?.addEventListener('click', () => setState({ showAbout: true }));
  document.getElementById('close-about')?.addEventListener('click', () => setState({ showAbout: false }));
  // Ko-fi support link — opens in the system browser (CSP blocks inline onclick).
  document.getElementById('kofi-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.discForge.openExternal('https://ko-fi.com/discforge');
  });
  document.getElementById('close-welcome')?.addEventListener('click', () => {
    // Persist the preference so the splash is skipped on subsequent launches.
    if (document.getElementById('welcome-dont-show')?.checked) {
      localStorage.setItem('disc-forge-hide-welcome', '1');
    }
    setState({ showWelcome: false });
  });
  document.getElementById('save-project-btn')?.addEventListener('click', saveProject);
  document.getElementById('load-project-btn')?.addEventListener('click', loadProject);

  // Burn to disc
  document.getElementById('burn-btn')?.addEventListener('click', async () => {
    if (!state.builtIsoPath) return;

    // 1. Require a connected burner — give the user a clear escape if there is none.
    let burner = null;
    try { burner = await window.discForge.checkBurner(); } catch (_) { burner = { found: false }; }
    if (!burner || !burner.found) {
      showInfo('No disc burner detected.\n\nConnect a Blu-ray burner and try again.');
      return;
    }

    // 2. Confirm — burning overwrites any disc in the drive. Cancel = escape.
    //    The checkbox opts into post-burn verification (default OFF — the
    //    fast path is unchanged); `verify` arrives as the callback arg.
    showConfirm('Insert a blank BD-R disc, then click Burn.\n\nThis will overwrite any disc in the drive.', async (verify) => {
      // 3. Burn via growisofs (never auto-verify or auto-eject). Pass the device
      //    node resolved by checkBurner (e.g. /dev/disk9) through to the burn handler.
      window.discForge.removeAllListeners('burn-progress');
      setState({
        burning: true, burnStatus: 'starting', burnMessage: 'Preparing to burn…',
        burnDone: false, burnError: null, burnPercent: 0,
        burnDriveInfo: { drives: [{ name: burner.name || 'Optical Drive', isBDCapable: true }] },
      });

      window.discForge.onBurnProgress(data => {
        if (data.status === 'done') setState({ burnDone: true, burnStatus: 'done', burnMessage: data.message, burnPercent: 100 });
        else if (data.status === 'error') setState({ burning: true, burnError: data.message });
        else setState({ burnStatus: data.status, burnMessage: data.message, burnPercent: data.percent != null ? data.percent : state.burnPercent });
      });
      const result = await window.discForge.burnDisc({ isoPath: state.builtIsoPath, deviceNode: burner.deviceNode, verify });
      if (result && result.error) setState({ burning: true, burnError: result.error });
    }, { title: 'Burn to Disc', confirmLabel: 'Burn',
         checkboxLabel: 'Verify after burn (reads the disc start back — adds about a minute)' });
  });
  document.getElementById('close-burn-modal')?.addEventListener('click', () => {
    window.discForge.removeAllListeners('burn-progress');
    setState({ burning: false, burnDone: false, burnError: null, burnStatus: null, burnMessage: '', ejectMsg: null });
  });
  document.getElementById('eject-disc')?.addEventListener('click', async () => {
    setState({ ejectMsg: 'Ejecting…' });
    const r = await window.discForge.ejectDisc();
    setState({ ejectMsg: r && r.success ? 'Disc ejected.' : (r && r.error) || 'Could not eject the disc.' });
  });
  document.getElementById('reveal-iso')?.addEventListener('click', revealISO);
  document.getElementById('preview-vlc')?.addEventListener('click', previewInVLC);

  // Menus-off banner on the Menus tab (A6)
  document.getElementById('menus-banner-enable')?.addEventListener('click', () => setState({ menusEnabled: true }));

  // Recent projects (welcome screen)
  document.querySelectorAll('[data-recent-path]').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); loadRecentProject(el.dataset.recentPath); });
  });
  document.getElementById('clear-recents')?.addEventListener('click', async (e) => {
    e.preventDefault();
    setState({ recentProjects: await window.discForge.recentsClear() });
  });

  // In-app dialog (showInfo / showConfirm)
  document.getElementById('app-dialog-ok')?.addEventListener('click', () => {
    const fn = _dialogOnConfirm;
    const checked = !!document.getElementById('app-dialog-checkbox')?.checked;
    _dialogOnConfirm = null;
    setState({ appDialog: null });
    if (fn) fn(checked);
  });
  document.getElementById('app-dialog-cancel')?.addEventListener('click', () => {
    _dialogOnConfirm = null;
    setState({ appDialog: null });
  });

  // ── v1.19.0 menu switcher (Main Menu / Chapter Select) above the TV bezel ──
  document.querySelectorAll('.menu-switch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.getAttribute('data-menu');
      if (m && state.templateEditor.activeMenu !== m) {
        state.templateEditor.activeMenu = m;
        scheduleMenuPreview();   // flips the caption to "Rendering…" and re-renders the bezel
      }
    });
  });

  // ── v1.18.0 layout overlay — (re)size + (re)wire drag handlers + paint guides.
  // Always last: the overlay needs the final DOM in place. Drag state survives a
  // re-render because it lives in state.templateEditor, not the DOM.
  initLayoutOverlay();
}

// ── Start ──────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', _onLayoutKeydown);   // layout-editor button deletion (once)
render();
boot();

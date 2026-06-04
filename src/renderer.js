// ── Constants ─────────────────────────────────────────────────────────────────
// Track which input has focus so we can restore it after re-render
let _focusedId  = null;
let _focusedPos = null;  // cursor position
let _renderTimer = null;

function scheduleRender() {
  // Batch rapid state changes into a single render
  clearTimeout(_renderTimer);
  _renderTimer = setTimeout(() => {
    const activeEl = document.activeElement;
    if (activeEl && activeEl.id) {
      _focusedId  = activeEl.id;
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
  project: {
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
  },
  // ── v1.13.0 menu templates ────────────────────────────────────────────────
  templates: { builtIn: [], user: [], loaded: false },
  templateEditor: {
    selectedId: 'classic',
    draft: null,        // working copy (object) of the selected template
    baseline: null,     // pristine copy for Revert / dirty detection
    error: null,        // validateTemplate error surfaced inline
    previews: {},       // { menu, normal, selected: dataURL } for selectedId
    previewKey: null,   // hash of the draft the previews were rendered from
    menuRendering: false, // true while the full-screen menu preview is in flight
    advancedPalette: false,
    busy: false,
    nameModal: null,    // {mode:'duplicate'|'saveAs', value} — name-entry modal (Electron lacks window.prompt)
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
  showWelcome: true,  // show onboarding on first launch
  showAbout: false,
};

function uid()      { return Math.random().toString(36).slice(2,9); }
function setState(p){
  Object.assign(state, p);
  // For tab switches and modal changes, render immediately
  // For text input changes, render is already batched via scheduleRender
  render();
}
function setPrj(p)  { setState({ project: { ...state.project, ...p } }); }
function setPrjText(p) {
  // Used for text inputs — saves focus before re-render
  const activeEl = document.activeElement;
  if (activeEl && activeEl.id) {
    _focusedId  = activeEl.id;
    _focusedPos = activeEl.selectionStart ?? null;
  }
  Object.assign(state, { project: { ...state.project, ...p } });
  render();
}
function setForm(t,p){ setState({ form: { ...state.form, [t]: { ...state.form[t], ...p } } }); }
function esc(s)     { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  const tools    = await window.discForge.checkTools();
  const homeDir  = await window.discForge.getHomeDir();
  const outputDir = homeDir + '/Desktop';
  const appVersion = await window.discForge.getAppVersion().catch(() => '');
  setState({ tools, appVersion, project: { ...state.project, outputDir } });

  // Load installed system fonts
  try {
    if (window.queryLocalFonts) {
      const fonts = await window.queryLocalFonts();
      const unique = [...new Set(fonts.map(f => f.family))].sort();
      state.systemFonts = unique;
    }
  } catch(e) {
    // queryLocalFonts not available or permission denied - use defaults
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
  if (!videoPath) { alert('Please add a video file first.'); return; }
  if (p.chapters.length === 0) { alert('No chapters defined.'); return; }

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
    const ok = confirm(`⚠ Estimated disc size (~${estGb} GB) exceeds BD-50 capacity (46.6 GB).\n\nConsider splitting into multiple discs. Continue anyway?`);
    if (!ok) return;
  } else if (estBytes > BD25_BYTES && (p.discSize === 'BD-25' || !p.discSize)) {
    const ok = confirm(`⚠ Estimated disc size (~${estGb} GB) exceeds BD-25 capacity (23.3 GB).\n\nTip: Switch to BD-50 in the sidebar, or split into multiple discs. Continue anyway?`);
    if (!ok) return;
  }

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
  setState({ building:true, buildSteps:steps, buildCurrentStep:0, buildDone:false, buildError:null, builtIsoPath:null, ffmpegLog:'' });
  // Include enabled embedded tracks alongside manual tracks
  const includedEmbedded = (state.embeddedTracks||[]).filter(t => t.included !== false);
  const embeddedAudio = includedEmbedded.filter(t => t.role==='audio');
  const embeddedSubs  = includedEmbedded.filter(t => t.role==='subtitle');
  // Passthrough mode: skip FFmpeg mux if main video is BD-compatible AND not CRF-encoding
  const mainCompat = state.titleCompatibility?.[p.mainVideo?.path];
  const mainHasCrf = p.mainVideo?.videoQuality && p.mainVideo.videoQuality !== 'passthrough';
  const buildProject = {
    ...p,
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
  setState({ building:false, buildDone:false, buildError:null });
}
function revealISO() { if (state.builtIsoPath) window.discForge.revealInFinder(state.builtIsoPath); }

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
  ed.error = null;
  ed.previews = {};
  ed.previewKey = null;
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
  const [selR, norR] = await Promise.all([
    window.discForge.templatePreviewButton({ template: tpl, state: 'selected', label: 'Play Episode 1' }),
    window.discForge.templatePreviewButton({ template: tpl, state: 'normal',   label: 'Play Episode 2' }),
  ]);
  // Keep any prior full-screen menu image while the heavier render re-runs.
  ed.previews = {
    ...ed.previews,
    selected: (selR && selR.ok) ? selR.pngBase64 : null,
    normal:   (norR && norR.ok) ? norR.pngBase64 : null,
  };
  if (selR && !selR.ok) ed.error = selR.error;
  render();
  // The full-screen menu scene is heavier — render it on its own 400ms debounce.
  scheduleMenuPreview();
}

// The full-screen 1920×1080 menu preview is more expensive than the button PNGs
// (whole-frame canvas + 3 button bitmaps), so it gets a longer 400ms debounce
// and a "Rendering…" caption while in flight. A sequence guard drops stale
// results so the last edit always wins.
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
  const r = await window.discForge.templatePreviewMenu({ template: tpl });
  if (seq !== _menuSeq) return;  // a newer render started — drop this stale result
  ed.menuRendering = false;
  ed.previews = { ...ed.previews, menu: (r && r.ok) ? r.pngBase64 : null };
  render();
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
  if (!r || !r.ok) { window.alert('Could not save: ' + (r && r.error)); render(); return; }
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
  if (!r || !r.ok) { window.alert('Could not save: ' + (r && r.error)); return; }
  await loadTemplates();
  await selectTemplate(r.id);  // re-reads from disk → baseline reset, dirty cleared
}
function revertTemplate() {
  const ed = state.templateEditor;
  if (!ed.baseline) return;
  ed.draft = JSON.parse(JSON.stringify(ed.baseline));
  ed.error = null;
  render();
  refreshPreviews();
}
async function deleteTemplate() {
  const ed = state.templateEditor;
  if (isReadonly(ed.selectedId)) return;
  const meta = templateMeta(ed.selectedId);
  // Native Electron confirm dialog.
  if (!window.confirm(`Delete the template “${meta ? meta.name : ed.selectedId}”? This cannot be undone.`)) return;
  const r = await window.discForge.templateDelete(ed.selectedId);
  if (!r || !r.ok) { window.alert('Could not delete: ' + (r && r.error)); return; }
  await loadTemplates();  // loadTemplates re-selects a valid template (first built-in)
  state.templateEditor.selectedId = 'classic';
  await selectTemplate('classic');
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

// Live preview pane: a full-screen 16:9 menu scene (what the TV shows), with the
// isolated Normal/Selected button PNGs available as a collapsible detail below.
// On a validation error, the pane shows the error banner instead.
function previewHTML() {
  const ed = state.templateEditor;
  if (ed.error) return `<div class="tpl-error">⚠ ${esc(ed.error)}</div>`;
  const menu = ed.previews.menu;
  const caption = ed.menuRendering
    ? 'Rendering…'
    : (menu ? 'Preview — 3 sample buttons, center of 1920×1080 frame'
            : 'Full-screen preview unavailable — see button states below');
  const btn = (src, label) => `<div class="tpl-preview-col">
      <span class="tpl-preview-label">${label}</span>
      ${src ? `<img class="tpl-preview-img tpl-preview-img-sm" src="${src}" alt="${label} button preview">`
            : `<div class="tpl-preview-img tpl-preview-img-sm" style="width:200px;height:40px"></div>`}
    </div>`;
  return `<div class="field"><label class="field-label">Preview</label>
    <div class="tpl-menu-preview-wrap">
      ${menu ? `<img src="${menu}" alt="Full menu preview">` : ''}
    </div>
    <div class="tpl-menu-preview-caption">${esc(caption)}</div>
    <details class="tpl-btn-detail">
      <summary>Button states</summary>
      <div class="tpl-preview-row">${btn(ed.previews.normal, 'Normal')}${btn(ed.previews.selected, 'Selected')}</div>
    </details>
  </div>`;
}

// "white" / "#rrggbb" → "#rrggbb" for a color <input>.
function _fontColorHex(c) {
  if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) return c;
  if (c === 'white') return '#ffffff';
  if (c === 'black') return '#000000';
  return '#ffffff';
}

// Phase 4A read-only field display (built-ins).
function templateReadonlyFields(tpl) {
  const bg = tpl.background;
  const paletteRows = tpl.palette.map(e => `
    <div class="tpl-pal-row">
      <span class="tpl-swatch" style="background:${_paletteHex(e)}"></span>
      <span class="tpl-pal-idx">#${e.id}</span>
      <span class="tpl-pal-role">${esc(_entryRoles(tpl, e.id))}</span>
      <span class="tpl-pal-val">${_paletteHex(e)} · Y${e.Y} Cr${e.Cr} Cb${e.Cb}</span>
    </div>`).join('');
  return `
    <div class="field"><label class="field-label">Name</label>
      <input type="text" value="${esc(tpl.name)}" disabled></div>
    <div class="field"><label class="field-label">Palette</label>
      <div class="tpl-pal-list">${paletteRows}</div></div>
    <div class="field"><label class="field-label">Button geometry</label>
      <div class="tpl-kv">
        <span>Width <b>${tpl.button.width}</b></span>
        <span>Height <b>${tpl.button.height}</b></span>
        <span>Gap <b>${tpl.button.gap}</b></span>
        <span>Border <b>${tpl.button.border}</b></span>
      </div></div>
    <div class="field"><label class="field-label">Font</label>
      <div class="tpl-kv">
        <span>File <b>${esc(tpl.font.file)}</b></span>
        <span>Size ratio <b>${tpl.font.sizeRatio}</b></span>
        <span>Color <b>${esc(tpl.font.color)}</b></span>
      </div></div>
    <div class="field"><label class="field-label">Background</label>
      <div class="tpl-kv">
        <span>Type <b>${esc(bg.type)}</b></span>
        ${bg.type === 'solid'
          ? `<span>Color <b>#${esc(bg.color)}</b></span><span class="tpl-swatch" style="background:#${esc(bg.color)}"></span>`
          : `<span>Fit <b>${esc(bg.fit)}</b></span><span>Image <b>${bg.imagePath ? esc(bg.imagePath.split('/').pop()) : '(none — set per disc)'}</b></span>`}
      </div></div>`;
}

// Phase 4B editable editor (user templates).
function templateEditorFields(tpl) {
  const adv = state.templateEditor.advancedPalette;
  const b = tpl.button;
  const bg = tpl.background;

  const paletteRows = tpl.palette.map((e, i) => `
    <div class="tpl-pal-edit">
      <input type="color" id="tpl-pal-color-${i}" value="${_paletteHex(e)}">
      <span class="tpl-pal-idx">#${e.id}</span>
      <span class="tpl-pal-role">${esc(_entryRoles(tpl, e.id))}</span>
      ${adv ? `<span class="tpl-yuv">
        <input type="number" id="tpl-pal-Y-${i}"  value="${e.Y}"  min="0" max="255" title="Y">
        <input type="number" id="tpl-pal-Cr-${i}" value="${e.Cr}" min="0" max="255" title="Cr">
        <input type="number" id="tpl-pal-Cb-${i}" value="${e.Cb}" min="0" max="255" title="Cb">
      </span>` : ''}
    </div>`).join('');

  return `
    <div class="field"><label class="field-label">Name</label>
      <input type="text" id="tpl-name" value="${esc(tpl.name)}" placeholder="Template name"></div>

    <div class="field">
      <label class="field-label" style="display:flex;justify-content:space-between;align-items:center">
        <span>Palette</span>
        <label style="display:flex;gap:6px;align-items:center;font-weight:400;font-size:11px;text-transform:none;letter-spacing:0;cursor:pointer">
          <input type="checkbox" id="tpl-adv-palette" ${adv ? 'checked' : ''} style="width:13px;height:13px"> Edit YCbCr
        </label>
      </label>
      <div class="tpl-pal-list">${paletteRows}</div>
    </div>

    <div class="field"><label class="field-label">Button geometry</label>
      <div class="field-row" style="display:flex;gap:12px;flex-wrap:wrap">
        <label style="font-size:11px;color:var(--text-secondary)">Width
          <input type="number" id="tpl-geo-width"  value="${b.width}"  min="1" max="1920" style="width:80px"></label>
        <label style="font-size:11px;color:var(--text-secondary)">Height
          <input type="number" id="tpl-geo-height" value="${b.height}" min="1" max="1080" style="width:80px"></label>
        <label style="font-size:11px;color:var(--text-secondary)">Gap
          <input type="number" id="tpl-geo-gap"    value="${b.gap}"    min="0" max="400" style="width:70px"></label>
        <label style="font-size:11px;color:var(--text-secondary)">Border
          <input type="number" id="tpl-geo-border" value="${b.border}" min="0" max="40" style="width:70px"></label>
      </div></div>

    <div class="field"><label class="field-label">Font</label>
      <div class="field-row" style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
        <label style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:2px">File
          <input type="text" value="${esc(tpl.font.file)}" disabled title="Custom fonts arrive in v1.14" style="width:140px"></label>
        <label style="font-size:11px;color:var(--text-secondary);flex:1;min-width:160px">Size ratio (${tpl.font.sizeRatio})
          <input type="range" id="tpl-font-size" min="0.3" max="0.9" step="0.05" value="${tpl.font.sizeRatio}" style="width:100%"></label>
        <label style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:2px">Color
          <input type="color" id="tpl-font-color" value="${_fontColorHex(tpl.font.color)}"></label>
      </div></div>

    <div class="field"><label class="field-label">Background</label>
      <div style="display:flex;gap:16px;align-items:center;margin-bottom:8px">
        <label style="display:flex;gap:5px;align-items:center;font-size:12px;cursor:pointer">
          <input type="radio" name="tpl-bg-type" id="tpl-bg-type-solid" value="solid" ${bg.type === 'solid' ? 'checked' : ''}> Solid</label>
        <label style="display:flex;gap:5px;align-items:center;font-size:12px;cursor:pointer">
          <input type="radio" name="tpl-bg-type" id="tpl-bg-type-image" value="image" ${bg.type === 'image' ? 'checked' : ''}> Image</label>
      </div>
      ${bg.type === 'solid' ? `
        <div class="field-row" style="display:flex;gap:10px;align-items:center">
          <span style="font-size:11px;color:var(--text-secondary)">Color</span>
          <input type="color" id="tpl-bg-color" value="#${esc(bg.color)}">
        </div>` : `
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-ghost btn-xs" id="tpl-bg-image">${bg.imagePath ? esc(bg.imagePath.split('/').pop()) : 'Pick image…'}</button>
            ${bg.imagePath ? '<button class="btn btn-ghost btn-xs" id="tpl-bg-image-clear">&#x2715;</button>' : ''}
          </div>
          <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
            <label style="font-size:11px;color:var(--text-secondary)">Fit
              <select id="tpl-bg-fit" style="font-size:12px">
                ${['cover', 'contain', 'stretch'].map(f => `<option value="${f}" ${bg.fit === f ? 'selected' : ''}>${f}</option>`).join('')}
              </select></label>
            <label style="font-size:11px;color:var(--text-secondary);display:flex;gap:6px;align-items:center">Letterbox / flatten color
              <input type="color" id="tpl-bg-color" value="#${esc(bg.color)}"></label>
          </div>
        </div>`}
    </div>`;
}

function templateDetailHTML(tpl, ro) {
  const toolbar = ro
    ? `<div class="tpl-toolbar"><button class="btn btn-primary btn-sm" id="tpl-duplicate">Duplicate to edit</button></div>`
    : `<div class="tpl-toolbar">
        <button class="btn btn-primary btn-sm" id="tpl-save" ${isDirty() ? '' : 'disabled'}>Save</button>
        <button class="btn btn-secondary btn-sm" id="tpl-save-as">Save As…</button>
        <button class="btn btn-ghost btn-sm" id="tpl-revert" ${isDirty() ? '' : 'disabled'}>Revert</button>
        <button class="btn btn-danger btn-sm" id="tpl-delete">Delete</button>
      </div>`;
  const fields = ro ? templateReadonlyFields(tpl) : templateEditorFields(tpl);
  return `
    <div class="tpl-detail-head">
      <div>
        <div class="tpl-detail-name">${esc(tpl.name)}${(!ro && isDirty()) ? ' •' : ''}</div>
        <div class="tpl-detail-desc">${esc(tpl.description || '')}</div>
      </div>
      <span class="badge ${ro ? 'badge-blue' : 'badge-green'}">${ro ? 'Built-in · read-only' : 'Custom'}</span>
    </div>
    ${toolbar}
    ${previewHTML()}
    ${fields}`;
}

function pageTemplates() {
  const ed = state.templateEditor;
  const t  = state.templates;

  const row = (m) => `
    <div class="tpl-list-item ${m.id === ed.selectedId ? 'active' : ''}" data-tpl-id="${esc(m.id)}">
      <span class="tpl-list-name">${esc(m.name)}</span>
      <span class="badge ${m.readonly ? 'badge-blue' : 'badge-green'}">${m.readonly ? 'Built-in' : 'Custom'}</span>
    </div>`;

  let listHTML = '';
  if (!t.loaded) {
    listHTML = `<div class="tpl-list-empty">Loading…</div>`;
  } else {
    // Group built-in templates by category. Known categories appear in this
    // order; any unrecognized category is appended alphabetically after them.
    const CATEGORY_ORDER = ['Solid', 'Modern', 'Bold', 'Wide Format', 'Image Background'];
    const byCat = {};
    for (const m of t.builtIn) {
      const cat = (m.category && m.category.trim()) ? m.category : 'Other';
      (byCat[cat] = byCat[cat] || []).push(m);
    }
    const cats = [
      ...CATEGORY_ORDER.filter(c => byCat[c]),
      ...Object.keys(byCat).filter(c => !CATEGORY_ORDER.includes(c)).sort(),
    ];
    for (const cat of cats) {
      const items = byCat[cat].slice().sort((a, b) => a.name.localeCompare(b.name));
      listHTML += `<div class="tpl-list-group">${esc(cat)}</div>` + items.map(row).join('');
    }
    // User/custom templates always live in a single group at the bottom.
    listHTML += `<div class="tpl-list-group">Custom</div>`;
    listHTML += t.user.length ? t.user.map(row).join('') : `<div class="tpl-list-empty">No custom templates yet</div>`;
  }

  const tpl = ed.draft;
  const ro  = isReadonly(ed.selectedId);
  const detail = tpl
    ? templateDetailHTML(tpl, ro)
    : `<div class="empty-state"><div class="empty-state-icon">🖌</div><div class="empty-state-text">Select a template to view it</div></div>`;

  return `
    <div class="page-header"><div class="page-header-left">
      <div class="page-title">Menu Templates</div>
      <div class="page-subtitle">Customize the look of interactive disc menus. Built-in templates are read-only — duplicate one to edit.</div>
    </div></div>
    <div class="tpl-layout">
      <div class="tpl-list card">${listHTML}</div>
      <div class="tpl-editor card">${detail}</div>
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
          💿 Burn to Disc
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
            <div style="display:flex;gap:10px;align-items:center">
              <label style="font-size:12px;color:var(--text-secondary);min-width:52px">Title</label>
              <input type="text" id="ig-menu-title" value="${esc(p.igMenuConfig?.title||'')}" placeholder="Menu title (optional)" style="flex:1;font-size:12px;padding:3px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary)">
            </div>
            <div style="display:flex;gap:10px;align-items:center">
              <label style="font-size:12px;color:var(--text-secondary);min-width:52px">Template</label>
              <select id="ig-template" style="flex:1;font-size:12px;padding:3px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary)">
                ${templateOptionsHTML(p.igMenuConfig?.templateId || 'classic')}
              </select>
              <button class="btn btn-ghost btn-xs" id="ig-edit-templates" title="Open the template editor">Edit…</button>
            </div>
            <div style="font-size:11px;color:var(--text-tertiary);margin:-2px 0 2px 62px">The template controls the menu palette, button geometry, font, and background.</div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <label style="font-size:12px;color:var(--text-secondary);min-width:52px">Background</label>
              <input type="color" id="ig-bg-color" value="${p.igMenuConfig?.bgColor||'#1a1a2e'}" style="width:36px;height:24px;cursor:pointer;border:none;border-radius:4px;padding:1px;background:none">
              <button class="btn btn-ghost btn-xs" id="ig-pick-bg-image">${p.igMenuConfig?.bgImagePath ? esc(p.igMenuConfig.bgImagePath.split('/').pop()) : 'Pick BG image'}</button>
              ${p.igMenuConfig?.bgImagePath ? '<button class="btn btn-ghost btn-xs" id="ig-clear-bg-image">&#x2715;</button>' : ''}
            </div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <label style="font-size:12px;color:var(--text-secondary);min-width:52px">Buttons</label>
              <span style="font-size:11px;color:var(--text-tertiary)">BG</span>
              <input type="color" id="ig-btn-bg" value="${p.igMenuConfig?.buttonBgColor||'#2a2a4a'}" style="width:30px;height:22px;cursor:pointer;border:none;border-radius:3px;padding:1px;background:none">
              <span style="font-size:11px;color:var(--text-tertiary)">Text</span>
              <input type="color" id="ig-btn-text" value="${p.igMenuConfig?.buttonTextColor||'#ffffff'}" style="width:30px;height:22px;cursor:pointer;border:none;border-radius:3px;padding:1px;background:none">
              <span style="font-size:11px;color:var(--text-tertiary)">Selected</span>
              <input type="color" id="ig-btn-hl" value="${p.igMenuConfig?.buttonHighlightColor||'#ff8800'}" style="width:30px;height:22px;cursor:pointer;border:none;border-radius:3px;padding:1px;background:none">
            </div>
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
        <div class="page-subtitle">Define navigation markers — embedded as FFMETADATA in the stream</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" id="import-chapters-btn">📥 Import from Video</button>
        ${p.chapters.length > 0 ? '<button class="btn btn-ghost btn-sm" id="gen-thumbs-btn">🖼 Generate Thumbnails</button>' : ''}
        ${p.chapters.length > 0 ? '<button class="btn btn-ghost btn-sm" id="clear-chapters-btn" style="color:#e05050">🗑 Clear All</button>' : ''}
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><div class="card-icon">➕</div><div><div class="card-title">Add Chapter</div></div></div>
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
      ? `<div class="empty-state"><div class="empty-state-icon">≡</div><div class="empty-state-text">No chapters defined yet</div></div>`
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
      '<div class="modal-actions">' +
      '<button class="btn btn-ghost" id="close-modal">Close</button>' +
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
    <div class="modal-sub">Your disc has been burned and ejected.</div>
    <div class="modal-actions"><button class="btn btn-ghost" id="close-burn-modal">Done</button></div>
  </div></div>`;

  // Drive info panel
  const drivePanel = burnDriveInfo ? (() => {
    const d = burnDriveInfo;
    const discOk = d.discStatus?.hasDisc;
    const driveName = d.drives?.[0]?.name || 'Optical Drive';
    const discLabel = discOk
      ? (d.discStatus.isBlank ? (d.discStatus.isBD ? 'Blank BD-R detected' : 'Blank disc detected') : 'Disc detected (check it is blank)')
      : 'No disc detected — insert a blank BD-R';
    return `<div style="background:var(--bg-sunken);border:1px solid var(--border-dim);border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:var(--text-secondary)">
      <div style="font-weight:600;color:var(--text-primary);margin-bottom:4px">💿 ${esc(driveName)}</div>
      <div style="${discOk?'color:var(--green)':'color:var(--red)'}">${discLabel}</div>
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
    { icon:'🖌', title:'Pick a menu (optional)', desc:'Enable "Menus" in Project Settings, then open the Menus tab to choose a template. A full-screen preview shows exactly how the disc menu will look.' },
    { icon:'🔨', title:'Build & burn', desc:'Click "Build Disc Image" to create your ISO. Once done, insert a blank BD-R and click "Burn to Disc".' },
  ];

  const stepsHTML = steps.map(function(s) {
    return '<div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:14px">' +
      '<div style="width:36px;height:36px;border-radius:10px;background:var(--gold-glow);border:1px solid rgba(219,184,90,0.4);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">' + s.icon + '</div>' +
      '<div>' +
      '<div style="font-size:13px;font-weight:700;color:var(--text-primary);margin-bottom:3px">' + s.title + '</div>' +
      '<div style="font-size:12px;color:var(--text-secondary);line-height:1.6">' + s.desc + '</div>' +
      '</div></div>';
  }).join('');

  return '<div class="modal-backdrop"><div class="modal-box" style="max-width:480px">' +
    '<div style="text-align:center;margin-bottom:20px">' +
    '<div style="font-size:48px;margin-bottom:8px">💿</div>' +
    '<div style="font-size:22px;font-weight:700;color:var(--text-primary);margin-bottom:6px">Welcome to Disc Forge</div>' +
    '<div style="font-size:13px;color:var(--text-tertiary)">Professional Blu-ray authoring for macOS</div>' +
    '</div>' +
    stepsHTML +
    '<div style="background:var(--gold-glow);border:1px solid rgba(219,184,90,0.3);border-radius:8px;padding:12px 14px;margin-bottom:16px">' +
    '<div style="font-size:12px;color:var(--gold-bright);font-weight:700;margin-bottom:4px">💡 Quick tip</div>' +
    '<div style="font-size:12px;color:var(--text-secondary);line-height:1.5">Adding a video auto-detects its embedded audio, subtitle, and chapter tracks — review them in the Project tab\'s Track Summary before building.</div>' +
    '</div>' +
    '<div class="modal-actions">' +
    '<button class="btn btn-primary" id="close-welcome" style="width:100%;font-size:15px;padding:12px">Get Started →</button>' +
    '</div>' +
    '</div></div>';
}

// ── About Modal ───────────────────────────────────────────────────────────────
function aboutModalHTML() {
  const versions = [
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
    '<div style="font-size:12px;color:var(--gold);font-weight:600;margin-bottom:4px">Version 1.11.0</div>' +
    '<div style="font-size:11px;color:var(--text-tertiary)">Disc Forge v1.11.0 — Autoplay Blu-ray authoring with experimental menu support</div>' +
    '</div>' +
    '<div style="max-height:320px;overflow-y:auto;border-top:1px solid var(--border-dim);border-bottom:1px solid var(--border-dim);padding:12px 0;margin-bottom:14px">' +
    '<div style="font-size:10px;letter-spacing:.1em;color:var(--text-tertiary);margin-bottom:10px;text-align:center">VERSION HISTORY</div>' +
    vHTML +
    '</div>' +
    '<div style="font-size:11px;color:var(--text-tertiary);text-align:center;margin-bottom:6px">Powered by FFmpeg · tsMuxeR · hdiutil</div>' +
    '<div style="font-size:11px;color:var(--text-tertiary);text-align:center;margin-bottom:14px">Copyright © 2026 ETHM</div>' +
    '<div class="modal-actions"><button class="btn btn-ghost" id="close-about">Close</button></div>' +
    '</div></div>';
}

// ── Project Save/Load ──────────────────────────────────────────────────────────
async function saveProject() {
  const proj = {
    version: '1.5',
    title: state.project.title,
    description: state.project.description,
    discLabel: state.project.discLabel,
    resolution: state.project.resolution,
    videoFormat: state.project.videoFormat,
    outputDir: state.project.outputDir,
    discSize: state.project.discSize,
    mainVideo: state.project.mainVideo,
    titles: state.project.titles || [],
    audioTracks: state.project.audioTracks,
    subtitleTracks: state.project.subtitleTracks,
    chapters: state.project.chapters,
    extras: state.project.extras,
    menuConfig: state.project.menuConfig,
    embeddedTracks: state.embeddedTracks || [],
  };
  const json = JSON.stringify(proj, null, 2);
  const savePath = await window.discForge.saveProjectFile(json);
  if (savePath) {
    alert('Project saved to: ' + savePath);
  }
}

async function loadProject() {
  const json = await window.discForge.loadProjectFile();
  if (!json) return;
  try {
    const proj = JSON.parse(json);
    state.embeddedTracks = proj.embeddedTracks || [];
    // Match resolution to known values (exact string match required for <select>)
    const loadedRes = RESOLUTIONS.find(r => r === proj.resolution) || RESOLUTIONS[0];
    const loadedFmt = VIDEO_FMTS.find(f => f === proj.videoFormat) || VIDEO_FMTS[0];
    setPrj({
      title: proj.title || '',
      description: proj.description || '',
      discLabel: proj.discLabel || '',
      resolution: loadedRes,
      videoFormat: loadedFmt,
      outputDir: proj.outputDir || '',
      discSize: proj.discSize || 'BD-25',
      mainVideo: proj.mainVideo || null,
      titles: proj.titles || [],
      audioTracks: proj.audioTracks || [],
      subtitleTracks: proj.subtitleTracks || [],
      chapters: proj.chapters || [],
      extras: proj.extras || [],
      useSplash: proj.useSplash || false,
      menuConfig: { ...state.project.menuConfig, ...(proj.menuConfig || {}) },
    });
  } catch(e) {
    alert('Failed to load project: ' + e.message);
  }
}

// ── Listeners ──────────────────────────────────────────────────────────────────
function attachListeners() {
  // Restore focus to previously focused input after re-render
  if (_focusedId) {
    // Check for title-label-input by data-title-id
    let el = document.getElementById(_focusedId);
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
  document.getElementById('use-splash')?.addEventListener('change',  e => setPrj({ useSplash: e.target.checked }));
  document.getElementById('use-ig-menu')?.addEventListener('change', e => setPrj({ useIGMenu: e.target.checked }));
  document.getElementById('ig-menu-title')?.addEventListener('input', e => setPrj({ igMenuConfig: { ...state.project.igMenuConfig, title: e.target.value } }));
  document.getElementById('ig-bg-color')?.addEventListener('input', e => setPrj({ igMenuConfig: { ...state.project.igMenuConfig, bgColor: e.target.value } }));
  document.getElementById('ig-pick-bg-image')?.addEventListener('click', async () => {
    const r = await pickFile([{ name: 'Image', extensions: ['png', 'jpg', 'jpeg'] }]);
    if (r) setPrj({ igMenuConfig: { ...state.project.igMenuConfig, bgImagePath: r } });
  });
  document.getElementById('ig-clear-bg-image')?.addEventListener('click', () => setPrj({ igMenuConfig: { ...state.project.igMenuConfig, bgImagePath: null } }));
  document.getElementById('ig-btn-bg')?.addEventListener('input', e => setPrj({ igMenuConfig: { ...state.project.igMenuConfig, buttonBgColor: e.target.value } }));
  document.getElementById('ig-btn-text')?.addEventListener('input', e => setPrj({ igMenuConfig: { ...state.project.igMenuConfig, buttonTextColor: e.target.value } }));
  document.getElementById('ig-btn-hl')?.addEventListener('input', e => setPrj({ igMenuConfig: { ...state.project.igMenuConfig, buttonHighlightColor: e.target.value } }));
  document.querySelectorAll('.ig-label-input').forEach(el => {
    el.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const labels = [...(state.project.igMenuConfig?.buttonLabels || [])];
      labels[idx] = e.target.value;
      setPrj({ igMenuConfig: { ...state.project.igMenuConfig, buttonLabels: labels } });
    });
  });
  // Menu template dropdown (build flow) → igMenuConfig.templateId
  document.getElementById('ig-template')?.addEventListener('change', e =>
    setPrj({ igMenuConfig: { ...state.project.igMenuConfig, templateId: e.target.value } }));
  document.getElementById('ig-edit-templates')?.addEventListener('click', () =>
    setState({ tab: 'templates' }));

  // Templates tab — list selection
  document.querySelectorAll('.tpl-list-item').forEach(el =>
    el.addEventListener('click', () => selectTemplate(el.dataset.tplId)));

  // Templates tab — editor (Phase 4B)
  document.getElementById('tpl-duplicate')?.addEventListener('click', duplicateSelected);
  document.getElementById('tpl-name-modal-cancel')?.addEventListener('click', cancelNameModal);
  document.getElementById('tpl-name-modal-ok')?.addEventListener('click', confirmNameModal);
  document.getElementById('tpl-save')?.addEventListener('click', saveTemplate);
  document.getElementById('tpl-save-as')?.addEventListener('click', () => openNameModal('saveAs'));
  document.getElementById('tpl-revert')?.addEventListener('click', revertTemplate);
  document.getElementById('tpl-delete')?.addEventListener('click', deleteTemplate);
  document.getElementById('tpl-adv-palette')?.addEventListener('change', e => {
    state.templateEditor.advancedPalette = e.target.checked; render();
  });
  document.getElementById('tpl-name')?.addEventListener('input', e =>
    updateDraft(t => { t.name = e.target.value; }));

  // Palette: RGB color picker + optional YCbCr advanced inputs (per entry).
  (state.templateEditor.draft?.palette || []).forEach((_, i) => {
    document.getElementById(`tpl-pal-color-${i}`)?.addEventListener('input', e => {
      const [r, g, b] = window.discForge.color.hexToRgb(e.target.value);
      const yuv = window.discForge.color.rgbToYuv(r, g, b);
      updateDraft(t => { t.palette[i].Y = yuv.Y; t.palette[i].Cr = yuv.Cr; t.palette[i].Cb = yuv.Cb; });
    });
    ['Y', 'Cr', 'Cb'].forEach(ch => {
      document.getElementById(`tpl-pal-${ch}-${i}`)?.addEventListener('input', e => {
        const v = Math.max(0, Math.min(255, parseInt(e.target.value, 10) || 0));
        updateDraft(t => { t.palette[i][ch] = v; });
      });
    });
  });

  // Geometry
  const geo = (id, key, lo, hi) => document.getElementById(id)?.addEventListener('input', e => {
    const v = Math.max(lo, Math.min(hi, parseInt(e.target.value, 10) || lo));
    updateDraft(t => { t.button[key] = v; });
  });
  geo('tpl-geo-width', 'width', 1, 1920);
  geo('tpl-geo-height', 'height', 1, 1080);
  geo('tpl-geo-gap', 'gap', 0, 400);
  geo('tpl-geo-border', 'border', 0, 40);

  // Font
  document.getElementById('tpl-font-size')?.addEventListener('input', e =>
    updateDraft(t => { t.font.sizeRatio = parseFloat(e.target.value); }));
  document.getElementById('tpl-font-color')?.addEventListener('input', e =>
    updateDraft(t => { t.font.color = e.target.value; }));

  // Background
  document.getElementById('tpl-bg-type-solid')?.addEventListener('change', () =>
    updateDraft(t => { t.background.type = 'solid'; }));
  document.getElementById('tpl-bg-type-image')?.addEventListener('change', () =>
    updateDraft(t => { t.background.type = 'image'; }));
  document.getElementById('tpl-bg-color')?.addEventListener('input', e =>
    updateDraft(t => { t.background.color = e.target.value.replace(/^#/, ''); }));
  document.getElementById('tpl-bg-fit')?.addEventListener('change', e =>
    updateDraft(t => { t.background.fit = e.target.value; }));
  document.getElementById('tpl-bg-image')?.addEventListener('click', async () => {
    const r = await pickFile([{ name: 'Image', extensions: ['png', 'jpg', 'jpeg'] }]);
    if (r) updateDraft(t => { t.background.imagePath = r; });
  });
  document.getElementById('tpl-bg-image-clear')?.addEventListener('click', () =>
    updateDraft(t => { t.background.imagePath = null; }));
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
    if (!videoPath) { alert('Please add a video file first.'); return; }
    const probe = await window.discForge.probeFile(videoPath);
    if (!probe.success || !probe.data) { alert('Could not probe video file.'); return; }
    const chapters = probe.data.chapters || [];
    if (chapters.length === 0) { alert('No chapter markers found in this video file.'); return; }
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
    alert('Imported ' + newChapters.length + ' chapters!');
  });
  document.getElementById('gen-thumbs-btn')?.addEventListener('click', generateChapterThumbnails);
  document.getElementById('clear-chapters-btn')?.addEventListener('click', () => {
    if (confirm('Clear all chapters?')) setPrj({ chapters: [] });
  });

  document.getElementById('close-modal')?.addEventListener('click', closeBuildModal);
  document.getElementById('about-btn')?.addEventListener('click', () => setState({ showAbout: true }));
  document.getElementById('close-about')?.addEventListener('click', () => setState({ showAbout: false }));
  document.getElementById('close-welcome')?.addEventListener('click', () => setState({ showWelcome: false }));
  document.getElementById('save-project-btn')?.addEventListener('click', saveProject);
  document.getElementById('load-project-btn')?.addEventListener('click', loadProject);

  // Burn to disc
  document.getElementById('burn-btn')?.addEventListener('click', async () => {
    if (!state.builtIsoPath) return;
    window.discForge.removeAllListeners('burn-progress');
    setState({ burning: true, burnStatus: 'checking', burnMessage: 'Detecting optical drives...', burnDone: false, burnError: null, burnPercent: 0, burnDriveInfo: null });

    // Detect drives and show info
    try {
      const driveInfo = await window.discForge.detectDrives();
      setState({ burnDriveInfo: driveInfo, burnMessage: 'Drive detected — starting burn...' });
    } catch(_) {}

    window.discForge.onBurnProgress(data => {
      if (data.status === 'done') setState({ burnDone: true, burnStatus: 'done', burnMessage: data.message, burnPercent: 100 });
      else if (data.status === 'error') setState({ burning: true, burnError: data.message });
      else setState({ burnStatus: data.status, burnMessage: data.message, burnPercent: data.percent != null ? data.percent : state.burnPercent });
    });
    const result = await window.discForge.burnISO(state.builtIsoPath);
    if (result.error) setState({ burning: true, burnError: result.error });
  });
  document.getElementById('close-burn-modal')?.addEventListener('click', () => {
    window.discForge.removeAllListeners('burn-progress');
    setState({ burning: false, burnDone: false, burnError: null, burnStatus: null, burnMessage: '' });
  });
  document.getElementById('reveal-iso')?.addEventListener('click', revealISO);


}

// ── Start ──────────────────────────────────────────────────────────────────────
render();
boot();

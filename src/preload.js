const { contextBridge, ipcRenderer } = require('electron');
const color = require('./lib/color');

contextBridge.exposeInMainWorld('discForge', {
  // YCbCr-601 ↔ RGB (single source of truth in src/lib/color.js) for the
  // template editor's palette pickers — the renderer never re-derives the math.
  color: {
    yuvToRgb: (Y, Cr, Cb) => color.yuvToRgb(Y, Cr, Cb),
    rgbToYuv: (r, g, b)   => color.rgbToYuv(r, g, b),
    rgbToHex: (rgb)       => color.rgbToHex(rgb),
    hexToRgb: (hex)       => color.hexToRgb(hex),
  },
  // Core
  getAppVersion:    ()        => ipcRenderer.invoke('app-version'),
  getHomeDir:       ()        => ipcRenderer.invoke('get-home-dir'),
  checkTools:       ()        => ipcRenderer.invoke('check-tools'),
  openFileDialog:   (opts)    => ipcRenderer.invoke('open-file-dialog', opts),
  openFilesDialog:  (opts)    => ipcRenderer.invoke('open-files-dialog', opts),
  detectDrive:      ()        => ipcRenderer.invoke('detect-drive'),
  detectDrives:     ()        => ipcRenderer.invoke('detect-drives'),
  detectBdCompatibility: (fp) => ipcRenderer.invoke('detect-bd-compatibility', fp),
  generateChapterThumbnail: (fp, time, out) => ipcRenderer.invoke('generate-chapter-thumbnail', fp, time, out),
  burnISO:          (iso)     => ipcRenderer.invoke('burn-iso', iso),
  onBurnProgress:   (cb)      => ipcRenderer.on('burn-progress', (_, d) => cb(d)),
  saveProjectFile:  (json)    => ipcRenderer.invoke('save-project-file', json),
  loadProjectFile:  ()        => ipcRenderer.invoke('load-project-file'),
  openFolderDialog: ()        => ipcRenderer.invoke('open-folder-dialog'),
  probeFile:        (filePath)=> ipcRenderer.invoke('probe-file', filePath),
  buildDisc:        (project) => ipcRenderer.invoke('build-disc', project),
  buildMultiTitleDisc: (args) => ipcRenderer.invoke('build-multi-title-disc', args),
  revealInFinder:   (filePath)=> ipcRenderer.invoke('reveal-in-finder', filePath),

  // Menu templates (v1.13.0). Renderer-side editor UI is Phase 4.
  templateList:      ()                 => ipcRenderer.invoke('template-list'),
  templateLoad:      (id)               => ipcRenderer.invoke('template-load', id),
  templateValidate:  (template)         => ipcRenderer.invoke('template-validate', template),
  templateSave:      (template)         => ipcRenderer.invoke('template-save', template),
  templateSaveAs:    (template, newName)=> ipcRenderer.invoke('template-save-as', { template, newName }),
  templateDuplicate: (id, newName)      => ipcRenderer.invoke('template-duplicate', { id, newName }),
  templateDelete:    (id)               => ipcRenderer.invoke('template-delete', id),
  templatePreviewButton: (opts)         => ipcRenderer.invoke('template-preview-button', opts),
  templatePreviewMenu:   (opts)         => ipcRenderer.invoke('template-preview-menu', opts),

  // Build events
  onBuildProgress:    (cb) => ipcRenderer.on('build-progress',  (_, d) => cb(d)),
  onFFmpegProgress:   (cb) => ipcRenderer.on('ffmpeg-progress', (_, d) => cb(d)),
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),

  // Window controls (for custom traffic-light buttons)
  windowClose:    () => ipcRenderer.send('window-close'),
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
});

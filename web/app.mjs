import { ERROR_MESSAGES, SERVER_BUSY_MESSAGE, getAPIError, isUnreachableError, parseAPIResponse } from './response-core.mjs';
import { imageExtensionForMime, normalizeImageMime, readImageFile, resolveResultImageInfo } from './image-core.mjs';
import { consumeSSE } from './sse-core.mjs';
import { cancelDissolve, cancelDissolveIfResized, scheduleDissolve } from './particle-core.mjs';
import { petalBurst } from './petal-core.mjs';

const GENERATION_TIMEOUT_MS = 90_000;
const GENERATION_STAGE_LABELS = ['准备照片', '生成合影', '整理成片'];
// Fixed preview id set; docker/nginx.conf and scripts/verify-wedding-assets.mjs repeat it.
const OUTFIT_ID_PATTERN = /^W0(0[1-9]|[12][0-9]|30)$/;
// Fixed venue preview id set; docker/nginx.conf and scripts/verify-wedding-assets.mjs repeat it.
const VENUE_ID_PATTERN = /^V00[1-7]$/;
const EXPECTED_VENUE_PREVIEWS = 7;
const GENERATION_STAGES = Object.freeze(Object.fromEntries([
  ['reading_input', 'validating_request', 'validating_images', 'preparing_assets', 'assembling_request'],
  ['connection_acquisition', 'waiting_upstream_response', 'connection_acquired', 'dns_lookup', 'tcp_connect',
    'tls_handshake', 'request_upload', 'first_response_byte', 'provider_response_headers', 'reading_provider_response', 'upstream_request_failed'],
  ['validating_provider_result', 'validating_result'],
].flatMap((phases, index) => phases.map(phase => [phase, index]))));
const SAMPLE_PHOTO_URL = '/web/public/wedding-example.jpg';
const AMBIENT_DEFAULT_URL = '/web/public/florals.jpg';
const ROOM_TITLES = ['room-photo-title', 'room-outfit-title', 'room-scene-title', 'room-result-title'];
// 生成码会放在 Authorization 头里，只有可见 ASCII 才能通过 fetch 的请求头校验。
const ASCII_TOKEN = /^[\x21-\x7E]+$/;
const TRACK_EASE = 'translate3d';

const track = document.querySelector('#gallery-track');
const dock = document.querySelector('#floating-dock');
const stepper = document.querySelector('#header-stepper');
const formAlert = document.querySelector('#form-alert');
const photoFrame = document.querySelector('#photo-frame');
const roomPhotoContent = document.querySelector('#room-photo-content');
const scanBeam = document.querySelector('#photo-scan-beam');
const coupleInput = document.querySelector('#couple-image');
const sceneInput = document.querySelector('#scene-image');
const outfitLayers = [document.querySelector('#outfit-hero-a'), document.querySelector('#outfit-hero-b')];
const sceneLayers = [document.querySelector('#scene-hero-a'), document.querySelector('#scene-hero-b')];
const outfitCanvas = document.querySelector('#outfit-particle-canvas');
const outfitPreview = document.querySelector('#outfit-preview');
const experience = document.querySelector('#experience');
const scenePreview = document.querySelector('#scene-preview');
const sceneCanvas = document.querySelector('#scene-particle-canvas');
const resultSlot = document.querySelector('#result-slot');
const apertureOverlay = document.querySelector('#aperture-overlay');
const generationStatus = document.querySelector('#generation-status');
const generationElapsed = document.querySelector('#generation-elapsed');
const cancelButton = document.querySelector('#cancel-generation');
const tokenInput = document.querySelector('#access-token');
const accessDialog = document.querySelector('#access-dialog');
const accessForm = document.querySelector('#access-form');
const healthStatus = document.querySelector('#health-status');
const invitationScreen = document.querySelector('#invitation-screen');
const openInvitationButton = document.querySelector('#open-invitation');
const petalCanvas = document.querySelector('#petal-canvas');
const invitationSound = document.querySelector('#invitation-sound');

const state = {
  room: 0,
  coupleImage: null,
  photoURL: '',
  outfits: [],
  outfitId: '',
  outfitPreviews: new Map(),
  outfitPreviewsError: '',
  outfitPreviewVersion: 0,
  outfitHero: { key: '', status: '', retryable: false },
  venuePreviews: new Map(),
  sceneMode: 'original',
  sceneImage: null,
  sceneURL: '',
  sceneVenueId: '',
  sceneHero: { key: '', status: '', retryable: false },
  scenePreviewVersion: 0,
  venues: [],
  resultURL: '',
  resultMime: '',
  resultData: null,
  resultMetaText: '',
  comparePct: 50,
  selectionVersion: 0,
  sceneVersion: 0,
  operation: { kind: 'idle' },
};
const bufferToggle = { ambient: false, outfit: false, scene: false };
const previewResize = new ResizeObserver(entries => {
  // 布局更新会连带触发尺寸通知；只有播放中尺寸真的变了才取消，避免把
  // 刚开始的动效误判为错位。
  for (const entry of entries) {
    const canvas = entry.target.querySelector('.particle-canvas');
    if (canvas) cancelDissolveIfResized(canvas);
  }
});
for (const canvas of [outfitCanvas, sceneCanvas]) previewResize.observe(canvas.parentElement);
let pendingSnapshot = null;
let accessReturnFocus = null;
let alertTimer = 0;
let draggingCompare = false;
// Remove credentials saved by the superseded opt-in setting.
localStorage.removeItem('vowmirror-access-token');

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function prefersReducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isBusy() {
  return state.operation.kind !== 'idle';
}

/* =========================================================================
   操作状态机：统一驱动 dock / stepper / 生成遮罩的可用性
   ========================================================================= */
function setOperation(next) {
  state.operation = next;
  const generating = next.kind === 'generation';
  const verifying = next.kind === 'authorization';
  const dialogBusy = verifying || generating;
  apertureOverlay.hidden = !generating;
  cancelButton.hidden = !generating;
  for (const element of document.querySelectorAll('.gallery-header, #gallery-viewport, #floating-dock')) element.inert = generating;
  // 弹窗控件在核验/生成期间保持锁定，重复确认由操作守卫兜底。
  const confirmButton = document.querySelector('#confirm-access');
  confirmButton.disabled = dialogBusy;
  confirmButton.textContent = verifying ? '正在核验…' : '确认并生成';
  tokenInput.disabled = dialogBusy;
  renderStepper();
  renderDock();
}

function setHealth(stateText, text) {
  healthStatus.textContent = text;
  healthStatus.parentElement.dataset.state = stateText;
}

async function checkHealth() {
  setHealth('pending', '正在检查服务');
  try {
    const response = await fetch('/api/health', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
    const body = await parseAPIResponse(response);
    if (!response.ok || body.code !== 0 || body.data?.status !== 'ok') throw new Error('服务暂不可用');
    setHealth('ok', '服务连接正常');
  } catch {
    setHealth('error', '服务连接失败');
  }
}

/* =========================================================================
   顶部步骤导航 + 房间导航
   ========================================================================= */
function renderStepper() {
  const steps = ['合照', '造型', '场景', '成片'];
  stepper.replaceChildren(...steps.map((label, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `stepper-link${state.room === index ? ' is-current' : ''}`;
    button.disabled = isBusy();
    if (state.room === index) button.setAttribute('aria-current', 'step');
    button.innerHTML = `<span class="step-no">0${index + 1}</span><span class="step-label">${label}</span>`;
    button.addEventListener('click', () => goToRoom(index));
    return button;
  }));
}

function isPresetRoom() {
  return state.room === 1 || (state.room === 2 && state.sceneMode === 'venue');
}

// 跨入场馆预设画框（全幅布局）时画框尺寸翻转：溶解按 cover 铺满最终画框取样，
// contain 旧图否则只在新画框中央留下一条窄带。离开场馆时旧图自身恒为 cover
// （.preset-hero-photo），同框切换（原背景↔上传）维持各自 object-fit，均无需覆盖。
function sceneHeroDissolveFit() {
  return state.sceneMode === 'venue' ? 'cover' : null;
}

function syncPresetRoom() {
  experience.classList.toggle('is-preset-room', isPresetRoom());
}

function goToRoom(index) {
  if (index < 0 || index > 3 || isBusy()) return;
  state.room = index;
  syncPresetRoom();
  document.querySelectorAll('.gallery-room').forEach((room, i) => { room.inert = i !== index; });
  track.style.transform = `${TRACK_EASE}(-${index * 100}vw, 0, 0)`;
  renderStepper();
  renderDock();
  syncAmbient();
  if (index === 1) refreshOutfitHero(false);
  // 重建导航与 dock 会移除原焦点元素；立即把焦点交给目标展厅标题。
  document.getElementById(ROOM_TITLES[index])?.focus({ preventScroll: true });
}

/* =========================================================================
   环境背景：双缓冲交叉淡入（默认花卉，随选择与结果切换）
   ========================================================================= */
function updateAmbientBackdrop(url) {
  const target = url || AMBIENT_DEFAULT_URL;
  const incoming = bufferToggle.ambient ? document.querySelector('#ambient-bg-a') : document.querySelector('#ambient-bg-b');
  const outgoing = bufferToggle.ambient ? document.querySelector('#ambient-bg-b') : document.querySelector('#ambient-bg-a');
  if (outgoing.getAttribute('src') === target) return;
  incoming.addEventListener('error', () => { incoming.style.opacity = '0'; }, { once: true });
  incoming.src = target;
  incoming.style.opacity = '1';
  outgoing.style.opacity = '0';
  bufferToggle.ambient = !bufferToggle.ambient;
}

function syncAmbient() {
  if (state.room === 2 && state.sceneMode === 'upload' && state.sceneURL) updateAmbientBackdrop(state.sceneURL);
  else if (state.room === 3 && state.resultURL) updateAmbientBackdrop(state.resultURL);
  else if (state.photoURL) updateAmbientBackdrop(state.photoURL);
  else updateAmbientBackdrop(AMBIENT_DEFAULT_URL);
}

/* =========================================================================
   编辑风大图构建 + 双缓冲交叉淡入 / 粒子溶解
   预设画框：造型与固定场馆共用同一画框、cover 裁切、焦点、状态与重试
   ========================================================================= */
function heroMarkup({ src, focus = null }) {
  const style = focus ? ` style="object-position:${focus.map(value => `${value * 100}%`).join(' ')}"` : '';
  return `<img class="hero-photo" src="${escapeHTML(src)}" alt="照片完整预览"${style}>`;
}

function coupleHeroSrc() {
  return state.photoURL || SAMPLE_PHOTO_URL;
}

// 非动画切换：直接覆盖后缓冲层并清空另一层，作为下一轮溶解的底图。
function showHeroImmediately(layers, canvas, content) {
  cancelDissolve(canvas);
  layers[1].replaceChildren();
  if (content instanceof HTMLImageElement) layers[1].append(content);
  else layers[1].innerHTML = content;
  layers[1].style.opacity = '1';
  layers[1].classList.add('is-front');
  layers[0].replaceChildren();
  layers[0].style.opacity = '0';
  layers[0].classList.remove('is-front');
  bufferToggle[canvas === outfitCanvas ? 'outfit' : 'scene'] = true;
}

// 双缓冲切换：粒子溶解可用则旧图溶解为新图，否则退回纯交叉淡入。
// fit 覆盖旧图自身的 object-fit：跨越预设画框边界（场景厅进出全幅预设布局，
// 画框尺寸翻转）时传 'cover'，旧图按 cover 铺满最终画框取样，
// contain 旧图才不会只在新画框中央留下一条窄带。
function transitionHero(layers, canvas, content, fit = null) {
  const incoming = bufferToggle[canvas === outfitCanvas ? 'outfit' : 'scene'] ? layers[0] : layers[1];
  const outgoing = bufferToggle[canvas === outfitCanvas ? 'outfit' : 'scene'] ? layers[1] : layers[0];
  cancelDissolve(canvas);

  const showIncoming = () => {
    incoming.style.transition = 'none';
    incoming.style.opacity = '0';
    if (content instanceof HTMLImageElement) incoming.replaceChildren(content);
    else incoming.innerHTML = content;
    void incoming.offsetWidth;
    incoming.style.transition = '';
    incoming.style.opacity = '1';
    outgoing.style.opacity = '0';
    incoming.classList.add('is-front');
    outgoing.classList.remove('is-front');
  };

  // 图片状态立即提交；粒子在本次布局更新完成后的两帧才按最终画框取样，
  // 未启动的取样会被后续选择统一取消，不能阻塞或覆盖新图。
  if (!prefersReducedMotion()) scheduleDissolve({ canvas, source: outgoing.querySelector('img'), fit });
  showIncoming();
  setTimeout(() => { if (outgoing.style.opacity === '0') outgoing.innerHTML = ''; }, prefersReducedMotion() ? 0 : 500);
  bufferToggle[canvas === outfitCanvas ? 'outfit' : 'scene'] = !bufferToggle[canvas === outfitCanvas ? 'outfit' : 'scene'];
}

const PRESET_FRAMES = {
  outfit: { layers: outfitLayers, canvas: outfitCanvas, label: '#outfit-preview-label', status: '#outfit-preview-status', retry: '#retry-outfit-preview', version: 'outfitPreviewVersion', hero: 'outfitHero', previews: 'outfitPreviews' },
  scene: { layers: sceneLayers, canvas: sceneCanvas, label: '#scene-preview-label', status: '#scene-preview-status', retry: '#retry-scene-preview', version: 'scenePreviewVersion', hero: 'sceneHero', previews: 'venuePreviews' },
};

function renderPresetFrame(target) {
  const frame = PRESET_FRAMES[target];
  const hero = state[frame.hero];
  document.querySelector(frame.status).textContent = hero.status;
  // 场景厅的提示层只在场馆加载中或失败时出现，原背景与上传照片不显示。
  document.querySelector(frame.label).hidden = !hero.status;
  document.querySelector(frame.retry).hidden = !hero.retryable;
}

// 造型与固定场馆的唯一加载路径：解码后再切换，迟到的结果由各次请求的版本号丢弃，
// 失败时清空旧图并保留明确提示与手动重试。
async function showPresetHero({ target, animate, key, id = key, preview, idleLabel, noun, fit = null }) {
  const frame = PRESET_FRAMES[target];
  const hero = state[frame.hero];
  const version = ++state[frame.version];
  if (hero.key === key) {
    renderPresetFrame(target);
    return;
  }
  hero.key = key;
  hero.retryable = false;
  hero.status = `${idleLabel} · 正在载入…`;
  renderPresetFrame(target);
  try {
    if (!preview) throw new Error(state.outfitPreviewsError || `展示素材清单中缺少此${noun === '场馆图片' ? '场馆图片' : '造型'}`);
    const image = new Image();
    image.className = 'hero-photo preset-hero-photo';
    // 单张加载失败时由状态与重试按钮报告；不挂 alt 文本，避免浏览器在画框里画出破图图标。
    image.alt = '';
    if (target === 'outfit') image.dataset.outfitId = id;
    else image.dataset.venueId = id;
    image.style.objectPosition = preview.focus.map(value => `${value * 100}%`).join(' ');
    image.src = `/web/public/${preview.display.file}`;
    await image.decode();
    if (version !== state[frame.version]) return;
    hero.status = idleLabel;
    if (animate) transitionHero(frame.layers, frame.canvas, image, fit);
    else showHeroImmediately(frame.layers, frame.canvas, image);
    renderPresetFrame(target);
  } catch (error) {
    if (version !== state[frame.version]) return;
    cancelDissolve(frame.canvas);
    for (const layer of frame.layers) layer.replaceChildren();
    hero.retryable = true;
    hero.status = `${noun}加载失败：${error.message}`;
    renderPresetFrame(target);
  }
}

/* =========================================================================
   Room 0 · 合照
   ========================================================================= */
function renderPhotoRoom() {
  if (state.photoURL) {
    roomPhotoContent.innerHTML = heroMarkup({ src: state.photoURL });
  } else {
    roomPhotoContent.innerHTML = `
      <div class="hero-empty" data-action="upload-photo">
        <img src="${SAMPLE_PHOTO_URL}" alt="">
        <span class="plus-ring" aria-hidden="true"><svg class="icon plus-ring-icon"><use href="#icon-upload"/></svg></span>
        <span class="plus-label">上传合照</span>
      </div>`;
  }
}

function triggerScanBeam() {
  scanBeam.classList.remove('is-scanning');
  void scanBeam.offsetWidth;
  scanBeam.classList.add('is-scanning');
}

async function selectPhoto(file) {
  if (isBusy()) return;
  const version = ++state.selectionVersion;
  hideAlert();
  clearResult();
  if (!file) return;
  try {
    const image = await readImageFile(file);
    if (version !== state.selectionVersion) return;
    state.coupleImage = image;
    releasePhotoURL();
    state.photoURL = URL.createObjectURL(new Blob([image.bytes], { type: image.mime }));
    renderPhotoRoom();
    triggerScanBeam();
    refreshSceneHero(false);
    syncAmbient();
    renderDock();
  } catch (error) {
    if (version !== state.selectionVersion) return;
    showAlert(error.message);
  }
}

function releasePhotoURL() {
  if (state.photoURL) URL.revokeObjectURL(state.photoURL);
  state.photoURL = '';
}

function releaseSceneURL() {
  if (state.sceneURL) URL.revokeObjectURL(state.sceneURL);
  state.sceneURL = '';
}

function releaseResultURL() {
  if (state.resultURL) URL.revokeObjectURL(state.resultURL);
  state.resultURL = '';
}

/* =========================================================================
   Room 1 · 造型（真实目录名称瓦片）
   ========================================================================= */
function orderedOutfits() {
  const preferred = ['W001', 'W004', 'W002', 'W003'];
  return [...state.outfits].sort((a, b) => {
    const rank = item => preferred.includes(item.id) ? preferred.indexOf(item.id) : preferred.length + state.outfits.indexOf(item);
    return rank(a) - rank(b);
  });
}

function currentOutfit() {
  return state.outfits.find(item => item.id === state.outfitId) || null;
}

async function refreshOutfitHero(animate) {
  const id = state.outfitId || 'W001';
  const outfit = state.outfits.find(item => item.id === id);
  const preview = state.outfitPreviews.get(id);
  await showPresetHero({
    target: 'outfit', animate,
    key: id,
    preview,
    idleLabel: `造型示例 · ${outfit?.name || id}`,
    noun: '造型示例',
  });
}

function selectOutfit(outfit) {
  if (!state.outfits.includes(outfit)) return;
  state.outfitId = outfit.id;
  clearResult();
  refreshOutfitHero(true);
  syncAmbient();
  // 保留卡片、焦点与浏览位置；选择本身不重建滚动容器。
  const strip = dock.querySelector('.dock-thumb-strip');
  if (!strip) return;
  for (const tile of strip.querySelectorAll('[data-action="select-outfit"]')) {
    const active = tile.dataset.arg === outfit.id;
    tile.classList.toggle('is-active', active);
    tile.setAttribute('aria-pressed', String(active));
  }
}

async function retryPresetPreview(target) {
  if (target === 'scene' && state.sceneMode !== 'venue') return;
  const frame = PRESET_FRAMES[target];
  if (!state[frame.previews].size) {
    await loadOutfitPreviews();
    renderDock();
  }
  state[frame.hero].key = '';
  if (target === 'outfit') refreshOutfitHero(false);
  else refreshSceneHero(false);
}

document.querySelector('#retry-outfit-preview').addEventListener('click', () => retryPresetPreview('outfit'));
document.querySelector('#retry-scene-preview').addEventListener('click', () => retryPresetPreview('scene'));

/* =========================================================================
   Room 2 · 场景（保留原背景 / 上传场地照片 / 固定场馆仅当目录提供）
   ========================================================================= */
function currentVenue() {
  return state.venues.find(item => item.id === state.sceneVenueId) || null;
}

function currentVenuePreview() {
  return state.sceneMode === 'venue' ? state.venuePreviews.get(state.sceneVenueId) || null : null;
}

function sceneHeroKey() {
  if (state.sceneMode === 'venue') return `venue:${state.sceneVenueId}`;
  if (state.sceneMode === 'upload') return `upload:${state.sceneURL}`;
  return `original:${coupleHeroSrc()}`;
}

async function refreshSceneHero(animate) {
  const sceneUploaded = state.sceneMode === 'upload' && state.sceneURL;
  const venue = currentVenue();
  const venuePreview = currentVenuePreview();
  const reference = document.querySelector('#scene-reference');
  reference.hidden = !sceneUploaded || !state.photoURL;
  reference.innerHTML = reference.hidden ? '' : `<img src="${escapeHTML(state.photoURL)}" alt="合照参考"><span>合照参考 · 下方为场地照片</span>`;
  // 场景模式已定，fit 只依赖它；到达 venue 前后的预设状态取值一致，与画面内容无关。
  const fit = sceneHeroDissolveFit();
  if (state.sceneMode !== 'venue') {
    const markup = heroMarkup({ src: sceneUploaded ? state.sceneURL : coupleHeroSrc() });
    state.sceneHero.key = sceneHeroKey();
    state.sceneHero.retryable = false;
    state.sceneHero.status = '';
    renderPresetFrame('scene');
    // 立即作废尚未完成的预设解码；各次请求提交前还会再次核对版本号。
    state.scenePreviewVersion++;
    if (animate) transitionHero(sceneLayers, sceneCanvas, markup, fit);
    else showHeroImmediately(sceneLayers, sceneCanvas, markup);
    return;
  }
  await showPresetHero({
    target: 'scene', animate,
    key: sceneHeroKey(),
    id: state.sceneVenueId,
    preview: venuePreview,
    idleLabel: `场馆示例 · ${venue?.name || state.sceneVenueId}`,
    noun: '场馆图片',
    fit,
  });
}

function selectVenue(id) {
  if (!state.venues.some(venue => venue.id === id)) return;
  state.sceneMode = 'venue';
  state.sceneVenueId = id;
  clearResult();
  syncPresetRoom();
  renderDock();
  refreshSceneHero(true);
  syncAmbient();
}

function selectSceneMode(mode) {
  state.sceneMode = mode;
  // 切换场景方式即放弃已选场馆；上传照片只在离开上传方式时释放。
  state.sceneVenueId = '';
  clearResult();
  // 模式切换使进行中的场景图解码失效，迟到的选择不能覆盖新模式。
  state.sceneVersion++;
  if (mode !== 'upload') {
    releaseSceneURL();
    state.sceneImage = null;
    sceneInput.value = '';
  }
  syncPresetRoom();
  renderDock();
  refreshSceneHero(true);
  syncAmbient();
}

async function selectScene(file) {
  if (isBusy()) return;
  const version = ++state.sceneVersion;
  clearResult();
  if (!file) return;
  try {
    const image = await readImageFile(file);
    if (version !== state.sceneVersion) return;
    state.sceneMode = 'upload';
    state.sceneImage = image;
    releaseSceneURL();
    state.sceneURL = URL.createObjectURL(new Blob([image.bytes], { type: image.mime }));
    syncPresetRoom();
    renderDock();
    refreshSceneHero(true);
    syncAmbient();
  } catch (error) {
    if (version !== state.sceneVersion) return;
    showAlert(error.message);
  }
}

function clearScene() {
  state.sceneVersion++;
  state.sceneImage = null;
  sceneInput.value = '';
  releaseSceneURL();
}

/* =========================================================================
   Room 3 · 成片（真实结果对比，无兜底合成）
   ========================================================================= */
function sceneTitle() {
  if (state.sceneMode === 'upload' && state.sceneImage) return '场地照片';
  if (state.sceneMode === 'venue' && currentVenue()) return currentVenue().name;
  return '保留原背景';
}

function renderResultRoom(decodedImage = null) {
  const outfit = currentOutfit();
  if (!state.resultURL || !state.resultData) {
    resultSlot.innerHTML = `
      <div class="result-empty">
        <img src="${SAMPLE_PHOTO_URL}" alt="">
        <p class="empty-note"><span id="result-status" role="status"></span></p>
      </div>`;
    return;
  }
  const pct = state.comparePct;
  resultSlot.innerHTML = `
    <div class="compare-stage" id="reveal-compare-stage" role="slider" tabindex="0"
      aria-label="左右拖动对比合照与成片" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
      <img src="${escapeHTML(state.photoURL || SAMPLE_PHOTO_URL)}" alt="原始合照">
      <div class="compare-after" id="reveal-after-layer">
        <img id="result-image" src="${escapeHTML(state.resultURL)}" alt="生成的双人婚礼合影">
      </div>
      <div class="compare-divider" id="reveal-divider">
        <div class="compare-handle" aria-hidden="true"><svg class="icon"><use href="#icon-compare"/></svg></div>
      </div>
    </div>
    <h3 class="result-caption">${escapeHTML(outfit ? `${outfit.name} · ${sceneTitle()}` : '婚礼合影')}</h3>
    <details class="result-details"><summary>生成详情</summary><p id="result-meta" class="result-meta"></p></details>`;
  if (decodedImage) {
    decodedImage.alt = '生成的双人婚礼合影';
    document.querySelector('#result-image').replaceWith(decodedImage);
  }
  document.querySelector('#result-meta').textContent = state.resultMetaText;
  updateCompare(state.comparePct);
}

function clearResult() {
  releaseResultURL();
  state.resultData = null;
  state.resultMetaText = '';
  renderResultRoom();
}

/* =========================================================================
   底部 dock（事件委托）
   ========================================================================= */
function dockButton(action, arg, label, kind = 'ivory', extra = '') {
  return `<button type="button" data-action="${action}"${arg ? ` data-arg="${escapeHTML(arg)}"` : ''} class="${kind}-pill" ${extra}>${label}</button>`;
}

function thumbTile({ action, arg, active, inner, label }) {
  return `
    <button type="button" class="dock-thumb-btn${active ? ' is-active' : ''}" data-action="${action}"${arg ? ` data-arg="${escapeHTML(arg)}"` : ''}
      aria-pressed="${active}" aria-label="${escapeHTML(label)}">${inner}</button>`;
}

function revealDockTile(tile) {
  if (!tile) return;
  const strip = tile.parentElement;
  const bounds = strip.getBoundingClientRect();
  const selected = tile.getBoundingClientRect();
  const padding = parseFloat(getComputedStyle(strip).paddingLeft);
  const left = selected.left - bounds.left - padding;
  const right = selected.right - bounds.right + padding;
  // 只移动目录，避免 scrollIntoView 连带滚动工具栏或页面。
  if (left < 0 || right > 0) strip.scrollBy({ left: left < 0 ? left : right, behavior: 'instant' });
}

function renderDock() {
  const previousStrip = dock.querySelector('.dock-thumb-strip');
  const previousScroll = previousStrip?.scrollLeft ?? 0;
  // 重建 dock 后把焦点还给同义控件，键盘选择不会跌回 body。
  // 按钮被按住时不记录 dock 焦点：重建出的新按钮会顶替按下位置，导致鼠标点击落空。
  const pressed = dockDrag !== null || [...dock.querySelectorAll('button')].some(node => node.matches(':active'));
  const previousFocus = dock.contains(document.activeElement) && !pressed ? document.activeElement : null;
  const busy = isBusy();
  const busyFlag = busy ? 'disabled' : '';
  if (state.room === 0) {
    dock.innerHTML = `
      ${dockButton('upload-photo', '', '上传合照', 'ivory', busyFlag)}
      ${dockButton('go-room', '1', '下一步', 'charcoal', busyFlag)}`;
  } else if (state.room === 1) {
    const tiles = orderedOutfits().map(outfit => thumbTile({
      action: 'select-outfit', arg: outfit.id,
      active: outfit.id === state.outfitId,
      inner: `${state.outfitPreviews.has(outfit.id) ? `<img class="outfit-thumbnail" src="/web/public/${escapeHTML(state.outfitPreviews.get(outfit.id).thumbnail.file)}" alt="" width="320" height="240" loading="lazy" decoding="async" draggable="false">` : ''}<span class="outfit-card-name">${escapeHTML(outfit.name)}</span>`,
      label: `选择造型：${outfit.name}`,
    })).join('');
    dock.innerHTML = `
      <div class="dock-thumb-strip" role="group" aria-label="婚礼造型目录">${tiles}</div>
      ${dockButton('go-room', '2', '下一步', 'charcoal', busyFlag)}`;
  } else if (state.room === 2) {
    const modeTile = (mode, icon, label) => thumbTile({
      action: 'set-scene-mode', arg: mode,
      active: state.sceneMode === mode,
      inner: `<span class="mode-tile"><svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg>${label}</span>`,
      label,
    });
    const venueTiles = state.venues.map(venue => thumbTile({
      action: 'select-venue', arg: venue.id,
      active: state.sceneMode === 'venue' && state.sceneVenueId === venue.id,
      inner: `${state.venuePreviews.has(venue.id) ? `<img class="outfit-thumbnail" src="/web/public/${escapeHTML(state.venuePreviews.get(venue.id).thumbnail.file)}" alt="" width="320" height="240" loading="lazy" decoding="async" draggable="false">` : ''}<span class="outfit-card-name">${escapeHTML(venue.name)}</span>`,
      label: `选择场馆：${venue.name}`,
    })).join('');
    const hint = state.sceneMode === 'upload' && !state.sceneImage ? '<p class="dock-hint">请先上传一张场地照片</p>' : '';
    dock.innerHTML = `
      <div class="dock-thumb-strip" role="group" aria-label="场景方式">${modeTile('original', 'icon-home', '保留原背景')}${modeTile('upload', 'icon-upload', '上传场地照片')}${venueTiles}</div>
      ${hint}
      ${dockButton('generate', '', '生成成片', 'charcoal', `${busyFlag} id="generate"`)}`;
  } else {
    const download = state.resultURL
      ? `<a id="download-result" class="charcoal-pill" download="vowmirror-wedding.${imageExtensionForMime(state.resultMime || 'image/png')}" href="${escapeHTML(state.resultURL)}">下载成片</a>`
      : dockButton('noop', '', '下载成片', 'charcoal', 'disabled');
    dock.innerHTML = `
      ${dockButton('restart', '', '重选', 'ivory', busyFlag)}
      ${dockButton('generate', '', '重新生成', 'ivory', `${busyFlag} id="regenerate"`)}
      ${download}`;
  }
  if (busy) dock.querySelectorAll('button').forEach(node => { node.disabled = true; });
  const strip = dock.querySelector('.dock-thumb-strip');
  // 同一目录重绘保留浏览位置，避免选中后先回到开头再扫过整个列表。
  const sameList = strip && previousStrip?.getAttribute('aria-label') === strip.getAttribute('aria-label');
  if (sameList) {
    strip.scrollTo({ left: Math.min(previousScroll, Math.max(0, strip.scrollWidth - strip.clientWidth)), behavior: 'instant' });
  }
  if (!sameList) revealDockTile(strip?.querySelector('.dock-thumb-btn.is-active'));
  // 造型厅与场景厅预设模式把 dock 叠在预览画框内；普通展厅留在视口下方，避免遮挡完整照片。
  const host = isPresetRoom() ? (state.room === 1 ? outfitPreview : scenePreview) : experience;
  if (dock.parentElement !== host) host.append(dock);
}

const DOCK_DRAG_THRESHOLD_PX = 6;
let dockDrag = null;
let suppressDockClick = false;

dock.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'mouse' || event.button !== 0 || isBusy()) return;
  suppressDockClick = false;
  const strip = event.target.closest('.dock-thumb-strip');
  if (!strip || strip.scrollWidth <= strip.clientWidth) return;
  // 接管鼠标聚焦，避免边缘卡片在按下时被浏览器自动滚入视野。
  event.preventDefault();
  event.target.closest('button')?.focus({ preventScroll: true });
  dockDrag = { pointerId: event.pointerId, strip, startX: event.clientX, scrollLeft: strip.scrollLeft, dragging: false };
});

dock.addEventListener('pointermove', event => {
  if (!dockDrag || event.pointerId !== dockDrag.pointerId) return;
  const distance = event.clientX - dockDrag.startX;
  if (!dockDrag.dragging) {
    if (Math.abs(distance) < DOCK_DRAG_THRESHOLD_PX) return;
    dockDrag.dragging = true;
    dockDrag.strip.classList.add('is-dragging');
    dock.setPointerCapture(event.pointerId);
  }
  event.preventDefault();
  dockDrag.strip.scrollTo({ left: dockDrag.scrollLeft - distance, behavior: 'instant' });
});

function finishDockDrag(event) {
  if (!dockDrag || event.pointerId !== dockDrag.pointerId) return;
  suppressDockClick = dockDrag.dragging;
  dockDrag.strip.classList.remove('is-dragging');
  dockDrag = null;
  if (dock.hasPointerCapture(event.pointerId)) dock.releasePointerCapture(event.pointerId);
}

window.addEventListener('pointerup', finishDockDrag);
window.addEventListener('pointercancel', finishDockDrag);
dock.addEventListener('lostpointercapture', finishDockDrag);
// A drag released off the dock produces no synthetic click; clear the flag on the next
// real release so one suppressed click can never swallow a later legitimate one.
window.addEventListener('pointerup', () => { suppressDockClick = false; });

dock.addEventListener('wheel', event => {
  if (isBusy() || event.defaultPrevented || !event.cancelable || event.ctrlKey || event.shiftKey) return;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  const strip = event.target.closest('.dock-thumb-strip');
  if (!strip || !dock.contains(strip)) return;
  const maxScroll = strip.scrollWidth - strip.clientWidth;
  if (maxScroll <= 0) return;

  // 行模式按一个 em、页模式按可视列表宽度换算，横向手势保持浏览器原生行为。
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? parseFloat(getComputedStyle(strip).fontSize)
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : 1;
  const left = Math.max(0, Math.min(maxScroll, strip.scrollLeft + event.deltaY * unit));
  if (Math.abs(left - strip.scrollLeft) < 1) return;

  event.preventDefault();
  strip.scrollTo({ left, behavior: 'instant' });
}, { passive: false });

dock.addEventListener('click', event => {
  if (suppressDockClick && event.detail > 0) {
    suppressDockClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const control = event.target.closest('[data-action]');
  if (!control || control.disabled) return;
  const action = control.dataset.action;
  const arg = control.dataset.arg;
  if (action === 'upload-photo') coupleInput.click();
  else if (action === 'go-room') goToRoom(Number(arg));
  else if (action === 'select-outfit') {
    const outfit = state.outfits.find(item => item.id === arg);
    if (outfit) selectOutfit(outfit);
  } else if (action === 'set-scene-mode') {
    selectSceneMode(arg);
    if (arg === 'upload') sceneInput.click();
  } else if (action === 'select-venue') {
    selectVenue(arg);
  } else if (action === 'generate') {
    requestGeneration(control);
  } else if (action === 'restart') {
    restartSession();
  }
});

/* =========================================================================
   顶部提示条（请柬屏期间暂存，进入画廊后再呈现）
   ========================================================================= */
let pendingAlertMessage = '';

function showAlert(message, room = null) {
  const experienceVisible = !document.querySelector('#experience').hidden;
  if (!experienceVisible) {
    pendingAlertMessage = message;
    return;
  }
  formAlert.textContent = message;
  formAlert.hidden = false;
  // 焦点交给目标展厅标题；role=alert 的提示条无需抢占焦点即可被播报。
  if (room !== null && room !== state.room) goToRoom(room);
  clearTimeout(alertTimer);
  alertTimer = window.setTimeout(hideAlert, 6000);
}

function hideAlert() {
  formAlert.hidden = true;
  formAlert.textContent = '';
  clearTimeout(alertTimer);
}

/* =========================================================================
   生成流程：点击「生成成片」→ 校验 → 生成码弹窗 → authorize → SSE
   ========================================================================= */
function buildSnapshot() {
  if (!state.coupleImage) return invalidInput(0, '请先在「01 合照」上传一张有效的合照。');
  const outfit = currentOutfit();
  if (!outfit) return invalidInput(1, '请先在「02 造型」选择一套婚礼造型。');
  const mode = state.sceneMode;
  if (mode === 'upload' && !state.sceneImage) return invalidInput(2, '请上传一张有效的场地照片，或切换为保留原背景。');
  if (mode === 'venue' && !currentVenue()) return invalidInput(2, '请选择目录中的固定场馆。');
  const scene = mode === 'upload' ? { mode, image: state.sceneImage.base64 }
    : mode === 'venue' ? { mode, venue_id: state.sceneVenueId } : { mode };
  return Object.freeze({
    couple_image: state.coupleImage.base64,
    outfit_id: outfit.id,
    outfit_name: outfit.name,
    scene: Object.freeze(scene),
  });
}

function invalidInput(room, message) {
  const error = new Error(message);
  error.room = room;
  throw error;
}

function requestGeneration(trigger = null) {
  if (isBusy()) return;
  hideAlert();
  try {
    openAccessDialog(buildSnapshot(), trigger);
  } catch (error) {
    showAlert(error.message, error.room);
  }
}

function openAccessDialog(snapshot, trigger = null) {
  // 事件注入的清焦时机不确定：优先沿用真实焦点，退化到触发控件。
  const returnFocus = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : trigger;
  // 先把焦点放到恢复目标上，让原生 dialog 关闭时的焦点归位也落在同一控件。
  returnFocus?.focus();
  accessReturnFocus = returnFocus;
  pendingSnapshot = snapshot;
  tokenInput.value = '';
  document.querySelector('#access-error').hidden = true;
  tokenInput.removeAttribute('aria-invalid');
  setOperation({ kind: 'awaiting-code' });
  accessDialog.showModal();
  tokenInput.focus();
}

// 焦点恢复：原节点若已随 dock 重建脱离文档，则在当前 DOM 中找同义控件。
function restoreFocusTo(node) {
  if (!node) return;
  let target = node;
  if (!target.isConnected && target.dataset?.action) {
    target = [...dock.querySelectorAll('[data-action]')].find(candidate =>
      candidate.dataset.action === node.dataset.action && (candidate.dataset.arg ?? '') === (node.dataset.arg ?? '')) ?? null;
  }
  if (target?.isConnected) target.focus({ preventScroll: true });
}

function closeAccessDialog() {
  if (!['awaiting-code', 'authorization'].includes(state.operation.kind)) return;
  if (state.operation.kind === 'authorization') state.operation.controller.abort();
  setOperation({ kind: 'idle' });
  pendingSnapshot = null;
  tokenInput.value = '';
  if (accessDialog.open) accessDialog.close();
  // 原生 dialog 的关闭焦点归位是异步 fixup，会覆盖显式 focus；
  // 推迟一帧恢复触发控件（dock 可能已重建，按同义控件寻址）。
  const returnFocus = accessReturnFocus;
  accessReturnFocus = null;
  requestAnimationFrame(() => restoreFocusTo(returnFocus));
}

async function authorizeAndGenerate(event) {
  event.preventDefault();
  if (state.operation.kind !== 'awaiting-code') return;
  const token = tokenInput.value.trim();
  const errorBox = document.querySelector('#access-error');
  // 生成码会放进 Authorization 头：非 ASCII 字符（中文、全角符号等）让 fetch 在发出请求前
  // 抛 TypeError，这里按无效生成码处理，不把浏览器原生异常暴露给用户。
  if (!token || !ASCII_TOKEN.test(token)) {
    errorBox.textContent = ERROR_MESSAGES.AUTH_INVALID;
    errorBox.hidden = false;
    tokenInput.setAttribute('aria-invalid', 'true');
    tokenInput.focus();
    return;
  }
  const snapshot = pendingSnapshot;
  if (!snapshot) { closeAccessDialog(); return; }
  const request = { kind: 'authorization', controller: new AbortController() };
  setOperation(request);
  document.querySelector('#cancel-access').focus();
  const timeout = setTimeout(() => request.controller.abort(new Error('生成码核验超时，请重试。')), 10_000);
  try {
    const response = await fetch('/api/tryon/authorize', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store', redirect: 'error', signal: request.controller.signal,
    });
    const body = await parseAPIResponse(response);
    if (!response.ok || body.code !== 0) throw new Error(getAPIError(response, body).text);
    if (!Number.isInteger(body.data?.remaining) || body.data.remaining < 1 || body.data.remaining > 5) throw new Error('生成额度响应无效，请重试。');
    if (state.operation !== request) return;
    if (!snapshot) { closeAccessDialog(); return; }
    tokenInput.value = '';
    pendingSnapshot = null;
    setOperation({ kind: 'idle' });
    accessDialog.close();
    generate(snapshot, token);
  } catch (error) {
    if (state.operation !== request) return;
    setOperation({ kind: 'awaiting-code' });
    // 请求没到达后端（连接失败、请求无法编码、响应不可解析）统一提示服务繁忙；
    // 后端明确返回的错误按已知文案显示，不暴露原生异常。
    errorBox.textContent = request.controller.signal.aborted ? '生成码核验超时，请重试。'
      : isUnreachableError(error) ? SERVER_BUSY_MESSAGE : error.message;
    errorBox.hidden = false;
    tokenInput.setAttribute('aria-invalid', 'true');
    tokenInput.focus();
  } finally { clearTimeout(timeout); }
}

function waitForGeneration(promise, request) {
  const { signal } = request.controller;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function checkGeneration(request) {
  if (performance.now() - request.startedAt >= GENERATION_TIMEOUT_MS) {
    request.timedOut = true;
    request.controller.abort();
  }
  request.controller.signal.throwIfAborted();
  if (state.operation !== request) throw new DOMException('Generation superseded', 'AbortError');
}

function generationErrorMessage(error, request) {
  if (request.timedOut) return '生成超过 90 秒，已停止请求。你可以手动重试。';
  if (request.controller.signal.aborted) return getAPIError({ status: 408 }, { data: { error_code: 'GENERATION_CANCELLED' } }).text;
  if (error?.code === 'STREAM_INTERRUPTED') return '生成连接中断，未收到最终结果。你可以手动重试。';
  if (isUnreachableError(error)) return SERVER_BUSY_MESSAGE;
  return error.message;
}

function updateGenerationStatus(status, request) {
  checkGeneration(request);
  if (!Object.hasOwn(GENERATION_STAGES, status.phase)) throw new Error(`生成事件包含未知阶段：${status.phase}`);
  advanceGenerationStage(GENERATION_STAGES[status.phase], request);
}

function advanceGenerationStage(stage, request) {
  if (stage <= request.stage) return;
  request.stage = stage;
  generationStatus.textContent = GENERATION_STAGE_LABELS[stage];
  document.querySelectorAll('#generation-steps li').forEach((element, index) => {
    if (index === stage) element.setAttribute('aria-current', 'step');
    else element.removeAttribute('aria-current');
  });
}

function updateGenerationClock(request) {
  const seconds = Math.floor((performance.now() - request.startedAt) / 1000);
  generationElapsed.textContent = `已等待 ${seconds} 秒`;
}

async function displayResult(data, snapshot, request) {
  const info = resolveResultImageInfo(data?.image, data?.mime_type);
  if (info.mime !== normalizeImageMime(data?.mime_type)) throw new Error('生成结果的图片格式与声明不一致。');
  const binary = atob(info.b64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  request.pendingURL = URL.createObjectURL(new Blob([bytes], { type: info.mime }));
  advanceGenerationStage(2, request);
  const probe = new Image();
  request.probe = probe;
  // 解码探针沿用结果图 id，保持浏览器测试的 decode 钩子可以精确拦截。
  probe.id = 'result-image';
  probe.src = request.pendingURL;
  try {
    await waitForGeneration(probe.decode(), request);
  } catch (error) {
    if (request.controller.signal.aborted) throw error;
    throw new Error('生成结果图片无法解码，请手动重试。');
  }
  checkGeneration(request);
  if (probe.naturalWidth !== data.width || probe.naturalHeight !== data.height) throw new Error('生成结果图片尺寸与声明不一致。');
  state.resultURL = request.pendingURL;
  request.pendingURL = '';
  state.resultData = data;
  state.resultMime = info.mime;
  state.comparePct = 50;
  probe.style.visibility = 'hidden';
  renderResultRoom(probe);
  // Keep cancellation and the deadline active until the decoded result becomes visible.
  await waitForGeneration(new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), request);
  checkGeneration(request);
  const durationMs = Math.ceil(performance.now() - request.startedAt);
  const providerModel = data.provider_model ? `${data.provider_model}${data.provider_model === data.model ? '（未提供日期快照）' : ''}` : '未提供版本信息（未提供日期快照）';
  state.resultMetaText = `${snapshot.outfit_name} · ${info.mime} · 可查看耗时 ${durationMs} ms · 请求型号 ${data.model} · 供应商型号 ${providerModel} · 请求 ${data.request_id}${data.provider_request_id ? ` · 供应商请求 ${data.provider_request_id}` : ''}`;
  document.querySelector('#result-meta').textContent = state.resultMetaText;
  probe.style.removeProperty('visibility');
}

async function generate(snapshot, token) {
  if (state.operation.kind !== 'idle') return;
  const startedAt = performance.now();
  hideAlert();
  const request = { kind: 'generation', controller: new AbortController(), timedOut: false, timer: 0, clock: 0, startedAt, stage: -1, pendingURL: '', probe: null };
  const returnFocus = accessReturnFocus;
  accessReturnFocus = null;
  setOperation(request);
  advanceGenerationStage(0, request);
  updateGenerationClock(request);
  request.clock = window.setInterval(() => updateGenerationClock(request), 1000);
  cancelButton.focus({ preventScroll: true });
  // Native dialog close fixup may run after this synchronous transition.
  requestAnimationFrame(() => { if (state.operation === request) cancelButton.focus({ preventScroll: true }); });
  clearResult();
  request.timer = window.setTimeout(() => {
    request.timedOut = true;
    request.controller.abort();
  }, Math.max(0, GENERATION_TIMEOUT_MS - (performance.now() - startedAt)));
  try {
    checkGeneration(request);
    const response = await waitForGeneration(fetch('/api/tryon/couple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ couple_image: snapshot.couple_image, outfit_id: snapshot.outfit_id, scene: snapshot.scene }),
      cache: 'no-store', redirect: 'error', signal: request.controller.signal,
    }), request);
    const body = await waitForGeneration((async () => {
      if (!response.ok) return parseAPIResponse(response);
      const terminal = await consumeSSE(response, {
        signal: request.controller.signal,
        onStatus: status => updateGenerationStatus(status, request),
      });
      if (terminal.type === 'error') {
        const failure = new Error(getAPIError({ status: terminal.payload.data.http_status }, terminal.payload).text);
        failure.code = terminal.payload.data.error_code;
        throw failure;
      }
      return terminal.payload;
    })(), request);
    if (!response.ok || body.code !== 0) throw new Error(getAPIError(response, body).text);
    checkGeneration(request);
    await displayResult(body.data, snapshot, request);
    if (state.operation !== request) return;
    // 先解除生成态（隐藏遮罩、解锁导航），再进入成片展厅。
    setOperation({ kind: 'idle' });
    goToRoom(3);
    renderDock();
    syncAmbient();
  } catch (error) {
    if (state.operation !== request) return;
    clearResult();
    const message = generationErrorMessage(error, request);
    if (!request.controller.signal.aborted) request.controller.abort(error);
    showAlert(message);
    const resultStatus = document.querySelector('#result-status');
    if (resultStatus) resultStatus.textContent = message;
  } finally {
    window.clearTimeout(request.timer);
    window.clearInterval(request.clock);
    if (request.pendingURL) URL.revokeObjectURL(request.pendingURL);
    if (request.probe && !request.probe.isConnected) request.probe.removeAttribute('src');
    if (state.operation === request) {
      setOperation({ kind: 'idle' });
      restoreFocusTo(returnFocus);
    }
  }
}

function restartSession() {
  if (isBusy()) return;
  state.selectionVersion++;
  state.coupleImage = null;
  releasePhotoURL();
  releaseSceneURL();
  clearScene();
  state.sceneMode = 'original';
  state.outfitId = '';
  state.sceneVenueId = '';
  state.outfitPreviewVersion++;
  state.scenePreviewVersion++;
  state.outfitHero.key = '';
  state.sceneHero.key = '';
  cancelDissolve(outfitCanvas);
  cancelDissolve(sceneCanvas);
  for (const layer of outfitLayers) layer.replaceChildren();
  clearResult();
  renderPhotoRoom();
  refreshSceneHero(false);
  syncAmbient();
  goToRoom(0);
}

/* =========================================================================
   对比滑块（pointer + 键盘）
   ========================================================================= */
function updateCompare(pct) {
  state.comparePct = Math.max(4, Math.min(96, pct));
  const after = document.querySelector('#reveal-after-layer');
  const divider = document.querySelector('#reveal-divider');
  const stage = document.querySelector('#reveal-compare-stage');
  if (after) after.style.clipPath = `inset(0 ${100 - state.comparePct}% 0 0)`;
  if (divider) divider.style.left = `${state.comparePct}%`;
  if (stage) stage.setAttribute('aria-valuenow', String(Math.round(state.comparePct)));
}

window.addEventListener('pointermove', event => {
  if (!draggingCompare) return;
  const stage = document.querySelector('#reveal-compare-stage');
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const clientX = event.touches ? event.touches[0].clientX : event.clientX;
  updateCompare(((clientX - rect.left) / rect.width) * 100);
});
window.addEventListener('pointerup', () => { draggingCompare = false; });
window.addEventListener('touchmove', event => {
  if (!draggingCompare) return;
  const stage = document.querySelector('#reveal-compare-stage');
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  updateCompare(((event.touches[0].clientX - rect.left) / rect.width) * 100);
}, { passive: true });
window.addEventListener('touchend', () => { draggingCompare = false; });

resultSlot.addEventListener('pointerdown', event => {
  const stage = event.target.closest('#reveal-compare-stage');
  if (!stage) return;
  draggingCompare = true;
  const rect = stage.getBoundingClientRect();
  updateCompare(((event.clientX - rect.left) / rect.width) * 100);
});

resultSlot.addEventListener('keydown', event => {
  const stage = event.target.closest('#reveal-compare-stage');
  if (!stage) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); updateCompare(state.comparePct - 3); }
  if (event.key === 'ArrowRight') { event.preventDefault(); updateCompare(state.comparePct + 3); }
});

/* =========================================================================
   方向键切换（02 造型 / 03 场景）
   ========================================================================= */
window.addEventListener('keydown', event => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  if (isBusy() || accessDialog.open || document.querySelector('dialog[open]')) return;
  if (state.room !== 1 && state.room !== 2) return;
  // Only dock controls and room headings own the arrow keys here; text fields keep native caret moves.
  const target = event.target;
  if (target instanceof Element && (target.closest('input, textarea, select') || target.closest('[contenteditable]'))) return;
  const items = state.room === 1
    ? orderedOutfits().map(item => item.id)
    : state.venues.length ? ['original', 'upload', ...state.venues.map(v => v.id)] : ['original', 'upload'];
  const activeId = state.room === 1 ? state.outfitId : (state.sceneMode === 'venue' ? state.sceneVenueId : state.sceneMode);
  const index = items.indexOf(activeId);
  const next = items[index < 0 ? (event.key === 'ArrowRight' ? 0 : items.length - 1) : index + (event.key === 'ArrowRight' ? 1 : -1)];
  if (next === undefined) return;
  event.preventDefault();
  if (state.room === 1) {
    const outfit = state.outfits.find(item => item.id === next);
    if (outfit) selectOutfit(outfit);
  } else if (next === 'original' || next === 'upload') {
    selectSceneMode(next);
  } else {
    selectVenue(next);
  }
  // 键盘切换后重建 dock，并把焦点交给新的选中卡片。
  if (state.room === 1) renderDock();
  dock.querySelector('.dock-thumb-btn.is-active')?.focus({ preventScroll: true });
});

/* =========================================================================
   文件选择 / 拖放 / 其余交互
   ========================================================================= */
coupleInput.addEventListener('change', () => selectPhoto(coupleInput.files?.[0]).finally(() => { coupleInput.value = ''; }));
sceneInput.addEventListener('change', () => selectScene(sceneInput.files?.[0]).finally(() => { sceneInput.value = ''; }));

photoFrame.addEventListener('click', event => {
  if (isBusy()) return;
  if (event.target.closest('[data-action="upload-photo"]') || event.target === photoFrame) coupleInput.click();
});
photoFrame.addEventListener('dragover', event => event.preventDefault());
photoFrame.addEventListener('dragleave', event => event.preventDefault());
photoFrame.addEventListener('drop', event => {
  event.preventDefault();
  if (isBusy()) return;
  const file = event.dataTransfer?.files?.[0];
  if (file) selectPhoto(file);
});

sceneLayers[0].parentElement.addEventListener('click', event => {
  if (isBusy()) return;
  if (state.sceneMode === 'upload' && !state.sceneURL) sceneInput.click();
});
sceneLayers[0].parentElement.addEventListener('dragover', event => event.preventDefault());
sceneLayers[0].parentElement.addEventListener('drop', event => {
  event.preventDefault();
  if (isBusy()) return;
  const file = event.dataTransfer?.files?.[0];
  if (file) selectScene(file);
});

document.querySelector('#gallery-wordmark').addEventListener('click', () => goToRoom(0));
cancelButton.addEventListener('click', () => {
  if (state.operation.kind === 'generation') state.operation.controller.abort();
});
apertureOverlay.addEventListener('keydown', event => {
  if (event.key === 'Tab') { event.preventDefault(); cancelButton.focus(); }
});
document.addEventListener('focusin', () => {
  if (state.operation.kind === 'generation' && document.activeElement !== cancelButton) cancelButton.focus({ preventScroll: true });
});

accessForm.addEventListener('submit', authorizeAndGenerate);
tokenInput.addEventListener('input', () => {
  tokenInput.removeAttribute('aria-invalid');
  document.querySelector('#access-error').hidden = true;
});
accessDialog.addEventListener('close', () => { if (!accessDialog.open) closeAccessDialog(); });
accessDialog.addEventListener('cancel', event => { event.preventDefault(); closeAccessDialog(); });
document.querySelector('#cancel-access').addEventListener('click', closeAccessDialog);

accessDialog.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const controls = [...accessDialog.querySelectorAll('button:not(:disabled), input:not(:disabled), [href]')].filter(element => element.getClientRects().length);
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
// 请柬开启编排：火漆裂纹 → 掀盖露衬里 → 信纸升起放大 → 交叉过渡进画廊。
let invitationOpenTimers = [];
let invitationOpening = false;

function stopInvitationSound() {
  invitationSound.pause();
  invitationSound.currentTime = 0;
}

invitationSound.addEventListener('error', () => {
  console.error('请柬音效加载失败', invitationSound.error?.code);
});

function clearInvitationOpenTimers() {
  for (const timerId of invitationOpenTimers) window.clearTimeout(timerId);
  invitationOpenTimers = [];
}

function finishInvitationOpening() {
  if (!invitationOpening) return;
  invitationOpening = false;
  clearInvitationOpenTimers();
  const experience = document.querySelector('#experience');
  invitationScreen.classList.add('is-fading');
  experience.hidden = false;
  experience.classList.add('is-revealing');
  goToRoom(0);
  if (pendingAlertMessage) {
    showAlert(pendingAlertMessage);
    pendingAlertMessage = '';
  }
  invitationOpenTimers.push(window.setTimeout(() => {
    invitationScreen.hidden = true;
    invitationScreen.classList.remove('is-opening', 'is-cracked', 'is-fading');
    experience.classList.remove('is-revealing');
  }, prefersReducedMotion() ? 0 : 420));
}

openInvitationButton.addEventListener('click', () => {
  openInvitationButton.disabled = true;
  // 在用户手势内播放；正常开启保留完整尾音，主动跳过时停止。
  invitationSound.play().catch(error => {
    if (error.name === 'AbortError' && invitationSound.paused) return;
    console.error('请柬音效播放失败', error);
  });
  invitationOpening = true;
  invitationScreen.classList.add('is-cracked');
  // 花瓣从火漆位置迸出飘落，余韵延续到画廊首屏；减少动态时模块内部直接跳过。
  const sealRect = openInvitationButton.getBoundingClientRect();
  petalBurst({ canvas: petalCanvas, origin: { x: sealRect.left + sealRect.width / 2, y: sealRect.top + sealRect.height / 2 } });
  if (prefersReducedMotion()) {
    finishInvitationOpening();
    return;
  }
  invitationOpenTimers.push(window.setTimeout(() => invitationScreen.classList.add('is-opening'), 140));
  invitationOpenTimers.push(window.setTimeout(finishInvitationOpening, 980));
});

// 动画期间在请柬页任意点击或按 Esc 可直接进入（BKE Studio 式跳过）。
function skipInvitationOpening() {
  if (!invitationOpening) return;
  stopInvitationSound();
  finishInvitationOpening();
}

invitationScreen.addEventListener('pointerdown', () => {
  skipInvitationOpening();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') skipInvitationOpening();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopInvitationSound();
});

// 同源图片加载失败时移除元素，露出渐变兜底；委托捕获避免 CSP 内联事件处理器。
document.addEventListener('error', event => {
  const img = event.target;
  if (img instanceof HTMLImageElement && img.matches('.hero-photo, .hero-empty img, .result-empty img')) {
    img.remove();
  }
}, true);

window.addEventListener('pagehide', () => {
  stopInvitationSound();
  releasePhotoURL();
  clearScene();
  releaseResultURL();
  if (state.operation.kind === 'generation') state.operation.controller.abort();
});

/* =========================================================================
   目录加载与初始渲染
   ========================================================================= */
function hasOnlyDirectoryFields(entry) {
  return entry && typeof entry.id === 'string' && typeof entry.name === 'string'
    && Object.keys(entry).length === 2 && Object.hasOwn(entry, 'id') && Object.hasOwn(entry, 'name');
}

async function loadOutfits() {
  if (isBusy()) return;
  const request = { kind: 'catalog' };
  setOperation(request);
  try {
    const response = await fetch('/api/catalog/outfits', {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    const body = await parseAPIResponse(response);
    if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.outfits)) throw new Error(getAPIError(response, body).text);
    if (!Number.isInteger(body.data.version) || !Array.isArray(body.data.venues)
      || !body.data.outfits.every(hasOnlyDirectoryFields) || !body.data.venues.every(hasOnlyDirectoryFields)) {
      throw new Error('造型目录格式无效');
    }
    state.outfits = body.data.outfits;
    state.venues = body.data.venues;
  } catch (error) {
    state.outfits = [];
    state.venues = [];
    showAlert(`套装目录读取失败：${error.message}`);
  } finally {
    if (state.operation === request) setOperation({ kind: 'idle' });
  }
}

let outfitPreviewsRequest = null;

function loadOutfitPreviews() {
  // Single in-flight request: a stale failure must never discard a newer success.
  outfitPreviewsRequest ??= fetchOutfitPreviews().finally(() => { outfitPreviewsRequest = null; });
  return outfitPreviewsRequest;
}

async function fetchOutfitPreviews() {
  const status = document.querySelector('#outfit-preview-status');
  try {
    const response = await fetch('/web/public/manifest.json', {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    const previews = manifest.outfitPreviews;
    const venuePreviews = manifest.venuePreviews;
    if (manifest.version !== 1 || !Array.isArray(previews) || previews.length !== 30
      || new Set(previews.map(item => item.id)).size !== 30
      || !previews.every(item => OUTFIT_ID_PATTERN.test(item.id)
        && item.display?.file === `outfits/${item.id}.webp`
        && item.thumbnail?.file === `outfits/${item.id}-thumb.webp`
        && Array.isArray(item.focus) && item.focus.length === 2
        && item.focus.every(value => Number.isFinite(value) && value >= 0 && value <= 1))
      || !Array.isArray(venuePreviews) || venuePreviews.length !== EXPECTED_VENUE_PREVIEWS
      || new Set(venuePreviews.map(item => item.id)).size !== EXPECTED_VENUE_PREVIEWS
      || !venuePreviews.every(item => VENUE_ID_PATTERN.test(item.id)
        && item.display?.file === `venues/${item.id}.webp`
        && item.thumbnail?.file === `venues/${item.id}-thumb.webp`
        && Array.isArray(item.focus) && item.focus.length === 2
        && item.focus.every(value => Number.isFinite(value) && value >= 0 && value <= 1))) {
      throw new Error('展示素材清单格式无效');
    }
    state.outfitPreviews = new Map(previews.map(item => [item.id, item]));
    state.venuePreviews = new Map(venuePreviews.map(item => [item.id, item]));
    state.outfitPreviewsError = '';
    // 清单内容可能已更新：重新解析当前选择，避免同键短路保留旧图或旧错误。
    state.outfitHero.key = '';
    state.sceneHero.key = '';
    if (state.room === 1) refreshOutfitHero(false);
    if (state.room === 2) { refreshSceneHero(false); renderDock(); }
  } catch (error) {
    state.outfitPreviews = new Map();
    state.venuePreviews = new Map();
    // 清单失败原因跟随加载流程进入提示层；重试时由新的成功或失败覆盖。
    state.outfitPreviewsError = `造型示例清单读取失败：${error.message}`;
    status.textContent = state.outfitPreviewsError;
    if (state.room === 2 && state.sceneMode === 'venue') {
      state.sceneHero.key = '';
      refreshSceneHero(false);
    }
    showAlert(state.outfitPreviewsError);
  }
}

setOperation(state.operation);
renderPhotoRoom();
refreshSceneHero(false);
renderResultRoom();
await checkHealth();
// Decorative outfit previews must not delay the interactive dock; redraw it when they arrive.
await loadOutfits();
renderDock();
loadOutfitPreviews().then(() => { if (state.room === 1 || state.room === 2) renderDock(); });
syncAmbient();

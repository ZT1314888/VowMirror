import { getAPIError, parseAPIResponse } from './response-core.mjs';
import { imageExtensionForMime, normalizeImageMime, readImageFile, resolveResultImageInfo } from './image-core.mjs';
import { consumeSSE } from './sse-core.mjs';
import { cancelDissolve, dissolveTransition } from './particle-core.mjs';
import { petalBurst } from './petal-core.mjs';

const GENERATION_TIMEOUT_MS = 90_000;
const GENERATION_PHASE_LABELS = Object.freeze({
  reading_input: '已读取请求',
  validating_request: '请求校验完成',
  validating_images: '正在校验图片',
  preparing_assets: '正在准备参考素材',
  assembling_request: '正在组装模型请求',
  connection_acquisition: '正在连接上游',
  waiting_upstream_response: '等待上游响应',
  connection_acquired: '上游连接已建立',
  dns_lookup: '正在解析上游地址',
  tcp_connect: '正在建立上游连接',
  tls_handshake: '正在协商加密连接',
  request_upload: '正在上传参考素材',
  first_response_byte: '已收到上游首字节',
  provider_response_headers: '已收到上游响应头',
  reading_provider_response: '正在读取上游响应',
  validating_provider_result: '正在校验上游结果',
  validating_result: '正在校验结果图片',
  upstream_request_failed: '上游请求失败',
});
const SAMPLE_PHOTO_URL = '/web/public/wedding-example.jpg';
const AMBIENT_DEFAULT_URL = '/web/public/florals.jpg';
const ROOM_TITLES = ['room-photo-title', 'room-outfit-title', 'room-scene-title', 'room-result-title'];
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
const sceneCanvas = document.querySelector('#scene-particle-canvas');
const resultSlot = document.querySelector('#result-slot');
const apertureOverlay = document.querySelector('#aperture-overlay');
const generationStatus = document.querySelector('#generation-status');
const cancelButton = document.querySelector('#cancel-generation');
const tokenInput = document.querySelector('#access-token');
const accessDialog = document.querySelector('#access-dialog');
const accessForm = document.querySelector('#access-form');
const healthStatus = document.querySelector('#health-status');
const invitationScreen = document.querySelector('#invitation-screen');
const openInvitationButton = document.querySelector('#open-invitation');
const petalCanvas = document.querySelector('#petal-canvas');

const state = {
  room: 0,
  coupleImage: null,
  photoURL: '',
  outfits: [],
  outfitId: '',
  sceneMode: 'original',
  sceneImage: null,
  sceneURL: '',
  sceneVenueId: '',
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
  if (generating) generationStatus.textContent = '正在生成婚礼合影…';
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

function goToRoom(index) {
  if (index < 0 || index > 3 || isBusy()) return;
  state.room = index;
  track.style.transform = `${TRACK_EASE}(-${index * 100}vw, 0, 0)`;
  renderStepper();
  renderDock();
  syncAmbient();
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
   ========================================================================= */
function heroMarkup({ src, pip = '' }) {
  return `
    <img class="hero-photo" src="${escapeHTML(src)}" alt="">
    <div class="hero-shade" aria-hidden="true"></div>
    ${pip}
  `;
}

function pipMarkup(src) {
  if (!src) return '';
  return `<div class="hero-pip" aria-hidden="true"><img src="${escapeHTML(src)}" alt=""></div>`;
}

function coupleHeroSrc() {
  return state.photoURL || SAMPLE_PHOTO_URL;
}

// 双缓冲切换：粒子溶解可用则旧图溶解为新图，否则退回纯交叉淡入。
function transitionHero(layers, canvas, markup) {
  const incoming = bufferToggle[canvas === outfitCanvas ? 'outfit' : 'scene'] ? layers[0] : layers[1];
  const outgoing = bufferToggle[canvas === outfitCanvas ? 'outfit' : 'scene'] ? layers[1] : layers[0];
  cancelDissolve(canvas);

  const showIncoming = () => {
    incoming.style.transition = 'none';
    incoming.style.opacity = '0';
    incoming.style.transform = 'scale(1.045)';
    incoming.innerHTML = markup;
    void incoming.offsetWidth;
    incoming.style.transition = '';
    incoming.style.opacity = '1';
    incoming.style.transform = 'scale(1)';
    outgoing.style.opacity = '0';
    outgoing.style.transform = 'scale(.97)';
    incoming.classList.add('is-front');
    outgoing.classList.remove('is-front');
  };

  if (prefersReducedMotion()) {
    showIncoming();
    outgoing.innerHTML = '';
  } else {
    const source = outgoing.querySelector('img');
    const dissolved = dissolveTransition({
      canvas,
      source,
      onReady: () => {
        // 首帧粒子已呈现旧图，本体退场让位给溶解粒子。
        outgoing.style.transition = 'opacity 140ms linear, transform 500ms var(--ease-apple)';
        outgoing.style.opacity = '0';
        showIncoming();
        setTimeout(() => { if (outgoing.style.opacity === '0') outgoing.innerHTML = ''; }, 160);
      },
    });
    if (!dissolved) {
      showIncoming();
      outgoing.innerHTML = '';
    }
  }
  bufferToggle[canvas === outfitCanvas ? 'outfit' : 'scene'] = !bufferToggle[canvas === outfitCanvas ? 'outfit' : 'scene'];
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
    refreshOutfitHero(false);
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

function refreshOutfitHero(animate) {
  const markup = heroMarkup({ src: coupleHeroSrc() });
  if (animate) transitionHero(outfitLayers, outfitCanvas, markup);
  else {
    outfitLayers[1].innerHTML = markup;
    outfitLayers[1].style.opacity = '1';
    outfitLayers[1].style.transform = 'scale(1)';
    outfitLayers[1].classList.add('is-front');
    outfitLayers[0].innerHTML = '';
    outfitLayers[0].style.opacity = '0';
    outfitLayers[0].classList.remove('is-front');
    bufferToggle.outfit = true;
  }
}

function selectOutfit(outfit, animate = true) {
  state.outfitId = outfit.id;
  clearResult();
  refreshOutfitHero(animate);
  syncAmbient();
  renderDock();
}

/* =========================================================================
   Room 2 · 场景（保留原背景 / 上传场地照片 / 固定场馆仅当目录提供）
   ========================================================================= */
function currentVenue() {
  return state.venues.find(item => item.id === state.sceneVenueId) || null;
}

function refreshSceneHero(animate) {
  let markup;
  if (state.sceneMode === 'upload' && state.sceneURL) {
    markup = heroMarkup({ src: state.sceneURL, pip: pipMarkup(state.photoURL || '') });
  } else if (state.sceneMode === 'venue' && currentVenue()) {
    markup = heroMarkup({ src: coupleHeroSrc() });
  } else {
    markup = heroMarkup({ src: coupleHeroSrc(), pip: state.sceneMode === 'upload' ? pipMarkup(state.photoURL || '') : '' });
  }
  if (animate) transitionHero(sceneLayers, sceneCanvas, markup);
  else {
    sceneLayers[1].innerHTML = markup;
    sceneLayers[1].style.opacity = '1';
    sceneLayers[1].style.transform = 'scale(1)';
    sceneLayers[1].classList.add('is-front');
    sceneLayers[0].innerHTML = '';
    sceneLayers[0].style.opacity = '0';
    sceneLayers[0].classList.remove('is-front');
    bufferToggle.scene = true;
  }
}

function selectSceneMode(mode) {
  state.sceneMode = mode;
  clearResult();
  // 模式切换使进行中的场景图解码失效，迟到的选择不能覆盖新模式。
  state.sceneVersion++;
  if (mode !== 'upload') {
    releaseSceneURL();
    state.sceneImage = null;
    sceneInput.value = '';
  }
  refreshSceneHero(true);
  syncAmbient();
  renderDock();
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
    refreshSceneHero(true);
    syncAmbient();
    renderDock();
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

function renderResultRoom() {
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
      <div class="hero-shade" aria-hidden="true"></div>
      <h3 class="result-caption">${escapeHTML(outfit ? `${outfit.name} · ${sceneTitle()}` : '婚礼合影')}</h3>
      <div class="compare-divider" id="reveal-divider">
        <div class="compare-handle" aria-hidden="true"><svg class="icon"><use href="#icon-compare"/></svg></div>
      </div>
      <details class="result-details"><summary>生成详情</summary><p id="result-meta" class="result-meta"></p></details>
    </div>`;
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

function renderDock() {
  // 重建 dock 后把焦点还给同义控件，键盘选择不会跌回 body。
  const previousFocus = dock.contains(document.activeElement) ? document.activeElement : null;
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
      inner: `<span class="name-tile">${escapeHTML(outfit.name)}</span>`,
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
      inner: `<span class="name-tile">${escapeHTML(venue.name)}</span>`,
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
  if (previousFocus?.dataset?.action) {
    const replacement = [...dock.querySelectorAll('[data-action]')].find(node =>
      node.dataset.action === previousFocus.dataset.action && (node.dataset.arg ?? '') === (previousFocus.dataset.arg ?? ''));
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
  }
  requestAnimationFrame(() => {
    dock.querySelector('.dock-thumb-btn.is-active')?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  });
}

dock.addEventListener('click', event => {
  const control = event.target.closest('[data-action]');
  if (!control || control.disabled) return;
  const action = control.dataset.action;
  const arg = control.dataset.arg;
  if (action === 'upload-photo') coupleInput.click();
  else if (action === 'go-room') goToRoom(Number(arg));
  else if (action === 'select-outfit') {
    const outfit = state.outfits.find(item => item.id === arg);
    if (outfit) selectOutfit(outfit, true);
  } else if (action === 'set-scene-mode') {
    selectSceneMode(arg);
    if (arg === 'upload') sceneInput.click();
  } else if (action === 'select-venue') {
    state.sceneMode = 'venue';
    state.sceneVenueId = arg;
    clearResult();
    refreshSceneHero(true);
    syncAmbient();
    renderDock();
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
  if (!token) {
    errorBox.textContent = '请输入生成码后再继续。';
    errorBox.hidden = false;
    tokenInput.setAttribute('aria-invalid', 'true');
    tokenInput.focus();
    return;
  }
  const snapshot = pendingSnapshot;
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
    if (state.operation !== request) return;
    if (!response.ok || body.code !== 0) throw new Error(getAPIError(response, body).text);
    if (!Number.isInteger(body.data?.remaining) || body.data.remaining < 1 || body.data.remaining > 5) throw new Error('生成额度响应无效，请重试。');
    tokenInput.value = '';
    pendingSnapshot = null;
    setOperation({ kind: 'idle' });
    accessDialog.close();
    generate(snapshot, token);
  } catch (error) {
    if (state.operation !== request) return;
    setOperation({ kind: 'awaiting-code' });
    errorBox.textContent = request.controller.signal.aborted ? '生成码核验超时，请重试。' : error.message;
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
  return error.message;
}

function updateGenerationStatus(status, request) {
  checkGeneration(request);
  const label = status.phase === 'connection_acquired'
    ? status.connection_reused ? '复用上游连接' : '已建立新的上游连接'
    : GENERATION_PHASE_LABELS[status.phase];
  if (!label) throw new Error(`生成事件包含未知阶段：${status.phase}`);
  if (request.lastPhase !== status.phase) {
    generationStatus.textContent = label;
    request.lastPhase = status.phase;
  }
}

async function displayResult(data, snapshot, request) {
  const info = resolveResultImageInfo(data?.image, data?.mime_type);
  if (info.mime !== normalizeImageMime(data?.mime_type)) throw new Error('生成结果的图片格式与声明不一致。');
  const binary = atob(info.b64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  releaseResultURL();
  state.resultURL = URL.createObjectURL(new Blob([bytes], { type: info.mime }));
  generationStatus.textContent = '正在解码生成图片…';
  const probe = new Image();
  // 解码探针沿用结果图 id，保持浏览器测试的 decode 钩子可以精确拦截。
  probe.id = 'result-image';
  probe.src = state.resultURL;
  try {
    await waitForGeneration(probe.decode(), request);
  } catch (error) {
    if (request.controller.signal.aborted) throw error;
    throw new Error('生成结果图片无法解码，请手动重试。');
  }
  checkGeneration(request);
  if (probe.naturalWidth !== data.width || probe.naturalHeight !== data.height) throw new Error('生成结果图片尺寸与声明不一致。');
  // Let the decoded image reach a rendered frame before stopping the clock.
  await waitForGeneration(new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), request);
  checkGeneration(request);
  const durationMs = Math.ceil(performance.now() - request.startedAt);
  state.resultData = data;
  state.resultMime = info.mime;
  state.comparePct = 50;
  const providerModel = data.provider_model ? `${data.provider_model}${data.provider_model === data.model ? '（未提供日期快照）' : ''}` : '未提供版本信息（未提供日期快照）';
  state.resultMetaText = `${snapshot.outfit_name} · ${info.mime} · 可查看耗时 ${durationMs} ms · 请求型号 ${data.model} · 供应商型号 ${providerModel} · 请求 ${data.request_id}${data.provider_request_id ? ` · 供应商请求 ${data.provider_request_id}` : ''}`;
}

async function generate(snapshot, token) {
  if (state.operation.kind !== 'idle') return;
  const startedAt = performance.now();
  hideAlert();
  const request = { kind: 'generation', controller: new AbortController(), timedOut: false, timer: 0, startedAt, lastPhase: '' };
  setOperation(request);
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
    renderResultRoom();
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
    if (state.operation === request) setOperation({ kind: 'idle' });
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
  clearResult();
  renderPhotoRoom();
  refreshOutfitHero(false);
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
  const items = state.room === 1
    ? orderedOutfits()
    : state.venues.length ? [{ id: 'original' }, { id: 'upload' }, ...state.venues.map(v => ({ id: v.id }))] : [{ id: 'original' }, { id: 'upload' }];
  const activeId = state.room === 1 ? state.outfitId : (state.sceneMode === 'venue' ? state.sceneVenueId : state.sceneMode);
  const index = items.findIndex(item => item.id === activeId);
  if (index < 0) return;
  const next = items[index + (event.key === 'ArrowRight' ? 1 : -1)];
  if (!next) return;
  if (state.room === 1) {
    const outfit = state.outfits.find(item => item.id === next.id);
    if (outfit) selectOutfit(outfit, true);
  } else if (next.id === 'original' || next.id === 'upload') {
    selectSceneMode(next.id);
  } else {
    state.sceneMode = 'venue';
    state.sceneVenueId = next.id;
    clearResult();
    refreshSceneHero(true);
    syncAmbient();
    renderDock();
  }
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
invitationScreen.addEventListener('pointerdown', () => {
  if (invitationOpening) finishInvitationOpening();
});
document.addEventListener('keydown', event => {
  if (invitationOpening && event.key === 'Escape') finishInvitationOpening();
});

// 同源图片加载失败时移除元素，露出渐变兜底；委托捕获避免 CSP 内联事件处理器。
document.addEventListener('error', event => {
  const img = event.target;
  if (img instanceof HTMLImageElement && img.matches('.hero-photo, .hero-empty img, .result-empty img, .hero-pip img')) {
    img.remove();
  }
}, true);

window.addEventListener('pagehide', () => {
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

setOperation(state.operation);
renderPhotoRoom();
refreshOutfitHero(false);
refreshSceneHero(false);
renderResultRoom();
await checkHealth();
await loadOutfits();
renderDock();
syncAmbient();

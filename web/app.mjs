import { getAPIError, parseAPIResponse } from './response-core.mjs';
import { imageExtensionForMime, normalizeImageMime, readImageFile, resolveResultImageInfo } from './image-core.mjs';
import { consumeSSE } from './sse-core.mjs';

const TOKEN_KEY = 'vowmirror-access-token';
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
const GENERATION_OUTCOME_LABELS = Object.freeze({ timeout: '已超时', cancelled: '已取消', failed: '生成失败' });
const form = document.querySelector('#generation-form');
const imageInput = document.querySelector('#couple-image');
const photoPreview = document.querySelector('#photo-preview');
const photoPreviewWrap = document.querySelector('#photo-preview-wrap');
const photoError = document.querySelector('#photo-error');
const tokenInput = document.querySelector('#access-token');
const saveToken = document.querySelector('#save-token');
const outfitSelect = document.querySelector('#outfit');
const catalogStatus = document.querySelector('#catalog-status');
const generateButton = document.querySelector('#generate');
const cancelButton = document.querySelector('#cancel-generation');
const formError = document.querySelector('#form-error');
const resultEmpty = document.querySelector('#result-empty');
const resultStatus = document.querySelector('#generation-status');
const resultState = document.querySelector('#result-state');
const resultWrap = document.querySelector('#result-image-wrap');
const resultImage = document.querySelector('#result-image');
const resultMeta = document.querySelector('#result-meta');
const downloadLink = document.querySelector('#download-result');
const sidePreview = document.querySelector('#side-preview');
const clearPhotoButton = document.querySelector('#clear-photo');
const loadOutfitsButton = document.querySelector('#load-outfits');
const sideInputs = form.querySelectorAll('input[name="dress-side"]');
const sceneInputs = form.querySelectorAll('input[name="scene-mode"]');
const sceneInput = document.querySelector('#scene-image');
const scenePreview = document.querySelector('#scene-image-preview');
const scenePreviewWrap = document.querySelector('#scene-image-preview-wrap');
const sceneError = document.querySelector('#scene-error');
const clearSceneButton = document.querySelector('#clear-scene');
const venueSelect = document.querySelector('#venue');
const sceneNote = document.querySelector('#scene-preview');
const SCENE_UPLOAD_NOTE = '仅参考场地的建筑、舞台和装饰；人物与服装仍使用合照和套装参考。';

let coupleImage = null;
let photoURL = '';
let resultURL = '';
let operation = { kind: 'idle' };
let selectionVersion = 0;
let outfits = [];
let sceneImage = null;
let sceneURL = '';
let sceneVersion = 0;
let venues = [];

tokenInput.value = localStorage.getItem(TOKEN_KEY) ?? '';
saveToken.checked = Boolean(tokenInput.value);

function setOperation(next) {
  operation = next;
  const generating = operation.kind === 'generation';
  const busy = operation.kind !== 'idle';
  imageInput.disabled = generating;
  clearPhotoButton.disabled = generating;
  sideInputs.forEach(input => { input.disabled = generating; });
  sceneInputs.forEach(input => { input.disabled = generating; });
  sceneInput.disabled = generating;
  clearSceneButton.disabled = generating;
  venueSelect.disabled = generating;
  loadOutfitsButton.disabled = busy;
  outfitSelect.disabled = busy || outfits.length === 0;
  tokenInput.disabled = busy;
  saveToken.disabled = busy;
  generateButton.disabled = busy;
  cancelButton.hidden = !generating;
}

function setHealth(state, text) {
  const status = document.querySelector('#health-status');
  status.textContent = text;
  status.parentElement.dataset.state = state;
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

function releasePhotoURL() {
  if (photoURL) URL.revokeObjectURL(photoURL);
  photoURL = '';
}

function releaseResultURL() {
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultURL = '';
}

function clearScene() {
  sceneVersion++;
  sceneImage = null;
  sceneInput.value = '';
  if (sceneURL) URL.revokeObjectURL(sceneURL);
  sceneURL = '';
  scenePreview.removeAttribute('src');
  scenePreviewWrap.hidden = true;
  sceneError.hidden = true;
  sceneInput.removeAttribute('aria-invalid');
}

async function selectScene(file) {
  if (operation.kind === 'generation') return;
  clearScene();
  clearResult();
  const version = sceneVersion;
  if (!file) return;
  sceneNote.textContent = '正在读取场地照片…';
  try {
    const image = await readImageFile(file);
    if (version !== sceneVersion) return;
    sceneImage = image;
    sceneURL = URL.createObjectURL(new Blob([image.bytes], { type: image.mime }));
    scenePreview.src = sceneURL;
    scenePreviewWrap.hidden = false;
  } catch (error) {
    if (version !== sceneVersion) return;
    sceneError.textContent = error.message;
    sceneError.hidden = false;
    sceneInput.setAttribute('aria-invalid', 'true');
  } finally {
    if (version === sceneVersion) sceneNote.textContent = SCENE_UPLOAD_NOTE;
  }
}

function clearResult() {
  releaseResultURL();
  resultImage.removeAttribute('src');
  downloadLink.removeAttribute('href');
  downloadLink.removeAttribute('download');
  resultMeta.textContent = '';
  resultWrap.hidden = true;
  resultEmpty.hidden = false;
  resultStatus.hidden = true;
  resultState.textContent = '等待生成';
}

function showFormError(message, focus = true) {
  formError.textContent = message;
  formError.hidden = false;
  if (focus) formError.focus();
}

function clearFormError() {
  formError.hidden = true;
  formError.textContent = '';
}

function persistToken() {
  if (saveToken.checked && tokenInput.value) localStorage.setItem(TOKEN_KEY, tokenInput.value);
  else localStorage.removeItem(TOKEN_KEY);
}

async function loadOutfits() {
  if (operation.kind !== 'idle') return;
  const token = tokenInput.value.trim();
  if (!token) {
    catalogStatus.textContent = '请输入后端访问 Token。';
    tokenInput.focus();
    return;
  }
  const request = { kind: 'catalog' };
  if (form.querySelector('input[name="scene-mode"]:checked').value === 'venue') {
    form.querySelector('input[name="scene-mode"][value="original"]').click();
  }
  venues = [];
  document.querySelector('#venue-mode-option').hidden = true;
  setOperation(request);
  catalogStatus.textContent = '正在读取套装目录…';
  try {
    const response = await fetch('/api/catalog/outfits', {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    const body = await parseAPIResponse(response);
    if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.outfits)) throw new Error(getAPIError(response, body).text);
    outfits = body.data.outfits;
    venues = body.data.venues;
    if (!Array.isArray(venues)) throw new Error('场馆目录格式无效');
    venueSelect.replaceChildren(new Option('选择场馆', ''));
    for (const venue of venues) venueSelect.add(new Option(venue.name, venue.id));
    document.querySelector('#venue-mode-option').hidden = venues.length === 0;
    outfitSelect.replaceChildren(new Option('选择一套婚礼造型', ''));
    for (const outfit of outfits) outfitSelect.add(new Option(outfit.name, outfit.id));
    catalogStatus.textContent = `已读取 ${outfits.length} 套可用造型。`;
  } catch (error) {
    outfits = [];
    venues = [];
    document.querySelector('#venue-mode-option').hidden = true;
    document.querySelector('#venue-select-wrap').hidden = true;
    outfitSelect.replaceChildren(new Option('无法读取套装目录', ''));
    catalogStatus.textContent = `套装目录读取失败：${error.message}`;
  } finally {
    if (operation === request) setOperation({ kind: 'idle' });
  }
}

async function selectPhoto(file) {
  if (operation.kind === 'generation') return;
  const version = ++selectionVersion;
  photoError.hidden = true;
  coupleImage = null;
  releasePhotoURL();
  photoPreview.removeAttribute('src');
  photoPreviewWrap.hidden = true;
  clearResult();
  if (!file) {
    photoPreviewWrap.hidden = true;
    return;
  }
  try {
    const image = await readImageFile(file);
    if (version !== selectionVersion) return;
    coupleImage = image;
    photoURL = URL.createObjectURL(new Blob([image.bytes], { type: image.mime }));
    photoPreview.src = photoURL;
    photoPreviewWrap.hidden = false;
  } catch (error) {
    if (version !== selectionVersion) return;
    photoPreviewWrap.hidden = true;
    photoError.textContent = error.message;
    photoError.hidden = false;
  }
}

function buildSnapshot() {
  if (!coupleImage) throw new Error('请先选择一张有效的合照。');
  const outfit = outfits.find(item => item.id === outfitSelect.value);
  if (!outfit) throw new Error('请先加载并选择一套婚礼造型。');
  if (!tokenInput.value.trim()) throw new Error('请输入后端访问 Token。');
  const dressSide = form.querySelector('input[name="dress-side"]:checked')?.value;
  if (!['left', 'right'].includes(dressSide)) throw new Error('请选择婚纱在画面中的一侧。');
  const mode = form.querySelector('input[name="scene-mode"]:checked')?.value;
  if (!['original', 'upload', 'venue'].includes(mode)) throw new Error('请选择场地模式。');
  if (mode === 'upload' && !sceneImage) throw new Error('请选择一张有效的场地照片，或切换为保留原背景。');
  if (mode === 'venue' && !venues.some(venue => venue.id === venueSelect.value)) throw new Error('请选择目录中的固定场馆。');
  const scene = mode === 'upload' ? { mode, image: sceneImage.base64 } : mode === 'venue' ? { mode, venue_id: venueSelect.value } : { mode };
  return Object.freeze({
    couple_image: coupleImage.base64,
    outfit_id: outfit.id,
    outfit_name: outfit.name,
    dress_side: dressSide,
    scene: Object.freeze(scene),
    token: tokenInput.value.trim(),
  });
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
  if (operation !== request) throw new DOMException('Generation superseded', 'AbortError');
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
    resultStatus.textContent = label;
    request.lastPhase = status.phase;
  }
}

async function displayResult(data, snapshot, request) {
  const info = resolveResultImageInfo(data?.image, data?.mime_type);
  if (info.mime !== normalizeImageMime(data?.mime_type)) throw new Error('生成结果的图片格式与声明不一致。');
  const binary = atob(info.b64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  releaseResultURL();
  resultURL = URL.createObjectURL(new Blob([bytes], { type: info.mime }));
  resultImage.src = resultURL;
  resultStatus.textContent = '正在解码生成图片…';
  try {
    await waitForGeneration(resultImage.decode(), request);
  } catch (error) {
    if (request.controller.signal.aborted) throw error;
    throw new Error('生成结果图片无法解码，请手动重试。');
  }
  checkGeneration(request);
  if (resultImage.naturalWidth !== data.width || resultImage.naturalHeight !== data.height) throw new Error('生成结果图片尺寸与声明不一致。');
  resultEmpty.hidden = true;
  resultWrap.hidden = false;
  // Let the decoded image reach a rendered frame before stopping the clock.
  await waitForGeneration(new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), request);
  checkGeneration(request);
  const durationMs = Math.ceil(performance.now() - request.startedAt);
  downloadLink.href = resultURL;
  downloadLink.download = `vowmirror-wedding.${imageExtensionForMime(info.mime)}`;
  const providerModel = data.provider_model ? `${data.provider_model}${data.provider_model === data.model ? '（未提供日期快照）' : ''}` : '未提供版本信息（未提供日期快照）';
  resultMeta.textContent = `${snapshot.outfit_name} · 婚纱在画面${snapshot.dress_side === 'left' ? '左侧' : '右侧'} · ${info.mime} · 可查看耗时 ${durationMs} ms · 请求型号 ${data.model} · 供应商型号 ${providerModel} · 请求 ${data.request_id}${data.provider_request_id ? ` · 供应商请求 ${data.provider_request_id}` : ''}`;
  resultStatus.hidden = true;
  resultState.textContent = '生成完成';
}

async function generate() {
  if (operation.kind !== 'idle') return;
  const startedAt = performance.now();
  clearFormError();
  let snapshot;
  try {
    snapshot = buildSnapshot();
  } catch (error) {
    showFormError(error.message);
    return;
  }
  const request = { kind: 'generation', controller: new AbortController(), timedOut: false, timer: 0, startedAt, lastPhase: '' };
  setOperation(request);
  clearResult();
  resultEmpty.hidden = true;
  resultWrap.hidden = true;
  resultStatus.hidden = false;
  resultStatus.textContent = '正在生成婚礼合影…';
  resultState.textContent = '生成中';
  request.timer = window.setTimeout(() => {
    request.timedOut = true;
    request.controller.abort();
  }, Math.max(0, GENERATION_TIMEOUT_MS - (performance.now() - startedAt)));
  try {
    checkGeneration(request);
    const response = await waitForGeneration(fetch('/api/tryon/couple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${snapshot.token}` },
      body: JSON.stringify({ couple_image: snapshot.couple_image, outfit_id: snapshot.outfit_id, dress_side: snapshot.dress_side, scene: snapshot.scene }),
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
  } catch (error) {
    if (operation !== request) return;
    clearResult();
    const timedOut = request.timedOut || error?.code === 'GENERATION_TIMEOUT';
    const cancelled = !timedOut && (request.controller.signal.aborted || error?.code === 'GENERATION_CANCELLED');
    const message = generationErrorMessage(error, request);
    if (!request.controller.signal.aborted) request.controller.abort(error);
    resultStatus.textContent = message;
    resultState.textContent = timedOut ? GENERATION_OUTCOME_LABELS.timeout : cancelled ? GENERATION_OUTCOME_LABELS.cancelled : GENERATION_OUTCOME_LABELS.failed;
    resultStatus.hidden = false;
    resultEmpty.hidden = true;
    showFormError(message, false);
  } finally {
    window.clearTimeout(request.timer);
    if (operation === request) setOperation({ kind: 'idle' });
  }
}

imageInput.addEventListener('change', () => selectPhoto(imageInput.files?.[0]));
sceneInput.setAttribute('aria-describedby', 'scene-preview scene-error');
sceneInput.addEventListener('change', () => selectScene(sceneInput.files?.[0]));
clearSceneButton.addEventListener('click', () => {
  if (operation.kind === 'generation') return;
  clearScene();
  sceneNote.textContent = SCENE_UPLOAD_NOTE;
  clearResult();
});
sceneInputs.forEach(input => input.addEventListener('change', () => {
  if (operation.kind === 'generation') return;
  clearScene();
  clearResult();
  const upload = input.value === 'upload';
  document.querySelector('#scene-upload-area').hidden = !upload;
  document.querySelector('#venue-select-wrap').hidden = input.value !== 'venue';
  venueSelect.value = '';
  sceneNote.textContent = input.value === 'original' ? '生成时保留合照中的原有背景。' : SCENE_UPLOAD_NOTE;
}));
clearPhotoButton.addEventListener('click', () => {
  if (operation.kind === 'generation') return;
  selectionVersion++;
  imageInput.value = '';
  coupleImage = null;
  releasePhotoURL();
  photoPreviewWrap.hidden = true;
  photoError.hidden = true;
  clearResult();
});
loadOutfitsButton.addEventListener('click', loadOutfits);
tokenInput.addEventListener('change', persistToken);
saveToken.addEventListener('change', persistToken);
sideInputs.forEach(input => input.addEventListener('change', () => {
  const side = input.value === 'left' ? '左侧' : '右侧';
  sidePreview.textContent = `原合照${side}的人穿婚纱，另一位穿男装；生成后保留两人左右站位，服装选择不受性别影响。`;
}));
form.addEventListener('submit', event => { event.preventDefault(); generate(); });
cancelButton.addEventListener('click', () => {
  if (operation.kind === 'generation') operation.controller.abort();
});
document.querySelector('#check-health').addEventListener('click', checkHealth);
window.addEventListener('pagehide', () => {
  releasePhotoURL();
  clearScene();
  releaseResultURL();
  if (operation.kind === 'generation') operation.controller.abort();
});

setOperation(operation);
await checkHealth();

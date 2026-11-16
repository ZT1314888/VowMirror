import { getAPIError, parseAPIResponse } from './response-core.mjs';
import { imageExtensionForMime, normalizeImageMime, readImageFile, resolveResultImageInfo } from './image-core.mjs';

const TOKEN_KEY = 'vowmirror-access-token';
const GENERATION_TIMEOUT_MS = 60_000;
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

let coupleImage = null;
let photoURL = '';
let resultURL = '';
let operation = { kind: 'idle' };
let selectionVersion = 0;
let outfits = [];

tokenInput.value = localStorage.getItem(TOKEN_KEY) ?? '';
saveToken.checked = Boolean(tokenInput.value);

function setOperation(next) {
  operation = next;
  const generating = operation.kind === 'generation';
  const busy = operation.kind !== 'idle';
  imageInput.disabled = generating;
  clearPhotoButton.disabled = generating;
  sideInputs.forEach(input => { input.disabled = generating; });
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
  setOperation(request);
  catalogStatus.textContent = '正在读取套装目录…';
  try {
    const response = await fetch('/api/catalog/outfits', {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    const body = await parseAPIResponse(response);
    if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.outfits)) throw new Error(getAPIError(response, body).text);
    outfits = body.data.outfits;
    outfitSelect.replaceChildren(new Option('选择一套婚礼造型', ''));
    for (const outfit of outfits) outfitSelect.add(new Option(outfit.name, outfit.id));
    catalogStatus.textContent = `已读取 ${outfits.length} 套可用造型。`;
  } catch (error) {
    outfits = [];
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
  clearResult();
  if (!file) {
    photoPreviewWrap.hidden = true;
    return;
  }
  try {
    const image = await readImageFile(file);
    if (version !== selectionVersion) return;
    coupleImage = image;
    photoURL = URL.createObjectURL(file);
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
  return Object.freeze({
    couple_image: coupleImage.base64,
    outfit_id: outfit.id,
    outfit_name: outfit.name,
    dress_side: dressSide,
    scene: Object.freeze({ mode: 'original' }),
    token: tokenInput.value.trim(),
  });
}

function displayResult(data, snapshot) {
  const info = resolveResultImageInfo(data?.image, data?.mime_type);
  if (info.mime !== normalizeImageMime(data?.mime_type)) throw new Error('生成结果的图片格式与声明不一致。');
  const binary = atob(info.b64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  releaseResultURL();
  resultURL = URL.createObjectURL(new Blob([bytes], { type: info.mime }));
  resultImage.src = resultURL;
  downloadLink.href = resultURL;
  downloadLink.download = `vowmirror-wedding.${imageExtensionForMime(info.mime)}`;
  resultMeta.textContent = `${snapshot.outfit_name} · 婚纱在画面${snapshot.dress_side === 'left' ? '左侧' : '右侧'} · ${info.mime}`;
  resultEmpty.hidden = true;
  resultWrap.hidden = false;
  resultStatus.hidden = true;
  resultState.textContent = '生成完成';
}

async function generate() {
  if (operation.kind !== 'idle') return;
  clearFormError();
  let snapshot;
  try {
    snapshot = buildSnapshot();
  } catch (error) {
    showFormError(error.message);
    return;
  }
  const request = { kind: 'generation', controller: new AbortController(), timedOut: false, timer: 0 };
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
  }, GENERATION_TIMEOUT_MS);
  try {
    const response = await fetch('/api/tryon/couple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${snapshot.token}` },
      body: JSON.stringify({ couple_image: snapshot.couple_image, outfit_id: snapshot.outfit_id, dress_side: snapshot.dress_side, scene: snapshot.scene }),
      cache: 'no-store', redirect: 'error', signal: request.controller.signal,
    });
    const body = await parseAPIResponse(response);
    if (!response.ok || body.code !== 0) throw new Error(getAPIError(response, body).text);
    if (operation !== request || request.controller.signal.aborted) return;
    displayResult(body.data, snapshot);
  } catch (error) {
    if (operation !== request) return;
    const message = request.timedOut ? '生成超过 60 秒，已停止请求。你可以手动重试。' : request.controller.signal.aborted ? '生成已取消。你可以手动重试。' : error.message;
    resultStatus.textContent = message;
    resultState.textContent = request.timedOut ? '已超时' : request.controller.signal.aborted ? '已取消' : '生成失败';
    resultStatus.hidden = false;
    resultEmpty.hidden = true;
    showFormError(message, false);
  } finally {
    window.clearTimeout(request.timer);
    if (operation === request) setOperation({ kind: 'idle' });
  }
}

imageInput.addEventListener('change', () => selectPhoto(imageInput.files?.[0]));
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
  sidePreview.textContent = input.value === 'left' ? '画面左侧的人穿婚纱，另一位穿男装。' : '画面右侧的人穿婚纱，另一位穿男装。';
}));
form.addEventListener('submit', event => { event.preventDefault(); generate(); });
cancelButton.addEventListener('click', () => {
  if (operation.kind === 'generation') operation.controller.abort();
});
document.querySelector('#check-health').addEventListener('click', checkHealth);
window.addEventListener('pagehide', () => {
  releasePhotoURL();
  releaseResultURL();
  if (operation.kind === 'generation') operation.controller.abort();
});

setOperation(operation);
await checkHealth();

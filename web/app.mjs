import { parseAPIResponse, getAPIError } from './response-core.mjs';

const button = document.querySelector('#check-health');
const status = document.querySelector('#health-status');

async function checkHealth() {
  button.disabled = true;
  status.dataset.state = 'pending';
  status.textContent = '正在检查后端连接…';
  try {
    const response = await fetch('/api/health', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
    const body = await parseAPIResponse(response);
    if (!response.ok || body.code !== 0) throw new Error(getAPIError(response, body).text);
    if (body.data?.status !== 'ok') throw new Error('健康检查响应格式无效');
    status.dataset.state = 'ok';
    status.textContent = '后端连接正常';
  } catch (error) {
    status.dataset.state = 'error';
    status.textContent = `后端连接失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

button.addEventListener('click', checkHealth);
await checkHealth();

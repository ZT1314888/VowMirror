const ERROR_MESSAGES = {
  AUTH_REQUIRED: '请输入后端访问 Token',
  AUTH_INVALID: '后端访问 Token 无效',
  ORIGIN_NOT_ALLOWED: '当前页面来源不允许访问后端',
  REQUEST_TOO_LARGE: '请求超过大小限制',
  INVALID_IMAGE_BASE64: '图片编码无效',
  UNSUPPORTED_IMAGE_TYPE: '图片格式不受支持',
  IMAGE_FILE_TOO_LARGE: '图片超过大小限制',
  IMAGE_DIMENSIONS_INVALID: '图片尺寸不符合要求',
  IMAGE_PIXEL_LIMIT_EXCEEDED: '图片像素超过限制',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  DAILY_QUOTA_EXCEEDED: '今日生成尝试额度已用完',
  CONCURRENCY_LIMITED: '当前已有生成请求，请稍后再试',
};

export async function parseAPIResponse(response) {
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && !type.endsWith('+json')) throw new Error(`后端返回非 JSON 响应（HTTP ${response.status}）`);
  const body = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('后端响应格式无效');
  return body;
}

export function getAPIError(response, body) {
  const code = body?.data?.error_code ?? ({ 401: 'AUTH_REQUIRED', 403: 'ORIGIN_NOT_ALLOWED', 413: 'REQUEST_TOO_LARGE' }[response.status]);
  if (ERROR_MESSAGES[code]) return { code, text: ERROR_MESSAGES[code] };
  return { code: 'API_ERROR', text: `后端请求失败（HTTP ${response.status}）` };
}

export const ERROR_MESSAGES = Object.freeze({
  COUPLE_IMAGE_NOT_COUPLE: '未检测到两张清晰的人脸，请换一张两人面部清楚的合照。',
  FACE_DETECTION_UNAVAILABLE: '暂时无法检查合照，请稍后重试。',
  AUTH_REQUIRED: '请输入生成码后再继续',
  AUTH_INVALID: '生成码无效，请检查后重试',
  SUCCESS_QUOTA_EXCEEDED: '此生成码的五次成功额度已用完',
  USAGE_UNAVAILABLE: '生成额度存储不可用，请稍后重试',
  ORIGIN_NOT_ALLOWED: '当前页面来源不允许访问后端',
  REQUEST_TOO_LARGE: '请求超过大小限制',
  INVALID_IMAGE_BASE64: '图片编码无效',
  UNSUPPORTED_IMAGE_TYPE: '图片格式不受支持',
  IMAGE_FILE_TOO_LARGE: '图片超过大小限制',
  IMAGE_DIMENSIONS_INVALID: '图片尺寸不符合要求',
  IMAGE_PIXEL_LIMIT_EXCEEDED: '图片像素超过限制',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  DAILY_QUOTA_EXCEEDED: '此生成码今日模型尝试次数已用完，请在 UTC 次日重试',
  CONCURRENCY_LIMITED: '当前已有生成请求，请稍后再试',
});

export const SERVER_BUSY_MESSAGE = '服务器资源紧张，请稍后再试';

export async function parseAPIResponse(response) {
  const type = (response.headers?.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && !type.endsWith('+json')) throw new Error(SERVER_BUSY_MESSAGE);
  const body = await response.json().catch(() => { throw new TypeError('response body is not JSON'); });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('response body is not an object');
  return body;
}

// 请求没有拿到有效后端响应（连接失败、请求无法编码、非 JSON 响应）时统一提示服务繁忙，
// 不把浏览器或网络层的原生异常暴露给用户。
export function isUnreachableError(error) {
  return error instanceof TypeError || error instanceof DOMException;
}

export function getAPIError(response, body) {
  const code = body?.data?.error_code ?? ({ 401: 'AUTH_REQUIRED', 403: 'ORIGIN_NOT_ALLOWED', 413: 'REQUEST_TOO_LARGE' }[response.status]);
  if (code === 'GENERATION_TIMEOUT') return { code, text: '生成超过服务端时限，已停止请求。你可以手动重试。' };
  if (code === 'GENERATION_CANCELLED') return { code, text: '生成已取消。你可以手动重试。' };
  if (ERROR_MESSAGES[code]) return { code, text: ERROR_MESSAGES[code] };
  return { code: 'API_ERROR', text: SERVER_BUSY_MESSAGE };
}

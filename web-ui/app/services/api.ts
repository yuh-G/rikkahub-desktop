import ky, { type Options, HTTPError, TimeoutError } from "ky";

interface ErrorResponse {
  error: string;
  code: number;
  /** 业务错误码(服务端 foundation/errors CodedError 通道;可选,旧端点不带)。
   *  前端按码查 i18n 文案,error 字段是兜底人话。 */
  errorCode?: string;
}

interface WebAuthTokenResponse {
  token: string;
  expiresAt: number;
}

interface WebAuthRequiredEventDetail {
  message: string;
  code: number;
}

export class ApiError extends Error {
  code: number;
  /** 业务错误码(可选):有码时调用方可按 `errors.${errorCode}` 查 i18n 文案,message 兜底。 */
  errorCode?: string;

  constructor(message: string, code: number, errorCode?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.errorCode = errorCode;
  }
}

const WEB_AUTH_STORAGE_KEY = "rikkahub:web-auth";
const WEB_AUTH_REQUIRED_EVENT = "rikkahub:web-auth-required";
const STARTUP_PENDING_EVENT = "rikkahub:startup-pending";
const WEB_AUTH_EXPIRY_SKEW_MILLIS = 10_000;
const WEB_AUTH_QUERY_KEY = "access_token";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function readStoredWebAuth(): WebAuthTokenResponse | null {
  if (!isBrowser()) return null;
  const raw = window.localStorage.getItem(WEB_AUTH_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<WebAuthTokenResponse>;
    if (typeof parsed.token !== "string" || typeof parsed.expiresAt !== "number") {
      return null;
    }
    return { token: parsed.token, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function isWebAuthExpired(expiresAt: number): boolean {
  return Date.now() >= expiresAt - WEB_AUTH_EXPIRY_SKEW_MILLIS;
}

function getValidWebAuthToken(): string | null {
  const auth = readStoredWebAuth();
  if (!auth) return null;
  if (isWebAuthExpired(auth.expiresAt)) {
    clearWebAuthToken();
    return null;
  }
  return auth.token;
}

function dispatchWebAuthRequired(detail: WebAuthRequiredEventDetail) {
  if (!isBrowser()) return;
  window.dispatchEvent(
    new CustomEvent<WebAuthRequiredEventDetail>(WEB_AUTH_REQUIRED_EVENT, { detail }),
  );
}

const kyInstance = ky.create({
  prefixUrl: "/api",
  timeout: 30000,
  hooks: {
    beforeRequest: [
      (request) => {
        const token = getValidWebAuthToken();
        if (!token || request.headers.has("Authorization")) return;
        request.headers.set("Authorization", `Bearer ${token}`);
      },
    ],
  },
});

/** 本地合成(非服务端下发)的错误码:与 CodedError 共用 errors.* i18n 通道。 */
export const ERROR_CODE_NETWORK_UNREACHABLE = "network_unreachable";

/** 网络层失败统一收口:ky 对连接失败/请求中断抛裸 TypeError("Failed to fetch" 等
 *  浏览器黑话),这里换成带码 ApiError,前端按码出人话(域6-1)。 */
function isNetworkLayerError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  return error instanceof TypeError;
}

async function handleError(error: unknown): Promise<never> {
  if (error instanceof HTTPError) {
    const { response } = error;
    let errorData: ErrorResponse | undefined;
    try {
      errorData = await response.json();
    } catch {
      // Ignore JSON parse error
    }
    const code = errorData?.code ?? response.status;
    const message = errorData?.error ?? error.message;
    const isAuthTokenEndpoint = response.url.includes("/api/auth/token");
    if (code === 401 && !isAuthTokenEndpoint) {
      clearWebAuthToken();
      dispatchWebAuthRequired({ message, code });
    }
    if (code === 503) {
      // R1-1:503 可能来自启动闸门(服务端先绑端口、迁移在后台跑,期间 /api 一律 503)。
      // 用状态端点探明后弹出迁移进度页;普通业务 503 探测结果是 ready,不打扰。
      void maybeDispatchStartupPending();
    }
    throw new ApiError(message, code, errorData?.errorCode);
  }
  if (isNetworkLayerError(error)) {
    throw new ApiError(ERROR_CODE_NETWORK_UNREACHABLE, 0, ERROR_CODE_NETWORK_UNREACHABLE);
  }
  throw error;
}

export function setWebAuthToken(token: string, expiresAt: number): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(WEB_AUTH_STORAGE_KEY, JSON.stringify({ token, expiresAt }));
}

export function clearWebAuthToken(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(WEB_AUTH_STORAGE_KEY);
}

/** SharedWorker 事件通道用:worker 里没有 localStorage,由页面读出 token 随 hello 传入。 */
export function getWebAuthToken(): string | null {
  return getValidWebAuthToken();
}

/** SharedWorker 事件通道用:worker 收到 401 时由页面代为清 token 并触发密码闸门事件。 */
export function notifyWebAuthRequired(detail: WebAuthRequiredEventDetail): void {
  clearWebAuthToken();
  dispatchWebAuthRequired(detail);
}

/** R1-1:服务端启动/迁移状态(/api/startup/status,免鉴权)。 */
export interface StartupStatusInfo {
  ready: boolean;
  failed: boolean;
  phase: string;
  current: number;
  total: number;
  error: string;
}

export async function fetchStartupStatus(): Promise<StartupStatusInfo | null> {
  try {
    return await kyInstance.get("startup/status", { timeout: 5_000, retry: 0 }).json<StartupStatusInfo>();
  } catch {
    return null;
  }
}

let startupProbeInFlight = false;

/** 收到 503 后探测启动状态:确属"未就绪"才广播,让 StartupGate 弹出迁移进度页。 */
async function maybeDispatchStartupPending(): Promise<void> {
  if (!isBrowser() || startupProbeInFlight) return;
  startupProbeInFlight = true;
  try {
    const status = await fetchStartupStatus();
    if (status && !status.ready) {
      window.dispatchEvent(new CustomEvent(STARTUP_PENDING_EVENT));
    }
  } finally {
    startupProbeInFlight = false;
  }
}

export function onStartupPending(listener: () => void): () => void {
  if (!isBrowser()) return () => {};
  const handler = () => listener();
  window.addEventListener(STARTUP_PENDING_EVENT, handler);
  return () => {
    window.removeEventListener(STARTUP_PENDING_EVENT, handler);
  };
}

export function onWebAuthRequired(
  listener: (detail: WebAuthRequiredEventDetail) => void,
): () => void {
  if (!isBrowser()) return () => {};

  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<WebAuthRequiredEventDetail>;
    listener(customEvent.detail);
  };
  window.addEventListener(WEB_AUTH_REQUIRED_EVENT, handler);

  return () => {
    window.removeEventListener(WEB_AUTH_REQUIRED_EVENT, handler);
  };
}

export function appendWebAuthQuery(url: string): string {
  if (!isBrowser() || !url.startsWith("/api/")) return url;

  const token = getValidWebAuthToken();
  if (!token) return url;

  const [pathWithQuery, hash = ""] = url.split("#", 2);
  const separator = pathWithQuery.includes("?") ? "&" : "?";
  const encodedToken = encodeURIComponent(token);
  const nextPath = `${pathWithQuery}${separator}${WEB_AUTH_QUERY_KEY}=${encodedToken}`;
  return hash ? `${nextPath}#${hash}` : nextPath;
}

/**
 * API client with unwrapped response data
 */
const api = {
  async get<T>(url: string, options?: Options): Promise<T> {
    try {
      return await kyInstance.get(url, options).json<T>();
    } catch (error) {
      return handleError(error);
    }
  },
  async post<T>(url: string, data?: unknown, options?: Options): Promise<T> {
    try {
      return await kyInstance
        .post(url, data === undefined ? options : { ...options, json: data })
        .json<T>();
    } catch (error) {
      return handleError(error);
    }
  },
  async postMultipart<T>(url: string, formData: FormData, options?: Options): Promise<T> {
    try {
      return await kyInstance.post(url, { ...options, body: formData }).json<T>();
    } catch (error) {
      return handleError(error);
    }
  },
  /** 专题4:带上传进度回调的 multipart POST。fetch/ky 拿不到请求体的发送进度,只能用
   *  XHR 的 upload.onprogress(与导入导出的 XHR 用法同理);鉴权头、错误载荷解析、401
   *  密码闸门语义与 kyInstance 对齐。timeout=0——大文件慢网不设限,与上传通道既有的
   *  timeout:false 决策(7-2)一致。 */
  postMultipartWithProgress<T>(
    url: string,
    formData: FormData,
    onProgress: (percent: number) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/${url}`);
      xhr.timeout = 0;
      const token = getValidWebAuthToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as T);
          } catch (parseError) {
            reject(parseError);
          }
          return;
        }
        let message = `HTTP ${xhr.status}`;
        let code = xhr.status;
        let errorCode: string | undefined;
        try {
          const data = JSON.parse(xhr.responseText) as ErrorResponse;
          message = data.error ?? message;
          code = data.code ?? code;
          errorCode = data.errorCode;
        } catch {
          // 非 JSON 错误体,保留 HTTP 状态文案
        }
        if (code === 401) {
          clearWebAuthToken();
          dispatchWebAuthRequired({ message, code });
        }
        reject(new ApiError(message, code, errorCode));
      };
      xhr.onerror = () =>
        reject(new ApiError(ERROR_CODE_NETWORK_UNREACHABLE, 0, ERROR_CODE_NETWORK_UNREACHABLE));
      xhr.ontimeout = () =>
        reject(new ApiError(ERROR_CODE_NETWORK_UNREACHABLE, 0, ERROR_CODE_NETWORK_UNREACHABLE));
      xhr.send(formData);
    });
  },
  async postBlob(url: string, data?: unknown, options?: Options): Promise<Response> {
    try {
      return await kyInstance.post(url, data === undefined ? options : { ...options, json: data });
    } catch (error) {
      return handleError(error);
    }
  },
  async put<T>(url: string, data?: unknown, options?: Options): Promise<T> {
    try {
      return await kyInstance
        .put(url, data === undefined ? options : { ...options, json: data })
        .json<T>();
    } catch (error) {
      return handleError(error);
    }
  },
  async patch<T>(url: string, data?: unknown, options?: Options): Promise<T> {
    try {
      return await kyInstance
        .patch(url, data === undefined ? options : { ...options, json: data })
        .json<T>();
    } catch (error) {
      return handleError(error);
    }
  },
  async delete<T>(url: string, options?: Options): Promise<T> {
    try {
      return await kyInstance.delete(url, options).json<T>();
    } catch (error) {
      return handleError(error);
    }
  },
};

export async function requestWebAuthToken(password: string): Promise<WebAuthTokenResponse> {
  const response = await api.post<WebAuthTokenResponse>("auth/token", { password });
  setWebAuthToken(response.token, response.expiresAt);
  return response;
}

// —— 设置页内置访问密码(P1)——
// 状态端点只回布尔(不含哈希),供暴露横幅与设置页状态卡;改密走 settings/web-password。
export interface WebAuthStatus {
  enabled: boolean;
  configured: boolean;
  lockedByDeployment: boolean;
}

export async function fetchWebAuthStatus(): Promise<WebAuthStatus> {
  return api.get<WebAuthStatus>("web-auth/status");
}

/** 设/改/清访问密码。newPassword 空串=清除;已设密码须带 currentPassword。 */
export async function setWebPassword(input: {
  currentPassword?: string;
  newPassword: string;
}): Promise<{ status: string; configured: boolean }> {
  return api.post("settings/web-password", input);
}

/**
 * 代码块"在浏览器中打开"(桌面壳专用):后端把代码落盘为临时文件,并用系统默认
 * 程序打开(.html → 默认浏览器)。桌面壳的 WebView2 会吞掉 window.open(blob:),
 * 且 blob URL 只在页面内有效,无法交给外部浏览器。
 */
export async function openCodePreviewFile(content: string, language: string): Promise<void> {
  await api.post("code-preview/open", { content, language });
}

/**
 * 域10-1(交互审查 4A):桌面壳导出落盘。后端把内容写进 dataDir/exports/,返回绝对路径,
 * 前端 toast 携带"在文件夹中显示"按钮调 revealExportFile 定位。仅限本机直连(后端回环闸)。
 * 浏览器部署维持下载通道,不走这里。
 */
export async function saveExportFile(
  filename: string,
  content: string,
  encoding?: "base64",
): Promise<{ path: string; filename: string }> {
  return api.post<{ path: string; filename: string }>("exports/save", { filename, content, encoding });
}

export async function revealExportFile(path: string): Promise<void> {
  await api.post("exports/reveal", { path });
}

export interface SSEEvent<T> {
  event: string;
  data: T;
  id?: string;
}

export interface SSECallbacks<T> {
  onMessage: (event: SSEEvent<T>) => void;
  /** 每次连接尝试失败时触发（自动重连模式下可能多次）。 */
  onError?: (error: Error) => void;
  /** 每次连接（含重连）成功时触发。后端所有流在连接时都会推初始快照/invalidate，重连即自动补齐断线期间的状态。 */
  onOpen?: () => void;
  /** 订阅彻底结束（abort、关闭重连或遇不可自愈错误）时触发一次。 */
  onClose?: () => void;
}

export interface SSEOptions extends Options {
  signal?: AbortSignal;
  /** 断线自动重连（指数退避 1s→30s，收到任何消息即重置计数）。默认开启；一次性流可显式关闭。 */
  reconnect?: boolean;
}

// R6-1:SSE 客户端活性看门狗预算。服务端每 15s 发 `: heartbeat` 注释帧;45s(3×心跳)
// 内一个字节都没有,判定连接已死(合盖睡眠/切 Wi-Fi/VPN 断开产生的半开 TCP 会让
// reader.read() 永久挂起——不抛错、不重连),abort 当前连接走既有重连路径。与 SharedWorker
// 判活口径(app-events-worker)一致。
const SSE_IDLE_TIMEOUT_MS = 45_000;

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Create an SSE connection using ky (supports auth headers).
 *
 * 内建断线重连（N-8）：网络抖动或后端重启后按指数退避自动重连，四路长订阅
 * （settings/会话列表/会话详情/memory）统一受益，无需各自实现。由于后端每条流
 * 在连接时都主动推送初始快照，重连本身即完成状态补偿。不可自愈的 4xx
 * （401 由密码闸门接管整页 reload；404 资源已删除等）停止重连。
 */
async function sse<T>(
  url: string,
  callbacks: SSECallbacks<T>,
  options?: SSEOptions,
): Promise<void> {
  const { reconnect = true, ...requestOptions } = options ?? {};
  const signal = requestOptions.signal;
  let attempt = 0;

  /** 单次连接：返回 "retry"（可重连）或 "fatal"（终止订阅）。 */
  const connectOnce = async (): Promise<"retry" | "fatal"> => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    // R6-1:本次连接的看门狗。外部 signal 与看门狗都通过 controller 中断底层 fetch;
    // 用 idleTimedOut 区分二者——外部 abort 是"用户/组件卸载"(fatal),看门狗是"连接静默
    // 死亡"(retry,走重连)。
    const controller = new AbortController();
    let idleTimedOut = false;
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdleWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, SSE_IDLE_TIMEOUT_MS);
    };

    try {
      const response = await kyInstance.get(url, {
        ...requestOptions,
        headers: {
          ...requestOptions.headers,
          Accept: "text/event-stream",
        },
        timeout: false,
        signal: controller.signal,
      });

      callbacks.onOpen?.();

      reader = response.body?.getReader();
      if (!reader) {
        throw new ApiError("Response body is not readable", 0);
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "message";
      let currentData = "";
      let currentId: string | undefined;

      armIdleWatchdog(); // 连上即起看门狗
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdleWatchdog(); // 收到任何字节(含 `: heartbeat` 注释帧)即重置

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmedLine = line.replace(/\r$/, "");
          if (trimmedLine.startsWith("event:")) {
            currentEvent = trimmedLine.slice(6).trim();
          } else if (trimmedLine.startsWith("data:")) {
            // SSE 规范:data: 后只剥一个前导空格;整行 trim 会让多行 data 的空白失真
            const dataValue = trimmedLine.slice(5);
            currentData += (currentData ? "\n" : "") + (dataValue.startsWith(" ") ? dataValue.slice(1) : dataValue);
          } else if (trimmedLine.startsWith("id:")) {
            currentId = trimmedLine.slice(3).trim();
          } else if (trimmedLine === "") {
            if (currentData) {
              try {
                const data = JSON.parse(currentData) as T;
                attempt = 0;
                callbacks.onMessage({ event: currentEvent, data, id: currentId });
              } catch {
                // Ignore JSON parse error
              }
            }
            currentEvent = "message";
            currentData = "";
            currentId = undefined;
          }
        }
      }
      // 服务端正常关闭流（如后端重启）→ 可重连
      return "retry";
    } catch (error) {
      // R6-1:看门狗触发的 abort 是"连接静默死亡",走重连而非终止(必须先于下面的
      // AbortError→fatal 判定,二者都表现为 AbortError)。
      if (idleTimedOut) return "retry";
      if (error instanceof Error && error.name === "AbortError") {
        return "fatal";
      }
      try {
        await handleError(error);
      } catch (handledError) {
        callbacks.onError?.(
          handledError instanceof Error ? handledError : new Error(String(handledError)),
        );
        // 4xx 客户端错误重试不会自愈（408/429 除外）：401 已触发解锁闸门（解锁后整页
        // reload），404 表示订阅目标已不存在，继续重连只是空转。
        if (
          handledError instanceof ApiError &&
          handledError.code >= 400 &&
          handledError.code < 500 &&
          handledError.code !== 408 &&
          handledError.code !== 429
        ) {
          return "fatal";
        }
      }
      return "retry";
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (signal) signal.removeEventListener("abort", onExternalAbort);
      reader?.releaseLock();
    }
  };

  try {
    while (true) {
      const outcome = await connectOnce();
      if (signal?.aborted || outcome === "fatal" || !reconnect) return;
      const delay = Math.min(1000 * 2 ** attempt, 30_000);
      attempt += 1;
      await abortableDelay(delay, signal);
      if (signal?.aborted) return;
    }
  } finally {
    callbacks.onClose?.();
  }
}

export { sse };
export default api;

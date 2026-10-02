import https from 'node:https';
import { createPinnedHttpsAgent } from './pinnedLocalWebSocket';

export type PinnedStatusResult = {
  ok: boolean;
  statusCode?: number;
  errorCode?: string;
};

export function requestPinnedLocalStatus(
  statusUrl: string,
  expectedFingerprint: string,
  signal: AbortSignal
): Promise<PinnedStatusResult> {
  let url: URL;
  try {
    url = new URL(statusUrl);
  } catch {
    return Promise.resolve({ ok: false, errorCode: 'ERR_INVALID_LOCAL_STATUS_URL' });
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== '127.0.0.1' ||
    !isValidPort(url.port) ||
    url.pathname !== '/status' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return Promise.resolve({ ok: false, errorCode: 'ERR_INVALID_LOCAL_STATUS_URL' });
  }

  let agent: https.Agent;
  try {
    agent = createPinnedHttpsAgent(expectedFingerprint);
  } catch {
    return Promise.resolve({ ok: false, errorCode: 'ERR_INVALID_CERTIFICATE_PIN' });
  }

  if (signal.aborted) {
    agent.destroy();
    return Promise.resolve({ ok: false, errorCode: 'ABORT_ERR' });
  }

  return new Promise((resolve) => {
    let settled = false;
    let request: ReturnType<typeof https.request> | null = null;
    const finish = (result: PinnedStatusResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      agent.destroy();
      resolve(result);
    };
    const onAbort = () => {
      if (!request) {
        finish({ ok: false, errorCode: 'ABORT_ERR' });
        return;
      }
      const error = Object.assign(new Error('Readiness request aborted.'), {
        code: 'ABORT_ERR',
      });
      request.destroy(error);
      finish({ ok: false, errorCode: 'ABORT_ERR' });
    };

    try {
      request = https.request(
        url,
        { method: 'GET', agent, maxHeaderSize: 16 * 1024 },
        (response) => {
          const statusCode = response.statusCode;
          response.resume();
          finish(
            statusCode === 200
              ? { ok: true, statusCode }
              : {
                  ok: false,
                  statusCode,
                  errorCode: `HTTP_${statusCode ?? 'UNKNOWN'}`,
                }
          );
        }
      );
      request.once('error', (error: Error) => {
        finish({ ok: false, errorCode: safeErrorCode(error) });
      });
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      request.end();
    } catch (error) {
      finish({ ok: false, errorCode: safeErrorCode(error) });
    }
  });
}

function isValidPort(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function safeErrorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') {
    return /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'REQUEST_FAILED';
  }
  if (error instanceof Error && error.name === 'AbortError') return 'ABORT_ERR';
  return 'REQUEST_FAILED';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

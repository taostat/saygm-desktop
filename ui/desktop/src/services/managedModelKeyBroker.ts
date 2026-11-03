import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import type { ManagedModelKeyBrokerResult } from './gmAccountService';

const MAX_FRAME_BYTES = 16 * 1024;
const MAX_MODEL_KEY_BYTES = 4096;
const MAX_PENDING_FRAMES = 32;
const IO_TIMEOUT_MS = 120_000;

export type ManagedModelKeyBrokerAuthority = {
  readManagedModelKeyForBackend: () => Promise<ManagedModelKeyBrokerResult>;
  managedModelKeyMatchesForBackend: (sha256: string) => Promise<ManagedModelKeyBrokerResult>;
};

export function attachManagedModelKeyBroker(
  stream: Duplex,
  authority: ManagedModelKeyBrokerAuthority
): () => void {
  let input = Buffer.alloc(0);
  let pendingFrames = 0;
  let retired = false;
  let queue = Promise.resolve();

  const retire = () => {
    if (retired) return;
    retired = true;
    stream.removeListener('data', onData);
    stream.removeListener('end', retire);
    stream.removeListener('error', retire);
    stream.destroy();
  };

  const writeFrame = async (response: Record<string, unknown>) => {
    const payload = Buffer.from(`${JSON.stringify(response)}\n`, 'utf8');
    if (payload.length > MAX_FRAME_BYTES) throw new Error('response too large');
    if (!stream.write(payload)) {
      await withTimeout(once(stream, 'drain'), IO_TIMEOUT_MS);
    }
  };

  const processFrame = (frame: Buffer) => {
    if (retired) return;
    pendingFrames += 1;
    if (pendingFrames > MAX_PENDING_FRAMES) {
      retire();
      return;
    }
    queue = queue
      .then(async () => {
        if (retired) return;
        const request = parseRequest(frame);
        if (!request) {
          retire();
          return;
        }
        const response = await withTimeout(dispatch(request, authority), IO_TIMEOUT_MS);
        if (retired) return;
        await writeFrame({ id: request.id, ...response });
      })
      .catch(() => retire())
      .finally(() => {
        pendingFrames -= 1;
      });
  };

  function onData(chunk: Buffer | string) {
    if (retired) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    input = Buffer.concat([input, bytes]);
    if (input.length > MAX_FRAME_BYTES && input.indexOf(0x0a) < 0) {
      retire();
      return;
    }
    let newline: number;
    while (!retired && (newline = input.indexOf(0x0a)) >= 0) {
      const frame = input.subarray(0, newline);
      input = input.subarray(newline + 1);
      if (frame.length === 0 || frame.length > MAX_FRAME_BYTES) {
        retire();
        return;
      }
      processFrame(frame);
    }
    if (input.length > MAX_FRAME_BYTES) retire();
  }

  stream.on('data', onData);
  stream.once('end', retire);
  stream.once('error', retire);
  return retire;
}

type Request =
  { id: number; op: 'get_model_key' } | { id: number; op: 'model_key_matches'; sha256: string };

function parseRequest(frame: Buffer): Request | null {
  let value: unknown;
  try {
    value = JSON.parse(frame.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || (value.id as number) < 0) {
    return null;
  }
  if (value.op === 'get_model_key' && Object.keys(value).length === 2) {
    return { id: value.id as number, op: 'get_model_key' };
  }
  if (
    value.op === 'model_key_matches' &&
    Object.keys(value).length === 3 &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    return { id: value.id as number, op: 'model_key_matches', sha256: value.sha256 };
  }
  return null;
}

async function dispatch(
  request: Request,
  authority: ManagedModelKeyBrokerAuthority
): Promise<Record<string, unknown>> {
  const result =
    request.op === 'get_model_key'
      ? await authority.readManagedModelKeyForBackend()
      : await authority.managedModelKeyMatchesForBackend(request.sha256);
  if (!result.ok) return { ok: false, code: result.code };
  if (request.op === 'get_model_key') {
    if (!('key' in result) || (result.key !== null && typeof result.key !== 'string')) {
      return { ok: false, code: 'internal_error' };
    }
    if (result.key !== null && Buffer.byteLength(result.key, 'utf8') > MAX_MODEL_KEY_BYTES) {
      return { ok: false, code: 'internal_error' };
    }
    return { ok: true, key: result.key };
  }
  if (!('matches' in result) || typeof result.matches !== 'boolean') {
    return { ok: false, code: 'internal_error' };
  }
  return { ok: true, matches: result.matches };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('broker I/O timed out')), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import https from 'node:https';
import { createHash } from 'node:crypto';
import tls from 'node:tls';
import { WebSocket } from 'ws';
import type { WebSocketConstructor } from '@agentclientprotocol/sdk/experimental/ws-client';
import { isLoopbackAcpWebSocketUrl } from './url';

export function createPinnedLocalWebSocketConstructor(
  expectedFingerprint: string
): WebSocketConstructor {
  const expected = normalizeFingerprint(expectedFingerprint);
  if (!expected) throw new Error('A trusted SayGM backend certificate fingerprint is required.');
  const pinnedFingerprint: string = expected;

  return class PinnedLocalWebSocket extends WebSocket {
    constructor(
      url: string,
      protocols?: string | string[],
      options?: { headers?: Record<string, string> }
    ) {
      if (!isLoopbackAcpWebSocketUrl(url) || new URL(url).protocol !== 'wss:') {
        throw new Error('SayGM account keys require a pinned local secure SayGM backend.');
      }
      super(url, protocols, {
        ...options,
        agent: createPinnedHttpsAgent(pinnedFingerprint),
      });
    }
  };
}

export function createPinnedHttpsAgent(expectedFingerprint: string): https.Agent {
  const expected = normalizeFingerprint(expectedFingerprint);
  if (!expected) throw new Error('A trusted SayGM backend certificate fingerprint is required.');
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  const pendingSockets = new Set<tls.TLSSocket>();
  const destroyAgent = agent.destroy.bind(agent);
  Object.defineProperty(agent, 'destroy', {
    value: () => {
      for (const socket of pendingSockets) socket.destroy();
      destroyAgent();
    },
  });
  const createConnection = (
    options: tls.ConnectionOptions,
    callback?: (error: Error | null, socket?: tls.TLSSocket) => void
  ): null => {
    if (!callback) {
      throw new Error('Pinned TLS agent requires a socket verification callback.');
    }

    const socket = tls.connect({ ...options, rejectUnauthorized: false });
    pendingSockets.add(socket);
    let completed = false;
    const finish = (error: Error | null) => {
      if (completed) return;
      completed = true;
      pendingSockets.delete(socket);
      if (error) {
        callback(error);
        socket.destroy();
        return;
      }
      callback(null, socket);
    };

    socket.once('secureConnect', () => {
      const peerCertificate = socket.getPeerCertificate(true);
      const actualFingerprint = peerCertificate.raw
        ? createHash('sha256').update(peerCertificate.raw).digest('hex')
        : '';
      if (normalizeFingerprint(actualFingerprint) !== expected) {
        const error = new Error(
          'SayGM backend certificate did not match its pinned fingerprint.'
        ) as Error & { code: string };
        error.code = 'ERR_SAYGM_CERT_PIN_MISMATCH';
        finish(error);
        return;
      }
      finish(null);
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => pendingSockets.delete(socket));
    return null;
  };

  Object.defineProperty(agent, 'createConnection', { value: createConnection });
  return agent;
}

function normalizeFingerprint(value: string): string | null {
  const trimmed = value.trim();
  let hex = trimmed;
  if (/^sha256\//i.test(trimmed)) {
    try {
      hex = Buffer.from(trimmed.slice('sha256/'.length), 'base64').toString('hex');
    } catch {
      return null;
    }
  }
  const compact = hex.replaceAll(':', '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(compact)) return null;
  return compact.match(/.{2}/g)!.join(':');
}

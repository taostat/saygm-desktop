export type GmAccountStatus = {
  connected: boolean;
  mode: 'session' | 'api_key' | null;
  email: string | null;
  keyPrefix: string | null;
  providerConfigured: boolean;
  secureStorageAvailable: boolean;
  remoteCleanupPending: boolean;
  managedKeyAvailable?: boolean;
  legacyKeyCleanupPending?: boolean;
};

export type GmOAuthCapability = {
  operation_id: string;
  method: string;
  path: string;
  adapter_support: 'supported' | 'not_supported';
  entitlement_state: 'unknown';
  dependency_state: 'unknown';
  available: boolean | null;
  availability_reason: string | null;
};

export type GmCapabilities = {
  contract_version: 1;
  operations: GmOAuthCapability[];
};

export type GmAccountBalance = {
  kind: 'account' | 'key_spendable';
  usd: string;
  sharedBalance?: boolean;
};

export type GmGuardrailsMode = 'redact' | 'redact-restore' | 'block';
export type GmGuardrailsWordMode = 'redact' | 'block';
export type GmGuardrailsPolicyBody = Record<string, unknown>;
export type GmGuardrailsPolicySnapshot = {
  body: GmGuardrailsPolicyBody | null;
  context: string;
};

export type GmGuardrailsPreviewScannerId =
  'native:pii' | 'native:secrets' | 'native:regex' | 'native:ban-substrings';

export type GmGuardrailsPreviewScannerCounts = {
  detections: number;
  redacted: number;
  restored: number;
  blocked: number;
  by_entity_type: Record<string, number>;
};

export type GmGuardrailsPreviewResponse = {
  blocked: boolean;
  blocked_by: string | null;
  forwarded_text: string | null;
  returned_text: string | null;
  per_scanner: Record<string, GmGuardrailsPreviewScannerCounts>;
  by_entity_type: Record<string, number>;
  not_run: string[];
};

export type GmDeviceLoginInstructions = {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
};

export type GmDevicePollResult =
  | { status: 'pending'; retryAfterSeconds: number }
  | { status: 'connected'; account: GmAccountStatus };

export type GmAccountApi = {
  getStatus: () => Promise<GmAccountStatus>;
  onChanged: (listener: () => void) => () => void;
  onGuardrailsChanged: (listener: () => void) => () => void;
  getBalance: () => Promise<GmAccountBalance>;
  getCapabilities: () => Promise<GmCapabilities>;
  getGuardrails: () => Promise<GmGuardrailsPolicySnapshot>;
  previewGuardrails: (
    scannerId: GmGuardrailsPreviewScannerId,
    scanners: GmGuardrailsPolicyBody,
    text: string,
    context: string
  ) => Promise<GmGuardrailsPreviewResponse>;
  saveGuardrails: (
    body: GmGuardrailsPolicyBody,
    context: string
  ) => Promise<GmGuardrailsPolicySnapshot>;
  beginDeviceLogin: () => Promise<GmDeviceLoginInstructions>;
  pollDeviceLogin: () => Promise<GmDevicePollResult>;
  cancelDeviceLogin: () => Promise<void>;
  openDeviceVerification: () => Promise<void>;
  connectApiKey: (key: string) => Promise<GmAccountStatus>;
  finishProviderSetup: () => Promise<GmAccountStatus>;
  logout: () => Promise<void>;
  clearLegacyApiKey: () => Promise<{ removed: boolean }>;
  openTopup: () => Promise<void>;
};

export type GmAccountComponentProps = {
  mode?: 'full' | 'onboarding';
  onConnected?: () => void;
};

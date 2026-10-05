export const SAYGM_PRODUCT = {
  name: 'SayGM',
  appDataDirectory: 'SayGM',
  backendDataDirectory: 'agent',
  fallbackBackendDirectory: '.saygm',
  protocolScheme: 'saygm',
  providerId: 'saygm',
  oauthClientId: 'saygm-desktop',
  accountApiBaseUrl: 'https://account.saygm.com/v1',
  gatewayApiBaseUrl: 'https://api.saygm.com/v1',
  creditsUrl: 'https://saygm.com/dashboard/credits',
  modelsUrl: 'https://saygm.com/models',
  providerApiKeyField: 'SAYGM_API_KEY',
  accountCredentialsFile: 'saygm-account.safe',
  cleanupCredentialsFile: 'saygm-account-cleanup.safe',
  providerKeyName: 'SayGM Desktop',
  trustedSignInHosts: ['saygm.com', 'www.saygm.com', 'account.saygm.com'],
} as const;

export const SAYGM_ALLOWED_PROVIDER_IDS = [SAYGM_PRODUCT.providerId] as const;

export function isSaygmProviderId(providerId: string): boolean {
  return SAYGM_ALLOWED_PROVIDER_IDS.some((allowedId) => allowedId === providerId);
}

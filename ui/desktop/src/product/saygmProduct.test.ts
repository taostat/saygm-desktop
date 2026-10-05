import { describe, expect, it } from 'vitest';
import { isSaygmProviderId, SAYGM_ALLOWED_PROVIDER_IDS, SAYGM_PRODUCT } from './saygmProduct';

describe('SayGM product configuration', () => {
  it('keeps fixed service routes and OAuth client identity together', () => {
    expect(SAYGM_PRODUCT).toMatchObject({
      accountApiBaseUrl: 'https://account.saygm.com/v1',
      gatewayApiBaseUrl: 'https://api.saygm.com/v1',
      creditsUrl: 'https://saygm.com/dashboard/credits',
      modelsUrl: 'https://saygm.com/models',
      oauthClientId: 'saygm-desktop',
      trustedSignInHosts: ['saygm.com', 'www.saygm.com', 'account.saygm.com'],
    });
  });

  it('restricts hosted model selection to the SayGM provider', () => {
    expect(SAYGM_ALLOWED_PROVIDER_IDS).toEqual(['saygm']);
    expect(isSaygmProviderId('saygm')).toBe(true);
    expect(isSaygmProviderId('openai')).toBe(false);
  });

  it('preserves the app, protocol, key, and secure account storage names', () => {
    expect(SAYGM_PRODUCT).toMatchObject({
      name: 'SayGM',
      appDataDirectory: 'SayGM',
      protocolScheme: 'saygm',
      providerApiKeyField: 'SAYGM_API_KEY',
      accountCredentialsFile: 'saygm-account.safe',
      cleanupCredentialsFile: 'saygm-account-cleanup.safe',
      providerKeyName: 'SayGM Desktop',
    });
  });
});

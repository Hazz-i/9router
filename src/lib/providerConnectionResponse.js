import { AI_PROVIDERS } from "@/shared/constants/providers";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

export function toProviderConnectionResponse(connection) {
  const { apiKey, accessToken, refreshToken, idToken, ...safe } = connection;

  if (!connection.providerSpecificData) return safe;

  let providerSpecificData = connection.providerSpecificData;
  if (usesAwsCredentialForm(connection.provider)) {
    const { sessionToken, ...safeProviderSpecificData } = providerSpecificData;
    providerSpecificData = safeProviderSpecificData;
  }
  if (connection.provider === "deepgram") {
    const { thinkApiKey, ...safeProviderSpecificData } = providerSpecificData;
    providerSpecificData = safeProviderSpecificData;
  }
  return { ...safe, providerSpecificData };
}

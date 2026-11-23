import type { AuthTypeOAuth2, McpRequest } from 'insomnia-data';

import { getConfidentialBasicAuthHeaderValue } from '~/common/network/sensitive-value-collector';
import { getDataFromKVPair } from '~/common/utils/environment-utils';
import { _buildBearerHeader } from '~/network/authentication';
import { getBasicAuthHeader } from '~/network/basic-auth/get-header';
import { getBearerAuthHeader } from '~/network/bearer-auth/get-header';
import { tryToInterpolateRequestAndCollectSensitiveValues } from '~/ui/utils/try-interpolate';

/**
 * The URL and headers a connect (or a conformance run) sends: template-rendered, with the Auth tab turned into a header.
 * Shared by the URL bar's Connect and the conformance report so both talk to the server the same way.
 * PROTOTYPE-MOCK: OAuth 2 uses the legacy getOAuth2Token path here; the stepped OAuth debugger is slice S5.
 */
export const buildMcpConnectParams = async ({ request, environmentId }: { request: McpRequest; environmentId: string }) => {
  const result = await tryToInterpolateRequestAndCollectSensitiveValues({
    request,
    environmentId,
    payload: {
      url: request.url,
      headers: request.headers,
      authentication: request.authentication,
      env: getDataFromKVPair(request.env).data,
    },
  });
  if (!result) {
    return null;
  }
  const { rendered, sensitiveValues } = result;
  const { authentication, headers } = rendered;
  if (!authentication.disabled) {
    try {
      if (authentication.type === 'basic') {
        const { username, password, useISO88591 } = authentication;
        headers.push(getBasicAuthHeader(username, password, useISO88591 ? 'latin1' : 'utf8'));
        const confidential = getConfidentialBasicAuthHeaderValue(sensitiveValues, authentication);
        if (confidential) {
          sensitiveValues.push(confidential);
        }
      } else if (authentication.type === 'bearer' && authentication.token) {
        headers.push(getBearerAuthHeader(authentication.token, authentication.prefix));
      } else if (authentication.type === 'apikey') {
        headers.push({ name: authentication.key, value: authentication.value });
      } else if (authentication.type === 'oauth2') {
        const token = await window.main.getOAuth2Token(request._id, authentication as AuthTypeOAuth2);
        const header = token ? _buildBearerHeader(token.accessToken, authentication.tokenPrefix) : null;
        if (header) {
          headers.push(header);
        }
      }
    } catch (error) {
      console.error('[mcp-debugger] failed to build auth header', error);
    }
  }
  return { url: rendered.url, headers };
};

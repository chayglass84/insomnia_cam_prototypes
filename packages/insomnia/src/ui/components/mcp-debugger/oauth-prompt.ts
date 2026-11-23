// Task 4348: when to show the "this server asked for OAuth" banner after a failed Connect, and which wording. Pure, so the
// rule can be tested. It used to require a blank Auth tab, which hid it exactly when it helps most: a client that already
// ran the OAuth or XAA wizard holds a Bearer token in its Auth tab, and when that token goes stale (expired, revoked, the
// server restarted) Connect gets a 401 again and the user needs a fresh one.

export type OAuthPromptKind =
  /** No auth is configured: the server wants OAuth and nothing has been set up yet. */
  | 'sign-in'
  /** Auth is configured, but the server challenged anyway: the credentials were rejected (most likely a stale token). */
  | 'rejected'
  | null;

export const oauthPromptKind = ({
  oauthRequired,
  status,
  dismissed,
  authType,
}: {
  oauthRequired?: boolean;
  status: string;
  dismissed: boolean;
  /** The type of the request's Auth tab (`none`, `bearer`, ...), or undefined when it is empty. */
  authType?: string;
}): OAuthPromptKind => {
  if (!oauthRequired || dismissed || status !== 'error') {
    return null;
  }
  return authType === undefined || authType === 'none' ? 'sign-in' : 'rejected';
};

/** The sentence for the banner, in plain language. `xaa` is true when the server's authorization server accepts ID-JAGs. */
export const oauthPromptText = (kind: Exclude<OAuthPromptKind, null>, xaa: boolean): string => {
  if (kind === 'sign-in') {
    return xaa
      ? 'This server asked for OAuth, and its authorization server supports enterprise-managed authorization (XAA). Sign in through your company identity provider, or discover standard OAuth?'
      : 'This server asked for OAuth. Want Insomnia to discover how to sign in?';
  }
  return xaa
    ? 'This server asked for OAuth again: the credentials this request sends were rejected, most likely an expired or revoked token. Get a fresh one through your company identity provider (XAA), or with standard OAuth?'
    : 'This server asked for OAuth again: the credentials this request sends were rejected, most likely an expired or revoked token. Want to get a fresh one?';
};

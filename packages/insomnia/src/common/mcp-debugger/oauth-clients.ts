// Task 4348 S5: saved OAuth clients (a remembered registration: which client_id belongs to which issuer). Pure helpers so
// the wizard and its tests share one definition. PROTOTYPE-MOCK: stored on the request (`McpRequest.oauthClients`).

export interface SavedOAuthClient {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
}

export const clientsForIssuer = (clients: SavedOAuthClient[] | undefined, issuer: string | undefined) =>
  (clients ?? []).filter(client => client.issuer === issuer);

/** Adds a client, or renames the existing entry for the same issuer and client_id (no duplicates). */
export const saveClient = (
  clients: SavedOAuthClient[] | undefined,
  next: { name: string; issuer: string; clientId: string },
  newId: () => string,
): SavedOAuthClient[] => {
  const list = clients ?? [];
  const name = next.name.trim() || 'OAuth client';
  const existing = list.find(client => client.issuer === next.issuer && client.clientId === next.clientId);
  return existing
    ? list.map(client => (client === existing ? { ...client, name } : client))
    : [...list, { id: newId(), name, issuer: next.issuer, clientId: next.clientId }];
};

export const forgetClient = (clients: SavedOAuthClient[] | undefined, id: string) =>
  (clients ?? []).filter(client => client.id !== id);

export const isClientSaved = (
  clients: SavedOAuthClient[] | undefined,
  issuer: string | undefined,
  clientId: string | undefined,
) => !!clientId && (clients ?? []).some(client => client.issuer === issuer && client.clientId === clientId);

import { monthsBetween, NEWEST_VERSION } from './conformance';
import { type McpDebuggerTabId, PROFILES } from './profiles';
import { eraOfVersion, type McpProtocolVersion } from './versions';

// Task 4348 S7c: deprecation and age badges. Everything is derived from the version profiles we already keep (what each
// protocol version has), so there is one source of truth and nothing to keep in step by hand. Visual only.
// PROTOTYPE-MOCK: "not in the newest version" is what the profile says Insomnia shows for 2026-07-28; it is not a claim
// that the spec removed the feature (some have stateless replacements), so the wording says "not in", never "removed".

/** Panels the older (session-era) versions have that the newest version's profile does not. */
export const isLegacyOnlyTab = (tab: McpDebuggerTabId): boolean => !PROFILES[NEWEST_VERSION].tabs.includes(tab);

export type VersionTone = 'newest' | 'older' | 'deprecated';
export interface VersionBadge {
  tone: VersionTone;
  /** Short label for a chip. */
  label: string;
  tooltip: string;
  monthsBehind: number;
}

/** How a protocol version compares with the newest we know, in words a developer can act on. */
export const versionBadge = (version: McpProtocolVersion): VersionBadge => {
  const monthsBehind = monthsBetween(version, NEWEST_VERSION);
  if (version === NEWEST_VERSION) {
    return { tone: 'newest', label: 'Newest', tooltip: `${version} is the newest protocol version Insomnia supports.`, monthsBehind };
  }
  const era = eraOfVersion(version) === 'session' ? 'It is a session-era version: it uses an initialize handshake and a session id, and has panels (Roots, Sampling, Logging, Ping) that the newest version does not.' : '';
  if (version === '2024-11-05') {
    return {
      tone: 'deprecated',
      label: 'Deprecated',
      tooltip: `${version} is about ${monthsBehind} months behind ${NEWEST_VERSION}, and its HTTP+SSE transport is deprecated in favor of Streamable HTTP. ${era} Run Validate Server for details.`,
      monthsBehind,
    };
  }
  return {
    tone: 'older',
    label: 'Older spec',
    tooltip: `${version} is about ${monthsBehind} months behind ${NEWEST_VERSION}. ${era} Run Validate Server to see what this server is missing.`,
    monthsBehind,
  };
};

/** Annotation for a version picker entry. */
export const versionPickerNote = (version: McpProtocolVersion): string | null => {
  if (version === NEWEST_VERSION) {
    return 'newest';
  }
  return version === '2024-11-05' ? 'deprecated (HTTP+SSE)' : 'session-era';
};

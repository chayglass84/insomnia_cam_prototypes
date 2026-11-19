import type { Invocation, JSONSchema } from "../Protocol";

/** One elicitation request as delivered inside an input_required result (MCP `elicitation/create`). */
export interface ElicitationRequest {
  method: "elicitation/create";
  params: {
    mode?: "form" | "url";
    message?: string;
    requestedSchema?: JSONSchema;
    url?: string;
  };
}

/** Typed shape of a stateless-RC `input_required` result (MCP multi-round-trip request). */
export interface InputRequiredResult {
  resultType: "input_required";
  /** Keyed set of pending requests; keys are echoed back in `inputResponses`. */
  inputRequests: Record<string, ElicitationRequest>;
  /** Opaque server state. Echoed back verbatim; never parsed, mutated, or persisted. */
  requestState: unknown;
}

/** One user response per MCP's three-action model. `content` is present only for `accept`. */
export interface ElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/** Keyed responses matching the `inputRequests` keys. */
export type InputResponses = Record<string, ElicitationResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow a raw invocation result to a typed `InputRequiredResult`, or null if it isn't one.
 * Requires the exact snake_case `resultType: "input_required"` and a keyed `inputRequests`
 * object (the camelCase spelling is a normal result and must not trigger the loop).
 */
export function parseInputRequired(result: unknown): InputRequiredResult | null {
  if (!isRecord(result)) return null;
  if (result.resultType !== "input_required") return null;
  if (!isRecord(result.inputRequests)) return null;
  return {
    resultType: "input_required",
    inputRequests: result.inputRequests as Record<string, ElicitationRequest>,
    requestState: result.requestState,
  };
}

/**
 * Build the resubmission invocation: the same original call with `inputResponses` and the
 * echoed `requestState` added at the top level of `params` (symmetric with how the result
 * delivers them at the top level of `result`). Carries the originating `correlationId` so the
 * protocol threads the resubmission under that one pending row. The wire `_meta` is added later
 * by prepareCall.
 */
export function buildElicitationContinuation(
  original: Invocation,
  inputResponses: InputResponses,
  requestState: unknown,
  correlationId: string,
): Invocation {
  const base = isRecord(original.params) ? original.params : {};
  return {
    method: original.method,
    correlationId,
    params: { ...base, inputResponses, requestState },
  };
}

import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import React, { type FC, useRef, useState } from 'react';
import { Button } from 'react-aria-components';

import type {
  ElicitationRequest,
  ElicitationResponse,
  InputRequiredResult,
  InputResponses,
} from '~/common/mcp-debugger/protocol/mcp/elicitation';
import { InsomniaRjsfForm, type InsomniaRjsfFormHandle } from '~/ui/components/rjsf';

// Task 4348 S4: the multi round-trip request (SEP-2322, stateless 2026-07-28) form. A server answers a call with
// `resultType: "input_required"`; the user fills in each keyed request here and the call is retried with the answers.
// Ported from Ardi's InputRequiredDetail / elicitationForm / inputRequestFields, restyled with the app's form.

const COMPOSITION_KEYWORDS = ['oneOf', 'anyOf', 'allOf', '$ref'];
const noSubmitUiSchema: UiSchema = { 'ui:submitButtonOptions': { norender: true } };

/** A url-mode request sends the user out of band; we show the URL read-only and never submit an answer for it. */
export const isUrlModeRequest = (request: ElicitationRequest) =>
  request.params.mode === 'url' || typeof request.params.url === 'string';

/** A flat object schema the form can render; composition, empty or non-object schemas fall back to raw JSON. */
export const isFlatObjectSchema = (schema?: { type?: string; properties?: object }) =>
  Boolean(
    schema &&
      schema.type === 'object' &&
      schema.properties &&
      Object.keys(schema.properties).length > 0 &&
      !COMPOSITION_KEYWORDS.some(k => k in schema),
  );

export const hasUrlModeRequest = (inputRequests: Record<string, ElicitationRequest>) =>
  Object.values(inputRequests).some(isUrlModeRequest);

/** Merge the per-request answers for an accept: form values as-is, raw-JSON textareas parsed (naming a bad key). */
export const mergeAnswers = (
  requestKeys: string[],
  values: Record<string, Record<string, unknown>>,
  rawJson: Record<string, string>,
): { ok: true; content: Record<string, Record<string, unknown>> } | { ok: false; error: string } => {
  const merged = { ...values };
  for (const key of requestKeys) {
    if (rawJson[key] === undefined) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson[key]);
    } catch {
      return { ok: false, error: `Answer for "${key}" is not valid JSON.` };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: `Answer for "${key}" must be a JSON object.` };
    }
    merged[key] = parsed as Record<string, unknown>;
  }
  return { ok: true, content: merged };
};

/** The keyed `inputResponses` for one action; `content` is attached only for accept. */
export const assembleInputResponses = (
  requestKeys: string[],
  action: ElicitationResponse['action'],
  contentByKey: Record<string, Record<string, unknown>>,
): InputResponses =>
  Object.fromEntries(
    requestKeys.map(key => [key, action === 'accept' ? { action, content: contentByKey[key] ?? {} } : { action }]),
  );

const buttonClass = 'rounded-sm px-(--padding-md) py-1 text-xs';

export const InputRequiredResponder: FC<{
  prompt: InputRequiredResult;
  onSubmit: (inputResponses: InputResponses) => void;
  /** Tasks only take answers (a task is cancelled with Cancel task), so hide Decline/Cancel. */
  acceptOnly?: boolean;
  title?: string;
}> = ({ prompt, onSubmit, acceptOnly, title = 'The server needs more input to finish this call' }) => {
  const requestKeys = Object.keys(prompt.inputRequests);
  const [values, setValues] = useState<Record<string, Record<string, unknown>>>({});
  const [rawJson, setRawJson] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const formRefs = useRef<Record<string, InsomniaRjsfFormHandle | null>>({});
  const hasUrlMode = hasUrlModeRequest(prompt.inputRequests);

  const submit = (action: ElicitationResponse['action']) => {
    setError(null);
    let content = values;
    if (action === 'accept') {
      const flatInvalid = requestKeys.some(key => {
        const request = prompt.inputRequests[key];
        return isFlatObjectSchema(request.params.requestedSchema) && !formRefs.current[key]?.validate();
      });
      if (flatInvalid) {
        return;
      }
      const merged = mergeAnswers(requestKeys, values, rawJson);
      if (!merged.ok) {
        setError(merged.error);
        return;
      }
      content = merged.content;
    }
    setSubmitted(true);
    onSubmit(assembleInputResponses(requestKeys, action, content));
  };

  return (
    <section
      className="flex flex-col gap-3 rounded-xs border border-solid border-amber-500/60 bg-amber-500/5 p-2"
      data-testid="mcp-input-required"
    >
      <h4 className="text-xs font-bold text-amber-500 uppercase">{title}</h4>
      <fieldset disabled={submitted} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
        {requestKeys.map(key => {
          const request = prompt.inputRequests[key];
          const schema = request.params.requestedSchema;
          return (
            <div key={key} className="flex flex-col gap-2">
              {request.params.message && <p className="text-sm">{request.params.message}</p>}
              {isUrlModeRequest(request) ? (
                <div className="flex flex-col gap-1 rounded-xs border border-solid border-(--hl-md) p-2 text-xs">
                  <p className="text-(--hl)">This server is requesting an out-of-band interaction at:</p>
                  <code className="break-all">{request.params.url ?? '(no URL provided)'}</code>
                  <p className="text-(--hl)">
                    URL mode isn&apos;t handled here. Decline or cancel, then complete it directly with the server if you trust the URL.
                  </p>
                </div>
              ) : isFlatObjectSchema(schema) ? (
                <InsomniaRjsfForm
                  ref={handle => {
                    formRefs.current[key] = handle;
                  }}
                  formData={values[key] ?? {}}
                  onChange={data => setValues(v => ({ ...v, [key]: data }))}
                  schema={schema as RJSFSchema}
                  uiSchema={noSubmitUiSchema}
                  showErrorList={false}
                  focusOnFirstError
                />
              ) : (
                <textarea
                  aria-label={`Answer for ${key}`}
                  className="min-h-24 w-full rounded-xs border border-solid border-(--hl-md) bg-transparent p-2 font-mono text-xs"
                  placeholder="Enter answer as JSON"
                  value={rawJson[key] ?? ''}
                  onChange={e => setRawJson(r => ({ ...r, [key]: e.target.value }))}
                />
              )}
            </div>
          );
        })}
      </fieldset>
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        {!hasUrlMode && (
          <Button
            className={`${buttonClass} bg-(--color-surprise) text-(--color-font-surprise) hover:brightness-75`}
            isDisabled={submitted}
            onPress={() => submit('accept')}
            data-testid="mcp-mrtr-submit"
          >
            Submit
          </Button>
        )}
        {!acceptOnly && (
          <>
            <Button
              className={`${buttonClass} border border-solid border-(--hl-md) hover:bg-(--hl-sm)`}
              isDisabled={submitted}
              onPress={() => submit('decline')}
            >
              Decline
            </Button>
            <Button
              className={`${buttonClass} border border-solid border-(--hl-md) hover:bg-(--hl-sm)`}
              isDisabled={submitted}
              onPress={() => submit('cancel')}
            >
              Cancel
            </Button>
          </>
        )}
      </div>
    </section>
  );
};

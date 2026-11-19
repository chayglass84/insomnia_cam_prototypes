import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import React, { type FC, useRef, useState } from 'react';
import { Button } from 'react-aria-components';

import { InsomniaRjsfForm, type InsomniaRjsfFormHandle } from '~/ui/components/rjsf';

import { JsonView } from './json-view';
import { PrototypeMock } from './prototype-mock';

// Task 4348 S3: answer server-initiated requests (session-era servers ask the client mid-call). Borrowed from the old MCP
// client's elicitation-form.tsx / sampling-form.tsx: same fields and buttons, but they now return the JSON-RPC result
// through mcpDebugger.respondPeerRequest instead of the old SDK client's IPC.

export type ServerRequestOutcome = { result: unknown } | { error: { code: number; message: string } };

const noSubmitUiSchema: UiSchema = { 'ui:submitButtonOptions': { norender: true } };
const buttonClass = 'rounded-sm px-(--padding-md) py-1 text-xs';
const primaryButton = `${buttonClass} bg-(--color-surprise) text-(--color-font-surprise) hover:brightness-75`;
const secondaryButton = `${buttonClass} border border-solid border-(--hl-md) hover:bg-(--hl-sm)`;

const Responder: FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section
    className="flex flex-col gap-2 rounded-xs border border-solid border-amber-500/60 bg-amber-500/5 p-2"
    data-testid="mcp-server-request-responder"
  >
    <h4 className="text-xs font-bold text-amber-500 uppercase">{title}</h4>
    {children}
  </section>
);

export const ElicitationResponder: FC<{
  params: { message?: string; requestedSchema?: RJSFSchema } | undefined;
  onRespond: (outcome: ServerRequestOutcome) => void;
}> = ({ params, onRespond }) => {
  const formRef = useRef<InsomniaRjsfFormHandle>(null);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const schema = (params?.requestedSchema ?? { type: 'object', properties: {} }) as RJSFSchema;
  return (
    <Responder title="The server is asking for input (elicitation)">
      {params?.message && <p className="text-sm">{params.message}</p>}
      <InsomniaRjsfForm
        formData={formData}
        onChange={setFormData}
        schema={schema}
        uiSchema={noSubmitUiSchema}
        ref={formRef}
        showErrorList={false}
        focusOnFirstError
      />
      <div className="flex gap-2">
        <Button
          className={primaryButton}
          data-testid="mcp-elicit-submit"
          onPress={() => {
            if (formRef.current?.validate()) {
              onRespond({ result: { action: 'accept', content: formData } });
            }
          }}
        >
          Submit
        </Button>
        <Button className={secondaryButton} onPress={() => onRespond({ result: { action: 'decline' } })}>
          Decline
        </Button>
        <Button className={secondaryButton} onPress={() => onRespond({ result: { action: 'cancel' } })}>
          Cancel
        </Button>
      </div>
    </Responder>
  );
};

const samplingSchema: RJSFSchema = {
  type: 'object',
  properties: {
    content: { type: 'string', description: 'The message the model would have generated.' },
    role: { type: 'string', enum: ['user', 'assistant'], default: 'assistant' },
    model: { type: 'string', default: 'insomnia-manual' },
    stopReason: { type: 'string', enum: ['endTurn', 'stopSequence', 'maxTokens'], default: 'endTurn' },
  },
  required: ['content', 'model', 'role'],
};
const samplingUiSchema: UiSchema = { ...noSubmitUiSchema, content: { 'ui:widget': 'textarea' } };

export const SamplingResponder: FC<{
  params: unknown;
  onRespond: (outcome: ServerRequestOutcome) => void;
}> = ({ params, onRespond }) => {
  const formRef = useRef<InsomniaRjsfFormHandle>(null);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  return (
    <Responder title="The server is asking you to generate a message (sampling)">
      <JsonView value={params} />
      <InsomniaRjsfForm
        formData={formData}
        onChange={setFormData}
        schema={samplingSchema}
        uiSchema={samplingUiSchema}
        ref={formRef}
        showErrorList={false}
        focusOnFirstError
      />
      <div className="flex gap-2">
        <Button
          className={primaryButton}
          data-testid="mcp-sampling-submit"
          onPress={() => {
            if (!formRef.current?.validate()) {
              return;
            }
            const { content, role, model, stopReason } = formData as {
              content: string;
              role: string;
              model: string;
              stopReason?: string;
            };
            onRespond({ result: { role, content: { type: 'text', text: content }, model, ...(stopReason ? { stopReason } : {}) } });
          }}
        >
          Submit
        </Button>
        <Button
          className={secondaryButton}
          onPress={() => onRespond({ error: { code: -1, message: 'User rejected sampling request' } })}
        >
          Reject
        </Button>
      </div>
      <PrototypeMock inline={false} reason="The old client could also draft this answer with AI. That helper is not ported." />
    </Responder>
  );
};

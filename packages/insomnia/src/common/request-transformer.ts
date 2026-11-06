// Prototype (3593AI): turns a Kong `request-transformer` plugin config into a readable, ordered list of changes
// (Config tab of the Request Transformer modal), and is the parsed form the Preview tab will later apply.
//
// Config shape (Kong docs): { http_method, remove|rename|replace|add|append: { headers, querystring, body, uri? }, allow: { body } }.
// Entries are "name:value" (rename: "old:new"); only the FIRST ':' separates, so values may contain colons.
// PROTOTYPE SHORTCUT: values containing a `$(...)` template are flagged, never evaluated.

export type TransformOp = 'allow' | 'remove' | 'rename' | 'replace' | 'add' | 'append';
export type TransformTarget = 'headers' | 'querystring' | 'body' | 'uri' | 'method';

export interface TransformChange {
  op: TransformOp;
  target: TransformTarget;
  /** Header/param/field name; for `rename` the OLD name; empty for uri/method. */
  name: string;
  /** New value (`add`/`append`/`replace`/method/uri) or NEW name (`rename`); undefined for `remove`/`allow`. */
  value?: string;
  /** True when `value` contains a `$(...)` template, so it can't be previewed. */
  template: boolean;
}

/** Kong applies the operations in this order (`allow` first, for the body). */
export const TRANSFORM_OP_ORDER: TransformOp[] = ['allow', 'remove', 'rename', 'replace', 'add', 'append'];
export const TRANSFORM_TARGET_LABELS: Record<TransformTarget, string> = {
  method: 'Method',
  uri: 'URI',
  headers: 'Headers',
  querystring: 'Query string',
  body: 'Body',
};
const TARGET_ORDER: TransformTarget[] = ['method', 'uri', 'headers', 'querystring', 'body'];

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const splitEntry = (entry: string): [string, string | undefined] => {
  const i = entry.indexOf(':');
  return i === -1 ? [entry, undefined] : [entry.slice(0, i), entry.slice(i + 1)];
};

/** Every change the plugin makes, in the order Kong applies them (grouping by target is the UI's job). */
export function parseRequestTransformer(config: Record<string, unknown>): TransformChange[] {
  const changes: TransformChange[] = [];
  const push = (op: TransformOp, target: TransformTarget, name: string, value?: string) =>
    changes.push({ op, target, name, value, template: value?.includes('$(') ?? false });

  for (const op of TRANSFORM_OP_ORDER) {
    const section = asRecord(config[op]);
    for (const target of ['headers', 'querystring', 'body'] as const) {
      for (const entry of asList(section[target])) {
        if (op === 'remove' || op === 'allow') {
          push(op, target, entry);
        } else {
          const [name, value] = splitEntry(entry);
          push(op, target, name, value ?? '');
        }
      }
    }
    if (op === 'replace' && typeof section.uri === 'string' && section.uri) {
      push('replace', 'uri', '', section.uri);
    }
  }
  if (typeof config.http_method === 'string' && config.http_method) {
    push('replace', 'method', '', config.http_method);
  }
  return changes;
}

/** Changes grouped by target (in display order), each group keeping Kong's operation order. */
export function groupTransformChanges(
  changes: TransformChange[],
): { target: TransformTarget; changes: TransformChange[] }[] {
  return TARGET_ORDER.map(target => ({ target, changes: changes.filter(c => c.target === target) })).filter(
    g => g.changes.length > 0,
  );
}

/** One short line for the plugin bar, e.g. "Changes: 5 headers, 2 params". Null when the plugin changes nothing. */
export function summarizeRequestTransformer(config: Record<string, unknown>): string | null {
  const changes = parseRequestTransformer(config);
  if (changes.length === 0) {
    return null;
  }
  const noun: Record<TransformTarget, [string, string]> = {
    headers: ['header', 'headers'],
    querystring: ['param', 'params'],
    body: ['body field', 'body fields'],
    uri: ['URI', 'URI'],
    method: ['method', 'method'],
  };
  const parts = groupTransformChanges(changes).map(({ target, changes: group }) => {
    const [one, many] = noun[target];
    return target === 'uri' || target === 'method' ? one : `${group.length} ${group.length === 1 ? one : many}`;
  });
  return `Changes: ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Preview: apply the parsed changes to a request and diff before/after.
// PROTOTYPE SHORTCUTS: only THIS plugin's changes; the request is the saved one (Insomnia adds User-Agent, Accept, Host
// etc. when sending, so those are absent here); `{{ }}` templates are not rendered; `$(...)` values are kept as text;
// body support is a top-level JSON object (values stay strings); body `append` is approximate.
// ---------------------------------------------------------------------------------------------------------------

export interface PreviewRequest {
  method: string;
  url: string;
  headers: { name: string; value: string; disabled?: boolean }[];
  parameters: { name: string; value: string; disabled?: boolean }[];
  bodyText?: string;
}

export interface PreviewRow {
  target: TransformTarget;
  kind: 'added' | 'removed' | 'changed';
  name: string;
  before?: string;
  after?: string;
  template: boolean;
}

export interface PreviewResult {
  rows: PreviewRow[];
  /** Things the preview could not or did not do, shown under the diff. */
  notes: string[];
}

interface Pair {
  name: string;
  value: string;
}

const lowerEq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Header/param rules (`nameEq` is case-insensitive for headers, exact for query params). */
function applyPairs(pairs: Pair[], changes: TransformChange[], nameEq: (a: string, b: string) => boolean): Pair[] {
  let out = pairs.map(p => ({ ...p }));
  for (const c of changes) {
    const has = out.some(p => nameEq(p.name, c.name));
    switch (c.op) {
      case 'remove': {
        out = out.filter(p => !nameEq(p.name, c.name));
        break;
      }
      case 'rename': {
        out = out.map(p => (nameEq(p.name, c.name) ? { ...p, name: c.value ?? p.name } : p));
        break;
      }
      case 'replace': {
        if (has) {
          out = out.map(p => (nameEq(p.name, c.name) ? { ...p, value: c.value ?? '' } : p));
        }
        break;
      }
      case 'add': {
        if (!has) {
          out.push({ name: c.name, value: c.value ?? '' });
        }
        break;
      }
      case 'append': {
        out.push({ name: c.name, value: c.value ?? '' });
        break;
      }
      default: {
        break;
      }
    }
  }
  return out;
}

function applyBody(body: Record<string, unknown>, changes: TransformChange[]): Record<string, unknown> {
  let out: Record<string, unknown> = { ...body };
  for (const c of changes) {
    const has = c.name in out;
    switch (c.op) {
      case 'allow': {
        out = Object.fromEntries(
          Object.entries(out).filter(([k]) => changes.some(x => x.op === 'allow' && x.name === k)),
        );
        break;
      }
      case 'remove': {
        delete out[c.name];
        break;
      }
      case 'rename': {
        if (has && c.value) {
          out[c.value] = out[c.name];
          delete out[c.name];
        }
        break;
      }
      case 'replace': {
        if (has) {
          out[c.name] = c.value ?? '';
        }
        break;
      }
      case 'add': {
        if (!has) {
          out[c.name] = c.value ?? '';
        }
        break;
      }
      case 'append': {
        out[c.name] = has
          ? [...(Array.isArray(out[c.name]) ? (out[c.name] as unknown[]) : [out[c.name]]), c.value ?? '']
          : [c.value ?? ''];
        break;
      }
      default: {
        break;
      }
    }
  }
  return out;
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** Name-level diff of two pair lists: removed names, added names, and names whose values changed. */
function diffPairs(target: TransformTarget, before: Pair[], after: Pair[]): PreviewRow[] {
  const rows: PreviewRow[] = [];
  const key = (p: Pair) => (target === 'headers' ? p.name.toLowerCase() : p.name);
  const values = (list: Pair[]) => {
    const m = new Map<string, { name: string; values: string[] }>();
    for (const p of list) {
      const e = m.get(key(p)) ?? { name: p.name, values: [] };
      e.values.push(p.value);
      m.set(key(p), e);
    }
    return m;
  };
  const b = values(before);
  const a = values(after);
  for (const [k, e] of b) {
    const next = a.get(k);
    if (!next) {
      rows.push({ target, kind: 'removed', name: e.name, before: e.values.join(', '), template: false });
    } else if (next.values.join('\u0000') !== e.values.join('\u0000')) {
      rows.push({
        target,
        kind: 'changed',
        name: next.name,
        before: e.values.join(', '),
        after: next.values.join(', '),
        template: next.values.some(v => v.includes('$(')),
      });
    }
  }
  for (const [k, e] of a) {
    if (!b.has(k)) {
      rows.push({
        target,
        kind: 'added',
        name: e.name,
        after: e.values.join(', '),
        template: e.values.some(v => v.includes('$(')),
      });
    }
  }
  return rows;
}

export function previewRequestTransformer(config: Record<string, unknown>, request: PreviewRequest): PreviewResult {
  const changes = parseRequestTransformer(config);
  const rows: PreviewRow[] = [];
  const notes: string[] = [];
  const by = (target: TransformTarget) => changes.filter(c => c.target === target);

  const enabled = (list: PreviewRequest['headers']) =>
    list.filter(p => !p.disabled && p.name).map(({ name, value }) => ({ name, value }));

  const headerChanges = by('headers');
  if (headerChanges.length > 0) {
    const before = enabled(request.headers);
    rows.push(...diffPairs('headers', before, applyPairs(before, headerChanges, lowerEq)));
  }
  const queryChanges = by('querystring');
  if (queryChanges.length > 0) {
    const before = enabled(request.parameters);
    rows.push(
      ...diffPairs(
        'querystring',
        before,
        applyPairs(before, queryChanges, (x, y) => x === y),
      ),
    );
  }

  const bodyChanges = by('body');
  if (bodyChanges.length > 0) {
    let parsed: unknown;
    try {
      parsed = request.bodyText ? JSON.parse(request.bodyText) : undefined;
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const before = Object.entries(parsed as Record<string, unknown>).map(([name, value]) => ({
        name,
        value: show(value),
      }));
      const afterObj = applyBody(parsed as Record<string, unknown>, bodyChanges);
      const after = Object.entries(afterObj).map(([name, value]) => ({ name, value: show(value) }));
      rows.push(...diffPairs('body', before, after));
      if (bodyChanges.some(c => c.op === 'append')) {
        notes.push('Body "append" is approximated.');
      }
    } else {
      notes.push("Body rules not previewed: the request body isn't a JSON object.");
    }
  }

  const uriChange = by('uri')[0];
  if (uriChange?.value) {
    let path = request.url;
    try {
      path = new URL(request.url).pathname;
    } catch {
      // Templated or relative URL: show it as written.
    }
    rows.push({
      target: 'uri',
      kind: 'changed',
      name: '',
      before: path,
      after: uriChange.value,
      template: uriChange.template,
    });
  }
  const methodChange = by('method')[0];
  if (methodChange?.value && methodChange.value.toUpperCase() !== request.method.toUpperCase()) {
    rows.push({
      target: 'method',
      kind: 'changed',
      name: '',
      before: request.method,
      after: methodChange.value,
      template: false,
    });
  }

  if (changes.length > 0 && rows.length === 0 && notes.length === 0) {
    notes.push('These rules make no difference to this request.');
  }
  if (changes.some(c => c.target === 'headers')) {
    notes.push(
      'Uses the headers saved on the request. Insomnia adds a few more when sending (User-Agent, Accept, Host).',
    );
  }
  if (changes.some(c => c.template)) {
    notes.push('Values marked (template) are filled in by Kong from the live request, so they are shown as written.');
  }
  return { rows, notes };
}

// ---------------------------------------------------------------------------------------------------------------
// cURL preview: the request rendered as a cURL command with this plugin's changes marked line by line.
// PROTOTYPE SHORTCUT: a display format, not guaranteed runnable (query params are not URL-encoded, a templated URL
// is shown as written, long non-JSON bodies are cut off).
// ---------------------------------------------------------------------------------------------------------------

export type CurlKind = 'same' | 'added' | 'removed';
export interface CurlSegment {
  text: string;
  kind: CurlKind;
}
export interface CurlLine {
  /** 'changed' = the line stays but part of it changed (method, URL). */
  kind: CurlKind | 'changed';
  segments: CurlSegment[];
}

/** Pairs in `before` that survive stay 'same', the rest are 'removed', then pairs only in `after` are 'added'. */
function markPairs(
  before: Pair[],
  after: Pair[],
  nameEq: (a: string, b: string) => boolean,
): { pair: Pair; kind: CurlKind }[] {
  const remaining = [...after];
  const out: { pair: Pair; kind: CurlKind }[] = [];
  for (const b of before) {
    const i = remaining.findIndex(a => nameEq(a.name, b.name) && a.value === b.value);
    if (i === -1) {
      out.push({ pair: b, kind: 'removed' });
    } else {
      remaining.splice(i, 1);
      out.push({ pair: b, kind: 'same' });
    }
  }
  return [...out, ...remaining.map(pair => ({ pair, kind: 'added' as const }))];
}

export function buildCurlPreview(
  config: Record<string, unknown>,
  request: PreviewRequest,
): { lines: CurlLine[]; notes: string[] } {
  const changes = parseRequestTransformer(config);
  const by = (target: TransformTarget) => changes.filter(c => c.target === target);
  const enabled = (list: PreviewRequest['headers']) =>
    list.filter(p => !p.disabled && p.name).map(({ name, value }) => ({ name, value }));
  const seg = (text: string, kind: CurlKind = 'same'): CurlSegment => ({ text, kind });
  const lineOf = (kind: CurlLine['kind'], ...segments: CurlSegment[]): CurlLine => ({ kind, segments });
  const kindOf = (segments: CurlSegment[]): CurlLine['kind'] =>
    segments.every(x => x.kind === 'same') ? 'same' : 'changed';

  // Each entry: the line, and whether it ends a shell statement (so it needs a trailing backslash if more follows).
  const out: { line: CurlLine; ends: boolean }[] = [];
  const push = (line: CurlLine, ends: boolean) => out.push({ line, ends });

  // curl --request METHOD
  const newMethod = by('method')[0]?.value;
  const methodSegs =
    newMethod && newMethod.toUpperCase() !== request.method.toUpperCase()
      ? [seg('curl --request '), seg(request.method, 'removed'), seg(` ${newMethod}`, 'added')]
      : [seg(`curl --request ${request.method}`)];
  push(lineOf(kindOf(methodSegs), ...methodSegs), true);

  // --url 'origin/path?query'
  let origin = '';
  let path = request.url;
  let urlParams: Pair[] = [];
  try {
    const u = new URL(request.url);
    origin = u.origin;
    path = u.pathname;
    urlParams = [...u.searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    // Templated or relative URL: shown as written, path rewrites can't be marked.
  }
  const beforeParams = [...urlParams, ...enabled(request.parameters)];
  const queryChanges = by('querystring');
  const paramMarks = markPairs(
    beforeParams,
    applyPairs(beforeParams, queryChanges, (a, b) => a === b),
    (a, b) => a === b,
  );
  const newPath = by('uri')[0]?.value;
  const urlSegs: CurlSegment[] = [seg(`  --url '${origin}`)];
  if (newPath && newPath !== path) {
    urlSegs.push(seg(path, 'removed'), seg(newPath, 'added'));
  } else {
    urlSegs.push(seg(path));
  }
  paramMarks.forEach((m, i) => urlSegs.push(seg(`${i === 0 ? '?' : '&'}${m.pair.name}=${m.pair.value}`, m.kind)));
  urlSegs.push(seg("'"));
  push(lineOf(kindOf(urlSegs), ...urlSegs), true);

  // --header 'Name: value'
  const headerChanges = by('headers');
  const beforeHeaders = enabled(request.headers);
  for (const m of markPairs(beforeHeaders, applyPairs(beforeHeaders, headerChanges, lowerEq), lowerEq)) {
    push(lineOf(m.kind, seg(`  --header '${m.pair.name}: ${m.pair.value}'`, m.kind)), true);
  }

  // --data '...'
  const bodyText = request.bodyText?.trim();
  if (bodyText) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const toPairs = (o: Record<string, unknown>) =>
        Object.entries(o).map(([name, value]) => ({ name, value: JSON.stringify(value) }));
      const before = toPairs(parsed as Record<string, unknown>);
      const after = toPairs(applyBody(parsed as Record<string, unknown>, by('body')));
      const marks = markPairs(before, after, (a, b) => a === b);
      const lastVisible = marks.map(m => m.kind !== 'removed').lastIndexOf(true);
      push(lineOf('same', seg("  --data '{")), false);
      marks.forEach((m, i) => {
        const comma = m.kind !== 'removed' && i < lastVisible ? ',' : '';
        push(lineOf(m.kind, seg(`    ${JSON.stringify(m.pair.name)}: ${m.pair.value}${comma}`, m.kind)), false);
      });
      push(lineOf('same', seg("  }'")), true);
    } else {
      const shown = bodyText.length > 200 ? `${bodyText.slice(0, 200)}…` : bodyText;
      push(lineOf('same', seg(`  --data '${shown}'`)), true);
    }
  }

  // Trailing backslashes: every statement end that is still in the command, except the very last one.
  const visibleEnds = out.map((e, i) => (e.ends && e.line.kind !== 'removed' ? i : -1)).filter(i => i >= 0);
  const lastEnd = visibleEnds[visibleEnds.length - 1];
  const lines = out.map((e, i) =>
    e.ends && e.line.kind !== 'removed' && i !== lastEnd
      ? { ...e.line, segments: [...e.line.segments, seg(' \\', e.line.kind === 'added' ? 'added' : 'same')] }
      : e.line,
  );
  return { lines, notes: previewRequestTransformer(config, request).notes };
}

/** Adapts a saved Insomnia request to what the preview needs. */
export const toPreviewRequest = (r: {
  method: string;
  url: string;
  headers: PreviewRequest['headers'];
  parameters: PreviewRequest['parameters'];
  body?: { text?: string };
}): PreviewRequest => ({
  method: r.method,
  url: r.url,
  headers: r.headers,
  parameters: r.parameters,
  bodyText: r.body?.text,
});

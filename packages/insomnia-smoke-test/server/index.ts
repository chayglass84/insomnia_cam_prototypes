import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import type { Duplex } from 'node:stream';

import * as bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createHandler } from 'graphql-http/lib/use/http';

interface GitBackendService {
  type: string;
  cmd: string;
  args: string[];
  createStream(): Duplex;
}
// git-http-backend has no @types package; require+cast is the standard workaround
const backend = require('git-http-backend') as (
  url: string,
  cb: (err: Error | null, service: GitBackendService) => void,
) => NodeJS.ReadWriteStream;

import { basicAuthRouter } from './basic-auth';
import cloudSyncApi from './cloud-sync-api';
import githubApi from './github-api';
import gitlabApi from './gitlab-api';
import { schema } from './graphql';
import { startGRPCServer } from './grpc';
import insomniaApi from './insomnia-api';
import { mtlsRouter } from './mtls';
import { oauthRoutes } from './oauth';
import simpleCrud from './simple-crud';
import { startSocketIOServer } from './socket-io';
import { startWebSocketServer } from './websocket';

const app = express();
app.use(cookieParser());
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path} ${new Date().toISOString()}`);
  next();
});
const port = 4010;
const httpsPort = 4011;
const grpcPort = 50_051;
const rawParser = bodyParser.raw({
  inflate: true,
  type: '*/*',
});

app.get('/pets/:id', (req, res) => {
  res.status(200).send({ id: req.params.id });
});

// Server-sent events: writes a couple of events and closes, so a test can assert the event-stream
// response pane without holding a connection open for the rest of the run.
app.get('/sse', (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: hello-from-sse-1\n\n');
  res.write('data: hello-from-sse-2\n\n');
  res.end();
});

// Anthropic Messages API streaming shape (message_start -> content_block_delta* -> message_delta
// -> message_stop), used to exercise the chat-completion bubble/summary UI against a real SSE
// response rather than a single JSON body. Path matches the real Anthropic Messages API exactly
// so the app's streaming-JSONPath auto-inference (keyed on pathname) kicks in with no manual setup.
// Mirrors the real API's behavior of only streaming when the body sets `"stream": true` — a
// request with an Accept: text/event-stream header but no body flag gets one normal, complete,
// non-SSE JSON reply instead, same as the real Anthropic API would send.
app.post('/v1/messages', rawParser, (req, res) => {
  let streamRequested = false;
  try {
    streamRequested = JSON.parse(req.body.toString() || '{}')?.stream === true;
  } catch {
    // ignore malformed bodies in this test fixture
  }
  if (!streamRequested) {
    res.json({
      id: 'msg_test_non_stream',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'Hello from mock Anthropic non-stream reply!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 8 },
    });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_test',
      model: 'claude-sonnet-5',
      role: 'assistant',
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  // `?reportThreading=1` (query string only — the pathname still matches exactly, so the app's
  // pathname-keyed streaming-JSONPath auto-inference still applies) reports how many assistant-role
  // turns and what the latest user turn were in the *request* body, so a test can confirm the
  // follow-up composer is actually threading prior replies back into the conversation instead of
  // resending it as consecutive user-only turns.
  if (req.query.reportThreading === '1') {
    let assistantTurns = 0;
    let lastUserContent = '';
    let system = '';
    let model = '';
    try {
      const body = JSON.parse(req.body.toString() || '{}');
      const messages = Array.isArray(body.messages) ? body.messages : [];
      assistantTurns = messages.filter((message: { role?: string }) => message.role === 'assistant').length;
      const userMessages = messages.filter((message: { role?: string }) => message.role === 'user');
      lastUserContent = userMessages[userMessages.length - 1]?.content ?? '';
      system = typeof body.system === 'string' ? body.system : '';
      model = typeof body.model === 'string' ? body.model : '';
    } catch {
      // ignore malformed bodies in this test fixture
    }
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: `assistantTurns=${assistantTurns} lastUser=${lastUserContent} system=${system} model=${model}`,
      },
    });
  } else if (req.query.longReply === '1') {
    // Enough lines to overflow the chat pane's visible height, so a test can confirm the message
    // list stays pinned to the bottom as it grows instead of leaving the user scrolled up.
    for (let i = 1; i <= 60; i++) {
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Line ${i}\n` } });
    }
  } else {
    for (const text of ['Hello', ' from', ' mock', ' Anthropic', ' stream!']) {
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    }
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
});

// Non-streaming Anthropic Messages API shape, echoing the last request message back so a test can
// confirm a follow-up reply actually triggered a fresh send (not just a stale cached response).
app.post('/v1/messages-sync', rawParser, (req, res) => {
  let lastMessage = '';
  try {
    const body = JSON.parse(req.body.toString() || '{}');
    lastMessage = body.messages?.[body.messages.length - 1]?.content ?? '';
  } catch {
    // ignore malformed bodies in this test fixture
  }
  res.json({
    id: 'msg_sync',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text: `Echo: ${lastMessage}` }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
  });
});

app.get('/large-json', (_req, res) => {
  const items = Array.from({ length: 100_000 }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    value: 'x'.repeat(100),
  }));
  res.status(200).json({ items });
});

app.get('/builds/check/*', (_req, res) => {
  res.status(200).send({
    url: 'https://github.com/Kong/insomnia/releases/download/core@2023.5.6/Insomnia.Core-2023.5.6.zip',
    name: '2099.1.0',
  });
});

async function echoHandler(req: any, res: any) {
  res.status(200).send({
    method: req.method,
    headers: req.headers,
    data: req.body.toString(),
    cookies: req.cookies,
  });
}

app.all('/echo', rawParser, echoHandler);

app.get('/sleep', (_req, res) => {
  res.status(200).send({ sleep: true });
});

app.get('/cookies', (_req, res) => {
  res
    .status(200)
    .header('content-type', 'text/plain')
    .cookie('insomnia-test-cookie', 'value123')
    .send(`${_req.headers['cookie']}`);
});

app.use('/file', express.static('fixtures/files'));
app.use('/auth/basic', basicAuthRouter);
app.use('/protected', mtlsRouter);

githubApi(app);
gitlabApi(app);
insomniaApi(app);
simpleCrud(app);
cloudSyncApi(app);

app.get('/delay/seconds/:duration', (req, res) => {
  const delaySec = Number.parseInt(req.params.duration || '2');
  setTimeout(() => {
    res.send(`Delayed by ${delaySec} seconds`);
  }, delaySec * 1000);
});

oauthRoutes(port).then(router => app.use('/oidc', router));

app.get('/', (_req, res) => {
  res.status(200).send();
});

app.all('/graphqlTest', createHandler({ schema }));

app.use(express.json()); // Used to parse JSON bodies

// SSE routes
let subscribers: { id: string; response: express.Response }[] = [];
app.get('/events', (request, response) => {
  const headers = {
    'Content-Type': 'text/event-stream',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
  };
  response.writeHead(200, headers);
  const subscriberId = crypto.randomUUID();
  const data = `data: ${JSON.stringify({ id: subscriberId })}\n\n`;
  response.write(data);
  const subscriber = {
    id: subscriberId,
    response,
  };
  subscribers.push(subscriber);
  setInterval(() => {
    // const id = subscriberId;
    const data = JSON.stringify({ message: 'Time: ' + new Date().toISOString().slice(11, 19) });
    // response.write('id: ' + id + '\n');
    response.write('data: ' + data + '\n\n');
  }, 1000);
  request.on('close', () => {
    console.log(`${subscriberId} Connection closed`);
    subscribers = subscribers.filter(sub => sub.id !== subscriberId);
  });
});
app.post('/send-event', (request, response) => {
  // Requires middleware to parse JSON body
  console.log('Received event', request.body);
  subscribers.forEach(subscriber => subscriber.response.write(`data: ${JSON.stringify(request.body)}\n\n`));
  response.json({ success: true });
});
// auto update endpoints, use INSOMNIA_UPDATES_URL=http://localhost:4010 npm run dev for testing
app.get('/builds/check/mac', (request, response) => {
  return response.json({
    url: 'https://github.com/Kong/insomnia/releases/download/core@11.6.1/Insomnia.Core-11.6.1.dmg',
    name: '11.6.1',
  });
});
app.get('/updates/win', (request, response) => {
  return response.json({
    url: 'https://github.com/Kong/insomnia/releases/download/core@11.6.1/Insomnia.Core-11.6.1.zip',
    name: '11.6.1',
  });
});
// mock endpoint for azure oauth config, used in external vault integration test
app.get('/v1/oauth/azure/config', (_req, res) => {
  res.status(200).send({
    clientID: 'test_client_id',
    clientRedirectURI: 'https://login.microsoftonline.com',
  });
});

const GIT_FIXTURE_ROOT = nodePath.join(__dirname, '../fixtures/git-repo');
let currentGitTmpDir: string | null = null;

// Create a fresh per-test copy of the git fixture repo
app.post('/v1/test-utils/git/setup', (_req, res) => {
  if (currentGitTmpDir && existsSync(currentGitTmpDir)) {
    rmSync(currentGitTmpDir, { recursive: true, force: true });
  }
  currentGitTmpDir = mkdtempSync(nodePath.join(tmpdir(), 'insomnia-git-'));
  cpSync(GIT_FIXTURE_ROOT, currentGitTmpDir, { recursive: true });
  res.json({ success: true });
});

// Remove the per-test copy
app.delete('/v1/test-utils/git/setup', (_req, res) => {
  if (currentGitTmpDir && existsSync(currentGitTmpDir)) {
    rmSync(currentGitTmpDir, { recursive: true, force: true });
  }
  currentGitTmpDir = null;
  res.json({ success: true });
});

// Git smart HTTP server backed by git-http-backend — accepts real pushes.
// Falls back to the fixture root if no per-test dir is set up.
app.use('/git', (req, res) => {
  const root = currentGitTmpDir ?? GIT_FIXTURE_ROOT;
  // req.url has the '/git' prefix stripped by Express, e.g. '/git-server.git/info/refs?...'
  const repoPath = nodePath.join(root, req.url.split('?')[0].split('/')[1]);

  req.pipe(
    backend(req.url, (err, service) => {
      if (err) {
        res.status(500).end(err.message);
        return;
      }
      res.setHeader('content-type', service.type);
      const ps = spawn(service.cmd, service.args.concat(repoPath), {
        env: { ...process.env, GIT_HTTP_EXPORT_ALL: '1' },
      });
      ps.stderr.on('data', d => console.error('[git]', String(d)));
      ps.stdout.pipe(service.createStream()).pipe(ps.stdin);
    }),
  ).pipe(res);
});

startWebSocketServer(
  app.listen(port, '::', () => {
    console.log(`Listening at http://localhost:${port}`);
    console.log(`Listening at http://127.0.0.1:${port}`);
    console.log(`Listening at http://[::1]:${port}`);
    console.log(`Listening at ws://localhost:${port}`);
  }),
);

startWebSocketServer(
  createServer(
    {
      cert: readFileSync(nodePath.join(__dirname, '../fixtures/certificates/localhost.pem')),
      key: readFileSync(nodePath.join(__dirname, '../fixtures/certificates/localhost-key.pem')),
      ca: readFileSync(nodePath.join(__dirname, '../fixtures/certificates/rootCA.pem')),
      requestCert: true,
      rejectUnauthorized: false,
    },
    app,
  ).listen(httpsPort, '::', () => {
    console.log(`Listening at https://localhost:${httpsPort}`);
    console.log(`Listening at https://127.0.0.1:${httpsPort}`);
    console.log(`Listening at https://[::1]:${httpsPort}`);
    console.log(`Listening at wss://localhost:${httpsPort}`);
  }),
);

startSocketIOServer();

startGRPCServer(grpcPort);

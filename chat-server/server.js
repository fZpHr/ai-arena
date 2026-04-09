#!/usr/bin/env node
// Multi-AI Debate Chat Server
// Mode "direct": API Copilot directe (streaming SSE)
// Mode "free-debate": Free OpenCode agents → paid sub-agents via opencode run
// Usage: node server.js [port]

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.argv[2] || '8042', 10);
const OPENCODE = path.join(process.env.HOME, '.opencode/bin/opencode');
const WORKSPACE = path.join(process.env.HOME, 'Desktop/ai-arena');

// --- Proxy ---
const PROXY_URL = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || '';
let proxyHost, proxyPort;
if (PROXY_URL) {
  const u = new URL(PROXY_URL);
  proxyHost = u.hostname;
  proxyPort = parseInt(u.port, 10);
  console.log(`Using proxy: ${proxyHost}:${proxyPort}`);
}

// Create HTTPS request, tunneling through proxy if needed.
// When proxied, we do CONNECT → TLS → raw HTTP/1.1 on the socket.
function makeRequest(options, callback) {
  if (!proxyHost) {
    return Promise.resolve(https.request(options, callback));
  }
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${options.hostname}:443`,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: options.hostname, rejectUnauthorized: true }, () => {
        // Build raw HTTP/1.1 request on the TLS socket
        const reqObj = new RawHttpRequest(tlsSocket, options, callback);
        resolve(reqObj);
      });
      tlsSocket.on('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

// Minimal HTTP request writer for tunneled TLS sockets
class RawHttpRequest {
  constructor(socket, options, callback) {
    this._socket = socket;
    this._options = options;
    this._callback = callback;
    this._headers = options.headers || {};
    this._errHandlers = [];
    this._timeout = null;
  }
  on(event, handler) {
    if (event === 'error') this._errHandlers.push(handler);
    return this;
  }
  setTimeout(ms, cb) {
    this._timeout = setTimeout(() => { this._socket.destroy(); cb && cb(); }, ms);
    return this;
  }
  destroy() { this._socket.destroy(); }
  end(body) {
    const { method = 'GET', path = '/', hostname } = this._options;
    const hdrs = { ...this._headers, Host: hostname };
    if (body) hdrs['Content-Length'] = Buffer.byteLength(body);
    let raw = `${method} ${path} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(hdrs)) raw += `${k}: ${v}\r\n`;
    raw += '\r\n';
    this._socket.write(raw);
    if (body) this._socket.write(body);

    // Parse response
    let buf = '';
    let headersParsed = false;
    let statusCode = 0;
    let resHeaders = {};
    let isChunked = false;
    let contentLen = -1;
    let bodyBuf = '';
    let bodyLen = 0;

    const emit = (err) => { for (const h of this._errHandlers) h(err); };

    const fakeRes = new (require('stream').PassThrough)();

    this._socket.on('data', (chunk) => {
      if (!headersParsed) {
        buf += chunk.toString('binary');
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const headerBlock = buf.slice(0, idx);
        const rest = buf.slice(idx + 4);
        const lines = headerBlock.split('\r\n');
        statusCode = parseInt(lines[0].split(' ')[1], 10);
        for (let i = 1; i < lines.length; i++) {
          const [k, ...v] = lines[i].split(':');
          resHeaders[k.toLowerCase().trim()] = v.join(':').trim();
        }
        isChunked = (resHeaders['transfer-encoding'] || '').includes('chunked');
        contentLen = parseInt(resHeaders['content-length'] || '-1', 10);
        headersParsed = true;
        fakeRes.statusCode = statusCode;
        fakeRes.headers = resHeaders;
        this._callback(fakeRes);
        if (rest.length > 0) fakeRes.write(Buffer.from(rest, 'binary'));
      } else {
        fakeRes.write(chunk);
      }
    });
    this._socket.on('end', () => {
      if (this._timeout) clearTimeout(this._timeout);
      fakeRes.end();
    });
    this._socket.on('error', (err) => {
      if (this._timeout) clearTimeout(this._timeout);
      emit(err);
    });
  }
}

// --- Auth ---
const AUTH_PATH = path.join(process.env.HOME, '.local/share/opencode/auth.json');
function getToken() {
  const data = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
  return data['github-copilot']?.access;
}

// --- Models ---
const MODELS = {
  claude: { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', vendor: 'Anthropic', color: '#cc8844' },
  gpt:    { id: 'gpt-5',              name: 'GPT-5',              vendor: 'OpenAI',    color: '#10a37f' },
  gemini: { id: 'gemini-2.5-pro',    name: 'Gemini 2.5 Pro',    vendor: 'Google',    color: '#4285f4' },
};

// --- Premium request counter ---
const COUNTER_PATH = path.join(__dirname, 'premium-usage.json');
function loadCounter() {
  try { return JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf8')); }
  catch { return { total: 0, byModel: {}, byDay: {} }; }
}
function bumpCounter(modelId) {
  const c = loadCounter();
  c.total++;
  c.byModel[modelId] = (c.byModel[modelId] || 0) + 1;
  const day = new Date().toISOString().slice(0, 10);
  c.byDay[day] = (c.byDay[day] || 0) + 1;
  fs.writeFileSync(COUNTER_PATH, JSON.stringify(c, null, 2));
  return c;
}

// --- Free debate agents ---
const DEBATE_AGENTS = {
  alpha: { agent: 'agent/debate-alpha', model: 'opencode/big-pickle', name:'ALPHA', persona:'Claude Opus 4.6', color:'#cc8844', subName:'Claude Opus' },
  beta:  { agent: 'agent/debate-beta',  model: 'opencode/gpt-5-nano', name:'BETA', persona:'GPT-5', color:'#10a37f', subName:'GPT-5' },
  gamma: { agent: 'agent/debate-gamma', model: 'opencode/nemotron-3-super-free', name:'GAMMA', persona:'Gemini 2.5 Pro', color:'#4285f4', subName:'Gemini Pro' },
};

const LEAD_AGENT = { agent: 'agent/debate-lead', model: 'opencode/big-pickle', name:'LEAD Judge', subName:'Claude Opus' };

// Call OpenCode with a free agent (returns Promise<{result, logs}>)
function callOpenCode(agentKey, message, timeoutMs = 180000) {
  const agent = typeof agentKey === 'string' ? DEBATE_AGENTS[agentKey] : agentKey;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn('sh', ['-c',
      `cd "${WORKSPACE}" && "${OPENCODE}" run -m "${agent.model}" --agent "${agent.agent}" "${message.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: process.env.HOME } });

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('opencode timeout'));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      // Check stderr for subagent calls to track premium usage
      const subCalls = (stderr.match(/mode=subagent/g) || []).length;
      if (subCalls > 0) {
        const subModel = agent.subName || 'unknown';
        for (let i = 0; i < subCalls; i++) bumpCounter(subModel + ' (sub)');
      }

      // Extract model verification from stderr
      const modelMatches = stderr.match(/model=(\S+)/g) || [];
      const providerMatches = stderr.match(/provider=(\S+)/g) || [];
      const logs = {
        freeModel: agent.model,
        subAgent: agent.agent,
        expectedSub: agent.subName || agent.persona || 'unknown',
        stderrModels: modelMatches.map(m => m.replace('model=', '')),
        stderrProviders: providerMatches.map(p => p.replace('provider=', '')),
        subCalls,
        stderrSnippet: stderr.slice(-500),
      };

      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`opencode exit ${code}: ${stderr.slice(-200)}`));
      } else {
        resolve({ result: stdout.trim(), logs });
      }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// --- Copilot API call (streaming) ---
function callCopilotStream(modelId, messages, onChunk) {
  return new Promise(async (resolve, reject) => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    const fail = (err) => { if (!resolved) { resolved = true; reject(err); } };
    const token = getToken();
    const body = JSON.stringify({
      model: modelId,
      messages,
      max_tokens: 4096,
      stream: true,
    });

    const options = {
      hostname: 'api.githubcopilot.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Connection': 'close',
      },
    };

    function handleResponse(res) {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (d) => errBody += d);
        res.on('end', () => fail(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`)));
        return;
      }
      let full = '';
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            bumpCounter(modelId);
            done(full);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (delta) {
              full += delta;
              onChunk(delta);
            }
          } catch { /* ignore parse errors in stream */ }
        }
      });
      res.on('end', () => {
        bumpCounter(modelId);
        done(full);
      });
    }

    try {
      const req = await makeRequest(options, handleResponse);
      req.on('error', fail);
      req.setTimeout(60000, () => { req.destroy(); fail(new Error('timeout')); });
      req.end(body);
    } catch (err) { fail(err); }
  });
}

// Non-streaming version for debate rounds
function callCopilot(modelId, messages) {
  return new Promise(async (resolve, reject) => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    const fail = (err) => { if (!resolved) { resolved = true; reject(err); } };
    const token = getToken();
    const body = JSON.stringify({
      model: modelId,
      messages,
      max_tokens: 2048,
    });

    const options = {
      hostname: 'api.githubcopilot.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Connection': 'close',
      },
    };

    function handleResponse(res) {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            fail(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
            return;
          }
          bumpCounter(modelId);
          done(parsed.choices?.[0]?.message?.content || '');
        } catch (e) { fail(e); }
      });
    }

    try {
      const req = await makeRequest(options, handleResponse);
      req.on('error', fail);
      req.setTimeout(60000, () => { req.destroy(); fail(new Error('timeout')); });
      req.end(body);
    } catch (err) { fail(err); }
  });
}

// --- SSE helpers ---
function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// --- HTML ---
const HTML_PATH = path.join(__dirname, 'index.html');

// --- Server ---
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  const url = new URL(req.url, 'http://localhost');

  // Serve UI
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(HTML_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Missing index.html: ' + err.message);
    }
    return;
  }

  // Usage counter
  if (req.method === 'GET' && url.pathname === '/api/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadCounter()));
    return;
  }

  // Single model streaming
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    const message = url.searchParams.get('message')?.slice(0, 4000);
    const modelKey = url.searchParams.get('model') || 'claude';
    const model = MODELS[modelKey];
    if (!message || !model) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing message or invalid model' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    console.log(`[${ts()}] single: ${model.id} "${message.slice(0, 60)}..."`);
    try {
      await callCopilotStream(model.id, [{ role: 'user', content: message }], (chunk) => {
        sseWrite(res, 'chunk', { content: chunk, model: modelKey });
      });
    } catch (err) {
      sseWrite(res, 'error', { message: err.message });
    }
    sseWrite(res, 'done', {});
    res.end();
    return;
  }

  // Multi model streaming (3-way parallel + optional debate)
  if (req.method === 'GET' && url.pathname === '/api/stream-multi') {
    const message = url.searchParams.get('message')?.slice(0, 4000);
    const mode = url.searchParams.get('mode') || 'multi';
    if (!message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing message' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    console.log(`[${ts()}] ${mode}: "${message.slice(0, 60)}..."`);

    // Round 1: Initial parallel dispatch
    sseWrite(res, 'round-start', { round: 1, label: 'Initial responses' });
    const round1 = {};

    await Promise.all(Object.entries(MODELS).map(async ([key, model]) => {
      try {
        round1[key] = await callCopilotStream(model.id,
          [{ role: 'user', content: message }],
          (chunk) => sseWrite(res, 'chunk', { content: chunk, model: key })
        );
      } catch (err) {
        round1[key] = `[Error: ${err.message}]`;
        sseWrite(res, 'chunk', { content: `[Error: ${err.message}]`, model: key });
      }
      sseWrite(res, 'model-done', { model: key, round: 1 });
    }));

    // Debate rounds
    if (mode === 'debate') {
      const MAX_ROUNDS = 2;
      let prev = { ...round1 };
      for (let round = 2; round <= MAX_ROUNDS + 1; round++) {
        const label = round <= MAX_ROUNDS ? 'Critique & improve' : 'Final synthesis';
        sseWrite(res, 'round-start', { round, label });

        const prevResponses = Object.entries(prev).map(([key, text]) =>
          `**${MODELS[key].name}**: ${text}`
        ).join('\n\n---\n\n');

        const debatePrompt = round <= MAX_ROUNDS
          ? `The user asked: "${message}"\n\nHere are the responses from 3 AI models:\n\n${prevResponses}\n\nPlease critique the other models' responses. Point out what they got wrong or missed. Then provide your improved answer. Be concise (max 300 words).`
          : `The user asked: "${message}"\n\nHere are the responses from 3 AI models after debate:\n\n${prevResponses}\n\nProvide your final, synthesized answer incorporating the best insights from all models. Be comprehensive but concise (max 400 words).`;

        const roundResults = {};
        await Promise.all(Object.entries(MODELS).map(async ([key, model]) => {
          try {
            roundResults[key] = await callCopilotStream(model.id,
              [{ role: 'user', content: debatePrompt }],
              (chunk) => sseWrite(res, 'chunk', { content: chunk, model: key })
            );
          } catch (err) {
            roundResults[key] = `[Error: ${err.message}]`;
            sseWrite(res, 'chunk', { content: `[Error: ${err.message}]`, model: key });
          }
          sseWrite(res, 'model-done', { model: key, round });
        }));
        prev = roundResults;
      }
    }

    sseWrite(res, 'done', {});
    res.end();
    return;
  }

  // Free-debate mode: 3 free agents with sequential debate phases
  if (req.method === 'GET' && url.pathname === '/api/free-debate') {
    const message = url.searchParams.get('message')?.slice(0, 4000);
    const rounds = Math.min(parseInt(url.searchParams.get('rounds') || '2', 10), 3);
    if (!message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing message' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const agentKeys = Object.keys(DEBATE_AGENTS);
    console.log(`[${ts()}] free-debate (${rounds} rounds): "${message.slice(0, 60)}..."`);

    // history[agentKey] = [round1_response, round2_response, ...]
    const history = {};
    // debateLog = [{agent, phase, content}, ...] for full debate context
    const debateLog = [];

    for (let round = 1; round <= rounds; round++) {
      // === RESPONSE PHASE: All 3 agents answer in parallel ===
      sseWrite(res, 'round-start', { round, label: round === 1 ? 'Initial responses' : 'Improved answers' });

      let prompt = message;
      if (round > 1) {
        // Build context from all previous debate log entries
        const context = debateLog.map(e =>
          `[${e.phase}] **${DEBATE_AGENTS[e.agent].name}**: ${e.content}`
        ).join('\n\n');
        prompt = `The user asked: "${message}"\n\nHere is the full debate so far:\n\n${context}\n\nBased on all critiques and arguments, provide your improved answer. Address the valid criticisms and defend your positions where you were right. Be concise (max 400 words).`;
      }

      await Promise.all(agentKeys.map(async (key) => {
        sseWrite(res, 'agent-thinking', { agent: key, round, phase: 'response' });
        try {
          const { result, logs } = await callOpenCode(key, prompt);
          sseWrite(res, 'agent-response', { agent: key, round, phase: 'response', content: result });
          sseWrite(res, 'agent-logs', { agent: key, round, phase: 'response', ...logs });
          if (!history[key]) history[key] = [];
          history[key].push(result);
          debateLog.push({ agent: key, phase: `Round ${round}`, content: result });
        } catch (err) {
          const errMsg = `[Error: ${err.message}]`;
          sseWrite(res, 'agent-response', { agent: key, round, phase: 'response', content: errMsg });
          if (!history[key]) history[key] = [];
          history[key].push(errMsg);
          debateLog.push({ agent: key, phase: `Round ${round}`, content: errMsg });
        }
      }));

      // === DEBATE PHASE: Sequential critiques (each sees prior critiques) ===
      if (round < rounds) {
        sseWrite(res, 'debate-start', { round, label: 'Debate — sequential critiques' });
        const debateRoundLog = [];

        for (const key of agentKeys) {
          sseWrite(res, 'agent-thinking', { agent: key, round, phase: 'debate' });

          // Build critique prompt with all responses + prior critiques in THIS debate phase
          const responses = agentKeys.map(k =>
            `**${DEBATE_AGENTS[k].name} (${DEBATE_AGENTS[k].persona})**: ${history[k][history[k].length - 1]}`
          ).join('\n\n---\n\n');

          const priorCritiques = debateRoundLog.length > 0
            ? '\n\nCritiques already given in this debate phase:\n\n' +
              debateRoundLog.map(e => `**${DEBATE_AGENTS[e.agent].name}**: ${e.content}`).join('\n\n---\n\n')
            : '';

          const critiquePrompt = `The user asked: "${message}"\n\nHere are the current responses from all agents:\n\n${responses}${priorCritiques}\n\nYou are ${DEBATE_AGENTS[key].name}. Brutally critique the other agents' responses. What did they get wrong? What did they miss? Be specific and merciless. If another agent already critiqued something correctly, acknowledge it briefly and add NEW points. Max 300 words.`;

          try {
            const { result: critique, logs } = await callOpenCode(key, critiquePrompt);
            sseWrite(res, 'agent-response', { agent: key, round, phase: 'debate', content: critique });
            sseWrite(res, 'agent-logs', { agent: key, round, phase: 'debate', ...logs });
            debateRoundLog.push({ agent: key, content: critique });
            debateLog.push({ agent: key, phase: `Debate ${round}`, content: critique });
          } catch (err) {
            const errMsg = `[Critique Error: ${err.message}]`;
            sseWrite(res, 'agent-response', { agent: key, round, phase: 'debate', content: errMsg });
            debateRoundLog.push({ agent: key, content: errMsg });
            debateLog.push({ agent: key, phase: `Debate ${round}`, content: errMsg });
          }
        }
      }
    }

    // === LEAD VERDICT ===
    sseWrite(res, 'lead-thinking', {});
    try {
      const fullDebate = debateLog.map(e =>
        `[${e.phase}] **${DEBATE_AGENTS[e.agent]?.name || 'LEAD'}**: ${e.content}`
      ).join('\n\n---\n\n');
      const leadPrompt = `The user asked: "${message}"\n\nHere is the full debate between 3 AI agents over ${rounds} round(s) with critique phases:\n\n${fullDebate}\n\nAs the LEAD JUDGE, analyze the debate, declare a winner, and provide the definitive final answer.`;
      const { result: verdict, logs } = await callOpenCode(LEAD_AGENT, leadPrompt);
      sseWrite(res, 'lead-verdict', { content: verdict });
      sseWrite(res, 'agent-logs', { agent: 'lead', round: 0, phase: 'verdict', ...logs });
    } catch (err) {
      sseWrite(res, 'lead-verdict', { content: `[LEAD Error: ${err.message}]` });
    }

    sseWrite(res, 'done', {});
    res.end();
    return;
  }

  // Agent info endpoint
  if (req.method === 'GET' && url.pathname === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ direct: MODELS, free: DEBATE_AGENTS }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

function ts() { return new Date().toISOString(); }

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI Arena running on http://127.0.0.1:${PORT}`);
  console.log(`Models: ${Object.values(MODELS).map(m => m.name).join(', ')}`);
  console.log(`Usage: ${JSON.stringify(loadCounter())}`);
});

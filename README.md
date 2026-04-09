# AI Arena — Multi-Agent Debate Interface

A modern, real-time chat interface where **3 AI models debate** and a **mediator judge** declares the winner.

## Architecture

### Two-Layer Model System

**Layer 1 — Free Orchestrators** (route to sub-agents):
- `ALPHA` (big-pickle) → delegates to Claude Opus 4.6
- `BETA` (gpt-5-nano) → delegates to GPT-5
- `GAMMA` (nemotron) → delegates to Gemini 2.5 Pro
- `LEAD` (big-pickle) → delegates to Claude Opus 4.6 for final verdict

**Layer 2 — Premium Sub-Agents** (do the actual thinking):
- `debate-claude-sub` via GitHub Copilot API → Claude Opus 4.6
- `debate-gpt-sub` via GitHub Copilot API → GPT-5
- `debate-gemini-sub` via GitHub Copilot API → Gemini 2.5 Pro

Uses OpenCode to orchestrate free agents which call sub-agents via the Task tool.

### 🏗️ Tech Stack

- **Frontend**: Vanilla JavaScript + HTML/CSS (modern dark theme)
- **Backend**: Node.js `http` module (no Express)
- **LLM API**: GitHub Copilot API (proxied via OpenCode)
- **Real-Time**: Server-Sent Events (SSE) for live streaming responses
- **Persistence**: Browser localStorage for conversation history

## Features

### Live Debate Flow

1. **Input** — Ask a question in the centered input box
2. **Real-Time Response Feed** — See agents thinking with animated dots
3. **Model Verification Logs** — Each response shows:
   - Free model called (`opencode/big-pickle` → `claude-opus-4.6`)
   - Sub-agent activation count
   - Model metadata extracted from OpenCode stderr
4. **Loading Card** → Status bar tracking rounds and debate phases
5. **Answer Card** → 
   - Mediator's **final verdict** displayed prominently
   - Expandable section "Voir la réflexion et le débat" to review full debate
6. **Persistent History** — localStorage saves up to 50 conversations

### UI Highlights

- **Minimizing welcome screen** after first question
- **Live feed** with agent thinking indicators and response previews (300 chars)
- **Debate detail panel** organized by round and phase:
  - "Round X — Reponses" (blue)
  - "Debate X — Critiques" (red)
- **Model transparency** — Every response tagged with `freeModel → subModel`
- **Auto-scrolling** to latest activity
- **localStorage persistence** — Refresh doesn't lose conversation history

## Setup

### Requirements
```sh
Node.js 18+
GitHub Copilot API access (via ~/.local/share/opencode/auth.json)
OpenCode CLI (~/.opencode/bin/opencode)
```

### Install & Run

```bash
cd /home/renault/Desktop/ai-arena/chat-server
node server.js [PORT]  # defaults to 8042
```

Then open `http://127.0.0.1:8042` in your browser.

### OpenCode Configuration

Make sure these agents are in `~/.opencode/agents/`:
- `agent/debate-alpha.md`
- `agent/debate-beta.md`
- `agent/debate-gamma.md`
- `agent/debate-lead.md`
- Sub-agents: `debate-claude-sub`, `debate-gpt-sub`, `debate-gemini-sub`

Each free agent delegates to its sub-agent via the Task tool.

## How Verification Works

When you see a response, a **log entry** appears showing:

```
✓ ALPHA  Free: opencode/big-pickle → Sub-agent x1 | Models: claude-opus-4.6
```

This confirms:
- ✓ = Sub-agent was called (model verified in OpenCode stderr)
- `opencode/big-pickle` = Free model orchestrator called
- `Sub-agent x1` = Counted mode=subagent in stderr
- `claude-opus-4.6` = Model name extracted from OpenCode logs

**If you see ?**, it means logs couldn't be parsed — check OpenCode output format.

## Debate Rounds

### 1 Round (No Debate)
- Just 3 initial responses
- Mediator verdict
- Toggle shows "Voir les avis des agents (3 avis)"

### 2 Rounds (1 Debate)
- Round 1: Initial responses
- Debate 1: Sequential critiques (each agent sees prior critiques)
- Round 2: Improved answers
- Mediator verdict

### 3 Rounds (2 Debates)
- Round 1: Initial
- Debate 1: Critiques
- Round 2: Improved
- Debate 2: More critiques
- Round 3: Final answers
- Mediator verdict

## API Endpoints

### `/api/free-debate`
**Query params**:
- `message` — Question string
- `rounds` — 1, 2, or 3

**Events** (Server-Sent Events):
- `round-start` → Round X begins
- `agent-thinking` → Agent starting reasoning
- `agent-response` → Response content arrives
- `agent-logs` → Model verification logs
- `debate-start` → Critique phase begins
- `lead-thinking` → Mediator analyzing
- `lead-verdict` → Final answer
- `done` → Stream complete

### `/api/usage`
Returns premium API call stats:
```json
{ "total": 15, "byModel": {...}, "byDay": {...} }
```


# 🛡️ CLIFF — AI Evidence-Based Code Review

> **Stop merging risky code. Let an AI security engineer review every Pull Request — with proof, not opinions.**

CLIFF is a self-hosted, AI-powered Pull Request reviewer that inspects your code like a senior security engineer: it reads the diff, traces untrusted data from source to sink, verifies line numbers against the actual repository AST, and posts an **evidence-based review** straight onto your PR — all without slowing down your workflow.

Built for **AI Hackathon** — 100% free-tier AI, zero vendor lock-in, deployable anywhere from a laptop to a VPS.

---

## ✨ Why CLIFF?

Most code review bots either **cry wolf** (drowning you in generic "add error handling" advice) or **say nothing useful**. CLIFF is different:

- 🎯 **High-signal only.** Every finding must come with concrete code evidence pulled from your diff. No generic filler, no forced findings.
- 🔎 **Evidence tracing.** Vulnerabilities are traced properly: `SOURCE → DATA FLOW → SINK → MISSING VALIDATION → IMPACT` (SQL injection, command injection, XSS, hardcoded secrets, and more).
- 🧠 **It reads your code, not just text.** CLIFF parses your changed files with **Tree-sitter ASTs**, so its line numbers are real, verified against the actual syntax tree — not hallucinated.
- 💥 **Domino-effect detection.** When you change an exported function, CLIFF scans the repo for **downstream call sites** that could break silently.
- ⚡ **Zero GitHub timeouts.** The webhook answers `200 OK` in the first second, then runs the AI review asynchronously in the background.
- 💸 **Free-tier friendly.** Routes through **OpenRouter's unified API** with an automatic fallback chain of working free models.

| Compared to | CLIFF |
| :--- | :--- |
| ❌ Generic linters | AST-aware, semantic, context-driven findings |
| ❌ Keyword scanners | LLM reasoning validated by real repository evidence |
| ❌ Slow webhooks | Async: `200` in <1s, review appears when ready |

---

## 🧰 What CLIFF Can Handle

### AI Code Review (the core)
- **Evidence-based findings** across 5 categories:
  - `security` · `correctness` · `performance` · `maintainability` · `testing`
- **4 severity levels** with a computed **overall risk score**:
  - `low` 🟢 → `medium` 🟡 → `high` 🔴 → `critical` 🚨
  - High/critical PRs are flagged with `REQUEST_CHANGES` on GitHub.
- **3 confidence levels** (`low` / `medium` / `high`) per finding, so you know what to trust.
- Each finding includes:
  - Exact `file:line` (AST-verified), a plain-language description,
  - highlighted **evidence snippets** from your diff,
  - **why it matters**, and a concrete **suggested fix** (often with a code snippet).

### Multi-Language AST Understanding
Tree-sitter gives CLIFF real syntactic intelligence across **13+ file types**:

| Python | JavaScript | JSX | TypeScript | TSX | Go | Java | C | C++ | C/C++ headers | PHP | Ruby | Rust |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |

CLIFF's parser recognises **source nodes** (user input, request params, env vars…) and **sink nodes** (`exec`, `eval`, `query`, `execute`, `subprocess`, `render`…) to verify suspicious data flows directly in your changed code.

### Security & Integrity Guardrails
- **Changed-line verification** — inline review comments are only placed on lines that genuinely changed in the diff (no more GitHub `422` rejections).
- **Strict JSON contract** — the LLM output is validated with **Zod**. Malformed AI output is safely contained and never crashes the webhook.
- **Model-failure resilience** — automatic retries with backoff, plus a **fallback model chain** of verified working free models.

### PR Automation & Bot Commands
CLIFF listens on GitHub webhooks and can react to events or to you:

| Event / Command | What happens |
| :--- | :--- |
| `pull_request` opened / synchronize | Automatic evidence-based AI review posted to the PR |
| **`cl review`** (comment) | Re-run the AI review on the current PR diff |
| **`cl full-review`** (comment) | Trigger a comprehensive repo-wide security & quality audit |
| **`cl help`** (comment) | Print the interactive command guide |

### ☁️ Serverless Review Mode (100% free, zero server)
CLIFF can also run **entirely inside GitHub Actions** using **Google's Gemini API** — no VPS, no webhook, no domain, no OpenRouter key. Drop the workflow into your repo, add one free API key, and every PR gets an evidence-based CLIFF review from Gemini automatically.

### Serverless OWASP Top 10 Audit (optional)
Shipping with CLIFF is a lightweight **GitHub Actions workflow** that audits every PR against the **OWASP Top 10** (injection, broken access control, crypto failures, misconfig, SSRF…), posts a summary comment and inline review comments — no server required, fully free with GitHub Actions.

---

## 🏗️ Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Runtime** | Node.js + **TypeScript** |
| **Web server** | **Express** (async webhook handler) |
| **AI** | **OpenRouter** unified LLM API (free-tier routing) |
| **Default model** | `nex-agi/nex-n2.5-pro:free` (+ fallback chain) |
| **Serverless AI** | **Google Gemini API** (free tier) via GitHub Actions |
| **AST parsing** | **web-tree-sitter** + `tree-sitter-wasms` |
| **Validation** | **Zod** (strict review-schema contracts) |
| **HTTP client** | **Axios** |
| **TS/JS symbol analysis** | **TypeScript compiler API** (`ts.createSourceFile`) |
| **Serverless review** | **GitHub Actions** + **Gemini API** (free tier) |
| **Config** | `dotenv` |
| **Tooling** | `tsx` (dev), `tsc` (build) |

---

## 🔄 How It Works

```
         ┌─────────────┐   webhook (pr / issue_comment)   ┌──────────────────────┐
GitHub ──▶  CLIFF API  ──────────────────────────────────▶│  ACK 200 (first sec) │
         └─────────────┘                                  └──────────────────────┘
                 │  (async, background)
                 ▼
   ┌──────────────────────────────────────────────┐
   │ 1. Fetch PR diff (GitHub REST)                │
   │ 2. Rebuild file contents + Tree-sitter AST    │
   │ 3. Domino-effect scan (downstream call sites) │
   │ 4. Ask LLM (OpenRouter) → strict JSON         │
   │ 5. Zod-validate + AST-verify line numbers     │
   │ 6. Filter inline comments to changed lines    │
   └──────────────────────────────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────┐
   │ Post PR Review + inline       │
   │ comments on GitHub            │
   └──────────────────────────────┘
```

**The reviewer never blocks your merge pipeline** — it works *alongside* it, publishing its verdict the moment the AI finishes thinking.

---

## 🚀 Quick Start

### 1. Clone & install
```bash
git clone <your-repo>
cd cliff-beta
npm install
```

### 2. Configure environment (`.env`)
```env
PORT=8000
GITHUB_TOKEN=ghp_xxxxxxxxxxxx            # GitHub PAT with repo + pull_request write
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxx   # your OpenRouter key

# AI model routing (all free tier)
OPENROUTER_MODEL=nex-agi/nex-n2.5-pro:free
OPENROUTER_FALLBACK_MODELS=nex-agi/nex-n2.5-mini:free,cohere/north-mini-code:free,nvidia/nemotron-3-super-120b-a12b:free,dots-studio/dots-3-note-preview:free

# Optional tuning
MAX_DIFF_LENGTH=20000      # cap diff size sent to the LLM
LLM_TIMEOUT=300000         # per-model request timeout (ms)
```

### 3. Run
```bash
npm run dev      # development (tsx watch)
# or
npm run build && npm start   # production (compiled dist)
```

### 4. Connect GitHub webhook
1. GitHub repo → **Settings → Webhooks → Add webhook**
2. **Payload URL:** `http://<your-host>:8000/webhook/github`
3. **Content type:** `application/json`
4. **Events:** `Pull requests`, `Issue comments`

> ⚡ **No timeouts.** Because CLIFF acknowledges the webhook in the first second, GitHub never retries or marks delivery failed — even though the full AI review runs afterward.

### 5. (Optional) Serverless OWASP audit
Add `GEMINI_API_KEY` to your repo secrets. The bundled OWASP audit script (`github/scripts/audit.ts`) runs the OWASP Top 10 audit on every PR. For it to trigger on GitHub Actions, place its workflow inside `.github/workflows/` (rename `github/workflows/audit.yml` to `.github/workflows/audit.yml`).

---

## ☁️ Serverless Mode — Zero-Cost Guide (No Server, No Webhook, No VPS)

The fastest way to try CLIFF: **no hosting needed**. A GitHub Actions workflow runs a full CLIFF review on every PR using **Google's free Gemini API**. Ideal for any repo — public repos even get unlimited GitHub Actions minutes.

### What you need
| Item | Cost | Where |
| :--- | :---: | :--- |
| GitHub repository | **$0** | github.com |
| GitHub Actions minutes | **$0** (public) / free quota (private) | built-in |
| **Gemini API key** | **$0** (free tier) | Google AI Studio |
| Gemini model | **$0** (Flash / Flash-Lite free tier) | pick in AI Studio |

### Step-by-step setup

**1. Copy the workflow file**
Copy `.github/workflows/cliff-serverless-review.yml` into your repo (it's already included in this project). GitHub Actions only reads workflows from `.github/workflows/` — the workflow runs on every:
- `pull_request` opened or updated, **and**
- comment starting with `cl` (e.g. `cl review` to re-run).

**2. Get a free Gemini API key (Google AI Studio)**
1. Go to **https://aistudio.google.com** and sign in with your Google account.
2. Click **"Get API key"** (top-left → *Get API key* / *Gemini API key*).
3. Click **"Create API key"** → choose your Google Cloud project → copy the key.
4. 😀 Free tier is automatic — you do **not** need to attach a billing card.

**3. Add the API key as a GitHub Actions secret**
1. Your repo → **Settings** → **Secrets and variables** → **Actions**.
2. **New repository secret**:
   - Name: `GEMINI_API_KEY`
   - Value: paste the key from step 2.
3. Add a second secret:
   - Name: `GITHUB_TOKEN` → value `ghp_...` (a classic PAT with **repo** + **pull_requests:write** scopes). Without it, CLIFF can't post the review.

**4. (Optional) Choose your Gemini model — repository variable**
Your key works with any Gemini model. Set the `GEMINI_MODEL` repository **variable** in the same Settings page (default if unset: `gemini-2.5-flash`):

| Model (free) | Notes |
| :--- | :--- |
| `gemini-2.5-flash` | **Recommended** — smart, fast, free-tier friendly |
| `gemini-3.5-flash` | Newer Flash family if available in AI Studio |
| `gemini-3.1-flash-lite` | Cheapest / lightest, best for very large PRs |
| `gemini-2.0-flash` | Stable older Flash |
| anything else | Any model listed at aistudio.google.com works |

> To use the same repo for **both** webhook mode and serverless mode, CLIFF reads `GEMINI_MODEL`/`GEMINI_API_KEY` from the environment — it never collides with the OpenRouter config.

**5. Done — open a PR and watch it work** 🎉
On every PR, GitHub Actions runs `.github/workflows/cliff-serverless-review.yml`, which:
1. Checks out your repo and runs `npm ci`.
2. Fetches the PR diff via the GitHub API (`src/serverless-review.ts`).
3. Rebuilds changed-file contents + **Tree-sitter ASTs** to verify line numbers.
4. Calls **Gemini** with the same evidence-based CLIFF prompt used by the webhook.
5. Zod-validates the JSON, filters inline comments to changed lines, and publishes the review — with inline comments on the exact changed lines.

**Cost math:** 1 review ≈ 1 Gemini request. Free tier gives roughly **250 Flash requests/day** — far more than any team needs.

---

## 🧪 Testing
```bash
npm test              # 53 assertions: parsing, fallback, domain logic, commands
npm run test:direct   # end-to-end Hermes LLM run on a sample diff
```

---

## 📁 Repository Layout

```
src/
├── index.ts              # Express server + async webhook handler
├── serverless-review.ts  # GitHub Actions entry point (serverless / zero-server)
├── types/index.ts        # Zod schema contracts (Finding, ReviewResult)
├── services/
│   ├── hermes.ts         # OpenRouter LLM orchestration, prompt, JSON recovery, retries
│   ├── gemini.ts         # Gemini API provider (serverless mode)
│   ├── github.ts         # diff fetching, review publishing, markdown
│   ├── treeSitter.ts     # multi-language AST parsing + line resolution
│   ├── ast.ts            # TS symbol & call-site extraction
│   ├── domino.ts         # downstream (breaking-change) impact scan
│   ├── commands.ts       # `cl review` / `cl full-review` handling
│   └── ...
├── tests/reviewer.test.ts # 53-assertion test suite
github/
├── scripts/audit.ts      # OWASP Top 10 audit script
└── workflows/audit.yml   # serverless GitHub Actions audit
.github/workflows/
└── cliff-serverless-review.yml  # serverless CLIFF review (Gemini, free)
```

---

## 🗺️ Roadmap
- [x] Serverless mode via GitHub Actions + Gemini (free, zero-server)
- [ ] Multi-PR queue + deduplication of reviews
- [ ] Custom prompt templates per org / repo
- [ ] Slack & Discord notifications on critical findings
- [ ] Local Ollama mode support for fully air-gapped reviews

---

## 📄 License
ISC — free to use, modify, and ship.

---

*CLIFF: the code reviewer that shows its work.* 🛡️
# ChatGPT Walkthrough Prompts

Copy and paste these prompts into ChatGPT along with the relevant documents from this pack.

---

## Master prompt (start here)

```
I am deploying INFRA — a business AI control plane hosted on Cloudflare.

I have attached the INFRA Deployment Pack documentation. Please act as my 
deployment guide.

Rules:
1. Walk me through ONE phase at a time from 09-PHASE-CHECKLIST.md
2. After each step, ask me to confirm completion or paste any error output
3. Do not skip steps
4. Assume I am using Cloudflare Workers, D1, and Pages
5. My domain will be: [REPLACE WITH YOUR DOMAIN e.g. example.com]
6. I am on macOS/Windows [DELETE ONE] with Node.js installed

Start with Phase 1: Infrastructure. Give me the first step only.
```

---

## Phase 1 prompt (Cloudflare + domain + deploy)

```
Using 02-SETUP-GUIDE.md sections 3–8, guide me through:
1. Cloudflare account and wrangler login
2. Creating the D1 database
3. Updating wrangler.toml with my database ID
4. Deploying the API Worker
5. Deploying the admin UI to Pages
6. Attaching custom domains

My Cloudflare account email is: [YOUR EMAIL]
My chosen domain is: [YOUR DOMAIN]

Give me one step at a time. Include exact commands to run.
```

---

## Phase 2 prompt (Caddington MCP + metering)

```
Using 02-SETUP-GUIDE.md section 12, guide me through registering the 
existing Caddington MCP as an external environment and proving the 
ChatGPT → MCP → INFRA metering loop.

Do NOT modify the existing Caddington MCP codebase.

My Caddington MCP endpoint is: [YOUR MCP URL]
My INFRA API is: https://api.infra.[YOUR DOMAIN]
```

---

## Phase 3 prompt (Stripe test mode)

```
Using 07-STRIPE-AND-BILLING.md, guide me through:
1. Stripe test mode setup
2. Webhook endpoint on my INFRA API
3. Storing secrets in Wrangler
4. Testing a £50 top-up for EL Business

My API URL: https://api.infra.[YOUR DOMAIN]
```

---

## Phase 4 prompt (EL BigChange — developer setup)

```
Using 05-ROLES-READ-WRITE-PERMISSIONS.md and 03-ARCHITECTURE-DESIGN.md 
section 23, explain how I will connect EL Business to BigChange via Cursor 
(developer-led v0.1).

Before any live credentials:
- Confirm company: EL Business
- Confirm service: BigChange
- Confirm read/write permissions needed
- I will provide explicit approval before activation

Guide me through the approval checklist only — do not connect live systems yet.
```

---

## Cursor bridge prompt

```
Using 04-CURSOR-BRIDGE.md, explain how the Cursor knowledge bridge works 
when ChatGPT is unsure about a BigChange API call.

Show me the v0.1 manual workflow (I fix in Cursor, push to INFRA API) 
and the v0.2 automated workflow.
```

---

## Troubleshooting prompt

```
I am deploying INFRA and hit this error:

[PASTE ERROR HERE]

Context:
- Step I was on: [DESCRIBE]
- Command I ran: [PASTE]
- My OS: [macOS/Windows/Linux]

Using 02-SETUP-GUIDE.md section 16 (Troubleshooting), help me diagnose and fix.
```

---

## Documents to attach in ChatGPT

For best results, attach these files to your ChatGPT conversation:

| Phase | Attach |
| --- | --- |
| Getting started | `README-START-HERE.md`, `01-FULL-STRUCTURE-AND-OVERVIEW.md` |
| Deploy | `02-SETUP-GUIDE.md`, `06-CLOUDFLARE-HOSTING-REFERENCE.md` |
| Architecture questions | `03-ARCHITECTURE-DESIGN.md` |
| Permissions | `05-ROLES-READ-WRITE-PERMISSIONS.md` |
| Billing | `07-STRIPE-AND-BILLING.md` |
| Checklist | `09-PHASE-CHECKLIST.md` |

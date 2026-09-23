import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url =
  process.env.MCP_URL ?? "https://caddington-mcp.daniel-dwyer123.workers.dev/mcp";
const adminBase =
  process.env.ADMIN_BASE ??
  "https://caddington-mcp.daniel-dwyer123.workers.dev";
const token = process.env.CADDINGTON_ADMIN_TOKEN;

const BENCHMARK_QUERIES = [
  "How do I price a boiler installation?",
  "How many days holiday do I have in my employment contract?",
  "What is our policy for approving supplier invoices?",
  "What did the survey say about the roof at Trout Hollow?",
  "What margin should we make on plumbing work?",
  "Show me what we previously agreed about staff bonuses.",
  "What is the maximum spend without approval for Project Falcon?",
  "What is the Project Falcon approved budget?",
  "What postcode is associated with Trout Hollow Saunderton?",
  "What hourly rate is quoted for surveyor time including travel?",
];

async function uploadScaleSyntheticDocs(count) {
  if (!token) return;
  for (let i = 0; i < count; i++) {
    const project = i % 2 === 0 ? "Project Kestrel" : "Project Harrier";
    const externalId = `scale-bench-${i}`;
    const body = `${project} policy document ${i}.\nMaximum spend without approval: £${1000 + i}.\nApproved budget: £${200000 + i * 1000}.\nTopic: pricing boiler plumbing margin holiday employment.`;
    const form = new FormData();
    form.append("file", new Blob([body], { type: "text/plain" }), `${externalId}.txt`);
    form.append("title", `${project} Scale Doc ${i}`);
    form.append("external_id", externalId);
    form.append("project", project);
    form.append("topic", i % 3 === 0 ? "employment" : "pricing");

    const upload = await fetch(`${adminBase}/admin/knowledge/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const uploadJson = await upload.json();
    if (!upload.ok) continue;
    await fetch(`${adminBase}/admin/knowledge/${uploadJson.documentId}/index`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}

const client = new Client({ name: "scale-benchmark", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const scaleCount = Number(process.env.SCALE_DOC_COUNT ?? "0");
if (scaleCount > 0) {
  console.log(`Uploading ${scaleCount} synthetic docs...`);
  await uploadScaleSyntheticDocs(scaleCount);
}

const results = [];
let totalLatency = 0;
let worstLatency = 0;

for (const query of BENCHMARK_QUERIES) {
  const res = await client.callTool({
    name: "search_company_knowledge",
    arguments: {
      query,
      topK: 8,
      includeDiagnostics: true,
    },
  });
  const parsed = JSON.parse(res.content?.[0]?.text ?? "{}");
  const latency = parsed.diagnostics?.latencyMs ?? 0;
  totalLatency += latency;
  worstLatency = Math.max(worstLatency, latency);
  const top = parsed.results?.[0];
  results.push({
    query,
    confidence: parsed.confidence,
    routing: parsed.routing?.intents,
    topDocumentId: top?.documentId,
    topExternalId: top?.externalId,
    topScore: top?.score,
    provenance: top?.provenance?.filename,
    diagnostics: parsed.diagnostics,
  });
}

const report = {
  queryCount: BENCHMARK_QUERIES.length,
  averageLatencyMs: Math.round(totalLatency / BENCHMARK_QUERIES.length),
  worstLatencyMs: worstLatency,
  complexity: {
    queryTime: "O(1) parse + O(1) embed",
    vectorize: "O(log n) approximate nearest neighbours",
    lexicalChunkFts: "O(log n) indexed FTS with LIMIT",
    lexicalDocumentFts: "O(log n) indexed FTS with LIMIT",
    metadataFilter: "O(m) indexed SQL where m = filtered docs, optional",
    rerankPool: "O(k) where k <= 40",
    r2Access: "none at query time",
  },
  scalingNotes: {
    at1000Docs: "Vectorize + FTS dominate; filter SQL indexed",
    at10000Docs: "Same query path; tune candidate limits if latency grows",
    at100000Docs: "Consider Vectorize topK cap + document-stage prefilter always on",
  },
  results,
};

console.log(JSON.stringify(report, null, 2));
await client.close();

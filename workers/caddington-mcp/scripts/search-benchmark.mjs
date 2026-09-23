import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url =
  process.env.MCP_URL ?? "https://caddington-mcp.daniel-dwyer123.workers.dev/mcp";
const adminBase =
  process.env.ADMIN_BASE ??
  "https://caddington-mcp.daniel-dwyer123.workers.dev";
const token = process.env.CADDINGTON_ADMIN_TOKEN;

const queries = [
  "What is the maximum spend without approval for Project Falcon?",
  "What is the Project Falcon approved budget?",
  "What postcode is associated with Trout Hollow Saunderton?",
  "What hourly rate is quoted for surveyor time including travel?",
  "maximum spend without approval",
];

async function uploadSyntheticDocs() {
  if (!token) return;

  const docs = [
    {
      externalId: "synthetic-project-kestrel",
      title: "Project Kestrel Budget Policy",
      project: "Project Kestrel",
      body:
        "Project Kestrel internal policy.\nMaximum spend without approval: £2,100.\nApproved budget: £410,000.\nResponsible manager: Oliver Stone.",
    },
    {
      externalId: "synthetic-project-harrier",
      title: "Project Harrier Budget Policy",
      project: "Project Harrier",
      body:
        "Project Harrier internal policy.\nMaximum spend without approval: £980.\nApproved budget: £225,500.\nResponsible manager: Nina Patel.",
    },
  ];

  for (const doc of docs) {
    const blob = new Blob([doc.body], { type: "text/plain" });
    const form = new FormData();
    form.append("file", blob, `${doc.externalId}.txt`);
    form.append("title", doc.title);
    form.append("external_id", doc.externalId);
    form.append("project", doc.project);

    const upload = await fetch(`${adminBase}/admin/knowledge/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const uploadJson = await upload.json();
    if (!upload.ok) {
      console.log("upload failed", doc.externalId, uploadJson);
      continue;
    }
    const index = await fetch(
      `${adminBase}/admin/knowledge/${uploadJson.documentId}/index`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    console.log("indexed", doc.externalId, await index.json());
  }
}

const client = new Client({ name: "search-benchmark", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

if (process.env.UPLOAD_SYNTHETIC === "1") {
  await uploadSyntheticDocs();
}

const summaries = [];
for (const query of queries) {
  const res = await client.callTool({
    name: "search_company_knowledge",
    arguments: {
      query,
      topK: 5,
      includeDiagnostics: true,
    },
  });
  const parsed = JSON.parse(res.content?.[0]?.text ?? "{}");
  const top = parsed.results?.[0];
  summaries.push({
    query,
    confidence: parsed.confidence,
    topDocumentId: top?.documentId,
    topExternalId: top?.externalId,
    topScore: top?.score,
    ranking: top?.ranking,
    diagnostics: parsed.diagnostics,
    snippet: top?.snippet?.slice(0, 160),
  });
}

console.log(JSON.stringify(summaries, null, 2));
await client.close();

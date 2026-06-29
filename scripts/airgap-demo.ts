// Air-gapped enterprise demo — proves no egress at the application layer and
// exercises the offline license, audit trail, and zero-retention purge.
//   node scripts/airgap-demo.ts

import { createAirgappedGateway, EgressBlockedError } from "@cavix/gateway";
import { generateLicenseKeypair, issueLicense, verifyLicense, hasFeature, type LicensePayload } from "@cavix/license";
import { AuditLog } from "@cavix/governance";
import { ZeroRetention } from "@cavix/zero-retention";
import { LocalSandboxBackend } from "@cavix/sandbox";

const MODEL = "http://cavix-model.cavix.svc.cluster.local:8000";
const contacted: string[] = [];

// Stand-in for the in-cluster model; records every host actually contacted.
const clusterFetch = (async (url: string | URL | Request) => {
  contacted.push(new URL(String(url)).hostname);
  return new Response(JSON.stringify({ model: "llama-3", choices: [{ message: { content: '{"summary":"reviewed in-cluster"}' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }), { status: 200 });
}) as unknown as typeof fetch;

function bar(t: string) {
  console.log("\n" + "─".repeat(68) + "\n" + t + "\n" + "─".repeat(68));
}

async function main() {
  bar("1. Offline license (Ed25519) — verified with no network");
  const { publicKeyPem, privateKeyPem } = generateLicenseKeypair();
  const payload: LicensePayload = {
    licenseId: "lic_acme", licensee: "Acme Bank", plan: "enterprise", seats: 50,
    features: ["airgapped", "self-host", "sso", "policy-engine", "legacy-languages", "zero-retention"],
    issuedAt: new Date().toISOString(), notBefore: new Date(Date.now() - 1000).toISOString(), notAfter: new Date(Date.now() + 3.15e10).toISOString(),
  };
  const license = issueLicense(payload, privateKeyPem);
  const v = verifyLicense(license, publicKeyPem);
  console.log(`license valid=${v.valid}  airgapped=${hasFeature(license, "airgapped")}  seats=${license.payload.seats}  (offline crypto)`);

  bar("2. Air-gapped gateway — inference reaches only the in-cluster model");
  const { gateway, guardedFetch, policy } = createAirgappedGateway({ modelBaseUrl: MODEL, model: "llama-3", fetchImpl: clusterFetch });
  console.log(`egress allowlist: ${JSON.stringify(policy.allowedHosts)} (+ loopback, *.svc)`);
  const { response } = await gateway.complete("acme", { messages: [{ role: "user", content: "review this diff" }] });
  console.log(`model replied: ${response.text}`);

  bar("3. PROOF — every outbound to the internet is blocked");
  for (const host of ["https://api.anthropic.com/v1/messages", "https://api.openai.com/v1/chat", "https://github.com/acme/repo"]) {
    try {
      await guardedFetch(host);
      console.log(`  ✗ UNEXPECTED: reached ${host}`);
    } catch (e) {
      console.log(`  ⛔ ${new URL(host).hostname} → ${(e as EgressBlockedError).name}`);
    }
  }
  console.log(`\nhosts actually contacted during the whole run: ${JSON.stringify([...new Set(contacted)])}`);

  bar("4. Audit trail (tamper-evident) + zero-retention purge");
  const audit = new AuditLog();
  audit.append("alice@acme", "review.start", "acme/core#42");
  const zr = new ZeroRetention({ backend: new LocalSandboxBackend(), audit });
  const { attestation } = await zr.runReview({ reviewId: "rev_42", repo: "acme/core" }, async (sbx) => {
    await sbx.writeFile("src/secret.cob", "       MOVE WS-PIN TO ACCOUNT.");
    return "ok";
  });
  console.log(`zero-retention: clean=${attestation.clean}  residual=${JSON.stringify(attestation.residualPaths)}`);
  console.log(`audit chain intact: ${audit.verify().ok}  (${audit.list().length} entries)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

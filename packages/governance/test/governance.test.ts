import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AuditLog, can, IdentityStore, verifySamlAssertion, SamlError } from "@cavix/governance";

// ── Audit ──────────────────────────────────────────────────────────────────
test("audit log: hash chain detects tampering", () => {
  const log = new AuditLog();
  log.append("alice", "repo.onboard", "acme/widget");
  log.append("bob", "review.decide", "finding:123", { state: "accepted" });
  assert.equal(log.verify().ok, true);

  // Tamper with a recorded entry.
  (log.list()[0] as { actor: string }).actor = "mallory";
  const v = log.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 0);
});

// ── RBAC ───────────────────────────────────────────────────────────────────
test("rbac: roles gate permissions", () => {
  assert.equal(can("owner", "org:manage"), true);
  assert.equal(can("reviewer", "review:decide"), true);
  assert.equal(can("reviewer", "policy:edit"), false);
  assert.equal(can("member", "review:decide"), false);
});

// ── SCIM → RBAC ──────────────────────────────────────────────────────────────
test("scim: provisioning maps IdP groups to roles; deactivation revokes", () => {
  const store = new IdentityStore({ "cavix-admins": "admin", "cavix-reviewers": "reviewer" });
  const u = store.provisionUser({ userName: "alice@corp", externalId: "ext-1", groups: ["cavix-admins"] });
  assert.equal(store.effectiveRoleFor(u.id), "admin");

  // Re-provision (idempotent) updates groups.
  store.provisionUser({ userName: "alice@corp", externalId: "ext-1", groups: ["cavix-reviewers"] });
  assert.equal(store.effectiveRoleFor(u.id), "reviewer");

  store.deactivateUser(u.id);
  assert.deepEqual(store.rolesFor(u.id), [], "deactivated user has no roles");
});

// ── SAML ─────────────────────────────────────────────────────────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUB = publicKey.export({ type: "spki", format: "pem" }).toString();

function makeAssertion(opts: { audience?: string; issuer?: string; notAfterOffsetMs?: number; id?: string } = {}): string {
  const now = Date.now();
  const issuer = opts.issuer ?? "https://idp.corp/saml";
  const audience = opts.audience ?? "cavix-sp";
  const nb = new Date(now - 60_000).toISOString();
  const na = new Date(now + (opts.notAfterOffsetMs ?? 5 * 60_000)).toISOString();
  const id = opts.id ?? "_a1b2c3";
  const inner = (sig: string) =>
    `<saml:Assertion ID="${id}" Version="2.0" IssueInstant="${nb}"><saml:Issuer>${issuer}</saml:Issuer>${sig}` +
    `<saml:Subject><saml:NameID>alice@corp</saml:NameID></saml:Subject>` +
    `<saml:Conditions NotBefore="${nb}" NotOnOrAfter="${na}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement SessionIndex="sess-1"/>` +
    `<saml:AttributeStatement><saml:Attribute Name="groups"><saml:AttributeValue>cavix-admins</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
    `</saml:Assertion>`;
  const signedContent = inner("");
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signedContent, "utf8"), privateKey).toString("base64");
  return inner(`<ds:Signature><ds:SignatureValue>${sig}</ds:SignatureValue></ds:Signature>`);
}

const cfg = { issuer: "https://idp.corp/saml", audience: "cavix-sp", idpPublicKeyPem: PUB };

test("saml: a validly-signed assertion yields the identity + groups", () => {
  const id = verifySamlAssertion(makeAssertion(), cfg);
  assert.equal(id.nameId, "alice@corp");
  assert.deepEqual(id.groups, ["cavix-admins"]);
  assert.equal(id.sessionIndex, "sess-1");
});

test("saml: a tampered assertion fails signature verification", () => {
  const xml = makeAssertion().replace("alice@corp", "attacker@corp");
  assert.throws(() => verifySamlAssertion(xml, cfg), SamlError);
});

test("saml: wrong audience / expired / replay are rejected", () => {
  assert.throws(() => verifySamlAssertion(makeAssertion({ audience: "other-sp" }), cfg), /audience/);
  assert.throws(() => verifySamlAssertion(makeAssertion({ notAfterOffsetMs: -120_000 }), cfg), /expired/);

  const seen = new Set<string>();
  const xml = makeAssertion({ id: "_unique" });
  verifySamlAssertion(xml, cfg, { seenAssertionIds: seen });
  assert.throws(() => verifySamlAssertion(xml, cfg, { seenAssertionIds: seen }), /replay/);
});

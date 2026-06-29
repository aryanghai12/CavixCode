import { test } from "node:test";
import assert from "node:assert/strict";
import { issueLicense, verifyLicense, hasFeature, seatsAvailable, generateLicenseKeypair, type LicensePayload } from "@cavix/license";

const { publicKeyPem, privateKeyPem } = generateLicenseKeypair();

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  const now = Date.now();
  return {
    licenseId: "lic_1",
    licensee: "Acme Bank",
    plan: "enterprise",
    seats: 50,
    features: ["airgapped", "self-host", "sso", "policy-engine", "legacy-languages", "zero-retention"],
    issuedAt: new Date(now).toISOString(),
    notBefore: new Date(now - 1000).toISOString(),
    notAfter: new Date(now + 365 * 86400_000).toISOString(),
    ...over,
  };
}

test("issue + verify offline: a valid license verifies and yields entitlements", () => {
  const lic = issueLicense(payload(), privateKeyPem);
  const r = verifyLicense(lic, publicKeyPem);
  assert.equal(r.valid, true);
  assert.equal(r.payload?.licensee, "Acme Bank");
  assert.equal(hasFeature(lic, "airgapped"), true);
  assert.equal(hasFeature(lic, "zero-retention"), true);
});

test("tampering with the payload breaks the signature", () => {
  const lic = issueLicense(payload({ seats: 50 }), privateKeyPem);
  lic.payload.seats = 5000; // try to grant more seats
  const r = verifyLicense(lic, publicKeyPem);
  assert.equal(r.valid, false);
  assert.ok(r.reasons.includes("invalid signature"));
});

test("expired / not-yet-valid licenses are rejected", () => {
  const expired = issueLicense(payload({ notAfter: new Date(Date.now() - 1000).toISOString() }), privateKeyPem);
  assert.ok(verifyLicense(expired, publicKeyPem).reasons.includes("license expired"));

  const future = issueLicense(payload({ notBefore: new Date(Date.now() + 86400_000).toISOString() }), privateKeyPem);
  assert.ok(verifyLicense(future, publicKeyPem).reasons.includes("license not yet valid"));
});

test("a license signed by a different key does not verify", () => {
  const other = generateLicenseKeypair();
  const lic = issueLicense(payload(), other.privateKeyPem);
  assert.equal(verifyLicense(lic, publicKeyPem).valid, false);
});

test("seat limit enforcement", () => {
  const lic = issueLicense(payload({ seats: 10 }), privateKeyPem);
  assert.equal(seatsAvailable(lic, 10), true);
  assert.equal(seatsAvailable(lic, 11), false);
});

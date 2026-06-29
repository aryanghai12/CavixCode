import crypto from "node:crypto";

// Offline licensing. Licenses are Ed25519-signed by the vendor; the customer
// verifies them with the vendor's PUBLIC key, which ships in the product. No
// network call is ever required — essential for air-gapped deployments. Seat and
// feature entitlements are part of the signed payload, so they can't be edited
// without breaking the signature.

export type Feature = "airgapped" | "self-host" | "sso" | "policy-engine" | "legacy-languages" | "zero-retention";

export interface LicensePayload {
  licenseId: string;
  licensee: string;
  plan: string;
  seats: number;
  features: Feature[];
  issuedAt: string;
  notBefore: string;
  notAfter: string;
}

export interface License {
  payload: LicensePayload;
  /** Base64 Ed25519 signature over the canonical payload. */
  signature: string;
}

function canonical(payload: LicensePayload): string {
  // Stable key order so signing and verification hash identical bytes.
  const keys = Object.keys(payload).sort() as Array<keyof LicensePayload>;
  return JSON.stringify(keys.map((k) => [k, payload[k]]));
}

/** Vendor side: sign a license payload with the Ed25519 private key. */
export function issueLicense(payload: LicensePayload, privateKeyPem: string): License {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(canonical(payload), "utf8"), key);
  return { payload, signature: sig.toString("base64") };
}

export interface VerifyResult {
  valid: boolean;
  reasons: string[];
  payload?: LicensePayload;
}

/** Customer side: verify OFFLINE with the vendor public key. */
export function verifyLicense(license: License, publicKeyPem: string, opts: { now?: Date } = {}): VerifyResult {
  const reasons: string[] = [];
  let signatureOk = false;
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    signatureOk = crypto.verify(null, Buffer.from(canonical(license.payload), "utf8"), key, Buffer.from(license.signature, "base64"));
  } catch (err) {
    reasons.push(`signature error: ${(err as Error).message}`);
  }
  if (!signatureOk) reasons.push("invalid signature");

  const now = (opts.now ?? new Date()).getTime();
  if (now < Date.parse(license.payload.notBefore)) reasons.push("license not yet valid");
  if (now >= Date.parse(license.payload.notAfter)) reasons.push("license expired");

  const valid = reasons.length === 0;
  return { valid, reasons, payload: valid ? license.payload : undefined };
}

export function hasFeature(license: License, feature: Feature): boolean {
  return license.payload.features.includes(feature);
}

export function seatsAvailable(license: License, activeSeats: number): boolean {
  return activeSeats <= license.payload.seats;
}

/** Generate a fresh Ed25519 keypair (vendor key management / tests). */
export function generateLicenseKeypair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

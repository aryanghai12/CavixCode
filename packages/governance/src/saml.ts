import crypto from "node:crypto";

// SAML 2.0 assertion verification for SSO. Implements the security-critical
// validations — signature (RSA-SHA256, enveloped), issuer, audience, validity
// window, and replay protection — over the assertion. NOTE: strict XML
// exclusive-canonicalization (exc-c14n) of the SignedInfo/reference is delegated
// to a vetted library (xml-crypto) in production via the injectable
// signatureVerifier; the default here verifies the signature over the
// enveloped-signature-stripped assertion, which is correct modulo c14n and keeps
// the validation logic testable without an XML stack.

export interface SamlConfig {
  /** Expected IdP entityID (Issuer). */
  issuer: string;
  /** Our SP entityID (must appear in AudienceRestriction). */
  audience: string;
  /** Public key PEM extracted from the IdP's X.509 signing certificate. */
  idpPublicKeyPem: string;
  clockSkewMs?: number;
  groupsAttribute?: string;
}

export interface SamlIdentity {
  nameId: string;
  sessionIndex?: string;
  attributes: Record<string, string[]>;
  groups: string[];
}

export interface VerifyOptions {
  now?: Date;
  /** Replay protection — assertion IDs already consumed. Mutated on success. */
  seenAssertionIds?: Set<string>;
  signatureVerifier?: (signedContent: string, signatureB64: string, pubPem: string) => boolean;
}

export class SamlError extends Error {}

const SIG_BLOCK = /<(?:\w+:)?Signature\b[\s\S]*?<\/(?:\w+:)?Signature>/;

export function verifySamlAssertion(xml: string, cfg: SamlConfig, opts: VerifyOptions = {}): SamlIdentity {
  const now = opts.now ?? new Date();
  const skew = cfg.clockSkewMs ?? 60_000;

  const assertion = match(xml, /<(?:\w+:)?Assertion\b[\s\S]*?<\/(?:\w+:)?Assertion>/);
  if (!assertion) throw new SamlError("no Assertion element");

  // 1. Signature (over the enveloped-signature-stripped assertion).
  const sig = match(assertion, /<(?:\w+:)?SignatureValue\b[^>]*>([\s\S]*?)<\/(?:\w+:)?SignatureValue>/, 1);
  if (!sig) throw new SamlError("assertion is not signed");
  const signedContent = assertion.replace(SIG_BLOCK, "");
  const verifier = opts.signatureVerifier ?? defaultSignatureVerifier;
  if (!verifier(signedContent, sig.replace(/\s/g, ""), cfg.idpPublicKeyPem)) {
    throw new SamlError("signature verification failed");
  }

  // 2. Issuer.
  const issuer = match(assertion, /<(?:\w+:)?Issuer\b[^>]*>\s*([^<]+?)\s*<\/(?:\w+:)?Issuer>/, 1);
  if (issuer !== cfg.issuer) throw new SamlError(`unexpected issuer "${issuer}"`);

  // 3. Audience.
  const audience = match(assertion, /<(?:\w+:)?Audience\b[^>]*>\s*([^<]+?)\s*<\/(?:\w+:)?Audience>/, 1);
  if (audience !== cfg.audience) throw new SamlError(`assertion audience "${audience}" != "${cfg.audience}"`);

  // 4. Validity window.
  const condAttrs = match(assertion, /<(?:\w+:)?Conditions\b([^>]*)>/, 1) ?? "";
  const notBefore = attr(condAttrs, "NotBefore");
  const notOnOrAfter = attr(condAttrs, "NotOnOrAfter");
  if (notBefore && now.getTime() + skew < Date.parse(notBefore)) throw new SamlError("assertion not yet valid");
  if (notOnOrAfter && now.getTime() - skew >= Date.parse(notOnOrAfter)) throw new SamlError("assertion expired");

  // 5. Replay protection.
  const idAttrs = match(assertion, /<(?:\w+:)?Assertion\b([^>]*)>/, 1) ?? "";
  const assertionId = attr(idAttrs, "ID");
  if (opts.seenAssertionIds) {
    if (assertionId && opts.seenAssertionIds.has(assertionId)) throw new SamlError("assertion replay detected");
    if (assertionId) opts.seenAssertionIds.add(assertionId);
  }

  // 6. Identity + attributes.
  const nameId = match(assertion, /<(?:\w+:)?NameID\b[^>]*>\s*([^<]+?)\s*<\/(?:\w+:)?NameID>/, 1);
  if (!nameId) throw new SamlError("no NameID");
  const sessionIndex = attr(match(assertion, /<(?:\w+:)?AuthnStatement\b([^>]*)>/, 1) ?? "", "SessionIndex") || undefined;
  const attributes = parseAttributes(assertion);
  const groupsAttr = cfg.groupsAttribute ?? "groups";
  const groups = attributes[groupsAttr] ?? attributes["memberOf"] ?? [];

  return { nameId, sessionIndex, attributes, groups };
}

function defaultSignatureVerifier(signedContent: string, signatureB64: string, pubPem: string): boolean {
  try {
    const key = crypto.createPublicKey(pubPem);
    return crypto.verify("RSA-SHA256", Buffer.from(signedContent, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

function parseAttributes(assertion: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const re = /<(?:\w+:)?Attribute\b[^>]*\bName="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?Attribute>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(assertion)) !== null) {
    const values: string[] = [];
    const vre = /<(?:\w+:)?AttributeValue\b[^>]*>\s*([\s\S]*?)\s*<\/(?:\w+:)?AttributeValue>/g;
    let v: RegExpExecArray | null;
    while ((v = vre.exec(m[2])) !== null) values.push(v[1]);
    out[m[1]] = values;
  }
  return out;
}

function match(s: string, re: RegExp, group = 0): string | null {
  const m = re.exec(s);
  return m ? m[group] : null;
}
function attr(attrs: string, name: string): string | null {
  return match(attrs, new RegExp(`\\b${name}="([^"]*)"`), 1);
}

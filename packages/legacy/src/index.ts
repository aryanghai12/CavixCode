export { detectLegacyLanguage, parseLegacy, type LegacyLanguage, type LegacySymbol } from "./parsers.ts";
export { analyzeLegacy, legacyRuleFindings, type LegacyAnalysis } from "./rules.ts";
export {
  proposeModernization,
  verifyModernization,
  type Migration,
  type ModernizationProposal,
  type VerifiedModernization,
} from "./modernize.ts";

/**
 * `@mandate/gemini/maker`: the mirror maker, which quotes Gemini's sandbox at the prices of Gemini's
 * production exchange from an account of its own (docs/gemini-venue.md, "The mirror maker").
 */
export { makerDoctor, type MakerDoctorOptions, type MakerDoctorStatus } from "./doctor";
export { MirrorMaker, type CycleReport, type MakerDeps, type MakerView, type MarketReader } from "./maker";
export {
  mirrorQuotes,
  quoteChanges,
  quoteKey,
  type DesiredQuote,
  type Holding,
  type MakerLimits,
  type MakerOutcome,
  type MirrorInput,
  type MirrorPlan,
  type MirrorRung,
  type QuoteChanges,
  type RestingQuote,
  type Skip,
} from "./mirror";
export {
  MAKER_DEFAULTS,
  MAKER_KINDS,
  MAKER_ORDER_PREFIX,
  makerSettings,
  type MakerKind,
  type MakerSettings,
} from "./settings";

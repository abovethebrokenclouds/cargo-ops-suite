// Landing grade bands (plan §6.3). The canonical, pure implementation lives in the
// shared protocol package so the connector's landing analyser and the web app grade
// identically; this module re-exports it for the web app.

export {
  G_BANDS,
  GRADE_LABELS,
  LANDING_GRADES,
  RATE_BANDS_FPM,
  SPEED_EXCESS_BANDS_KT,
  gGrade,
  landingGrade,
  rateGrade,
  speedGrade,
  worstGrade,
  type LandingGrade,
} from "@cargo-ops/protocol";

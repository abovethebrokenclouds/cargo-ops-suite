import { z } from "zod";
import {
  airworthinessSchema,
  annualStateSchema,
  ferryPermitSchema,
  maintenanceOrderSchema,
  systemStateSchema,
} from "./maintenance";
import { insuranceStateSchema } from "./fbo";

// Company, fleet, finance and ledger (plan §5 P4, §7, §7.2). Every domain here is
// produced by the connector's company book (or, in the browser-only demo, by the same
// pure code in packages/economy with every value tagged DEMO). All additions are
// backward compatible: P3 frames without these domains or fields still parse.
// Formulas: docs/ECONOMY.md (P4).

const finite = () => z.number().finite();
const icao = () => z.string().min(2).max(8);

// ---- reputation ----

export const REPUTATION_TIER_NAMES = [
  "Startup",
  "Regional",
  "Established",
  "Trusted",
  "Premier",
  "Elite",
] as const;

// ---- ledger ----

/** Ledger categories. `job_payout` is the P3 name of `mission_payout` (migrated). */
export const LEDGER_CATEGORIES = [
  "mission_payout",
  "fuel",
  "landing_fee",
  "lease",
  "repair",
  "purchase",
  "sale",
  "loan_disbursement",
  "loan_payment",
  "loan_fee",
  "late_fee",
  "interest",
  "insurance",
  "adjustment",
  // P5: pre-purchase and annual inspections, ferry permits.
  "inspection",
  "permit",
  // P5 part 2: FBO income, upkeep and capital; hull insurance claims.
  "fbo_income",
  "fbo_upkeep",
  "fbo_purchase",
  "fbo_construction",
  "insurance_claim",
  // Hired pilots (simulated operations): monthly wages and the hired legs' income. Their
  // fuel and landing fees use the existing categories with refType "pilot".
  "pilot_wage",
  "hired_income",
] as const;
export const ledgerCategorySchema = z.enum(LEDGER_CATEGORIES);
export type LedgerCategory = z.infer<typeof ledgerCategorySchema>;

export const ledgerEntrySchema = z.object({
  id: z.number().int().optional(),
  /** Wall clock, ISO 8601. */
  at: z.string(),
  /** Company clock (in-game time), ms since the company was founded. */
  gameMs: finite().nonnegative(),
  category: ledgerCategorySchema,
  /** Signed dollars: positive = cash in, negative = cash out. */
  amount: finite(),
  /** Cash after this entry, dollars. */
  balance: finite(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  memo: z.string().nullable(),
});
export type LedgerEntryState = z.infer<typeof ledgerEntrySchema>;

/** Operating revenue and expense of one in-game month (capital flows excluded). */
export const pnlMonthSchema = z.object({
  /** In-game month index, 0 = the month the company was founded. */
  month: z.number().int().nonnegative(),
  revenue: finite().nonnegative(),
  expense: finite().nonnegative(),
  /** revenue − expense. */
  net: finite(),
});
export type PnlMonth = z.infer<typeof pnlMonthSchema>;

/** `ledger` state domain: a summary; the full ledger is `GET /api/ledger`. */
export const ledgerDomainSchema = z.object({
  /** Newest first, at most 20. */
  recent: z.array(ledgerEntrySchema),
  /** Oldest first, the last 12 in-game months (current month last). */
  months: z.array(pnlMonthSchema),
  startingCash: finite(),
  /** Number of ledger entries in total. */
  entries: z.number().int().nonnegative(),
});
export type LedgerState = z.infer<typeof ledgerDomainSchema>;

// ---- fleet ----

export const OWNERSHIPS = ["owned", "dry_lease", "wet_lease"] as const;
export const ownershipSchema = z.enum(OWNERSHIPS);
export type Ownership = z.infer<typeof ownershipSchema>;

export const AIRCRAFT_STATUSES = [
  "available",
  "in_flight",
  "maintenance",
  "sold",
  "returned",
  "repossessed",
  // P5: destroyed in a crash (leaves the fleet).
  "written_off",
  // Assigned to a hired pilot's simulated route: unavailable to the player until unassigned.
  "hired",
] as const;
export const aircraftStatusSchema = z.enum(AIRCRAFT_STATUSES);
export type AircraftStatus = z.infer<typeof aircraftStatusSchema>;

export const fleetAircraftSchema = z.object({
  id: z.string().min(1),
  registration: z.string().min(1),
  typeKey: z.string().min(1),
  typeName: z.string(),
  ownership: ownershipSchema,
  status: aircraftStatusSchema,
  /** Airport the aircraft is parked at (moves with delivered missions). */
  location: icao(),
  /** Flight hours (airborne). */
  hours: finite().nonnegative(),
  /** Landings. */
  cycles: z.number().int().nonnegative(),
  /** Condition 0–100 % (100 = new); dispatch needs ≥ 20 %. */
  condition: finite().min(0).max(100),
  /** False under 20 % condition: missions cannot be loaded. */
  airworthy: z.boolean(),
  /** Price paid (owned) or 0 (leased), dollars. */
  purchasePrice: finite().nonnegative(),
  /** Market value (owned) or 0 (leased), dollars. */
  value: finite().nonnegative(),
  /** Repair now: cost and in-game hours. */
  repairCost: finite().nonnegative(),
  repairHours: finite().nonnegative(),
  /** In maintenance until this company-clock time, ms. */
  readyAtGameMs: finite().nonnegative().optional(),
  /** Collateral for an active loan. */
  financed: z.boolean(),
  loanId: z.string().optional(),
  /** Wall clock, ISO 8601. */
  acquiredAt: z.string(),
  // ---- P5 (optional: P4 frames have none of these) ----
  /** Airframe age, years (in-game). */
  ageYears: finite().nonnegative().optional(),
  /** Per-system condition and known defects; `condition` is their weighted mean. */
  systems: z.array(systemStateSchema).optional(),
  /** Airworthiness gate result and badge. */
  airworthiness: airworthinessSchema.optional(),
  annual: annualStateSchema.optional(),
  ferryPermit: ferryPermitSchema.optional(),
  /** Queued and running maintenance orders, oldest first. */
  maintenance: z.array(maintenanceOrderSchema).optional(),
  /** Cost and in-game hours to repair every known defect where it is parked. */
  repairAllCost: finite().nonnegative().optional(),
  repairAllHours: finite().nonnegative().optional(),
  // ---- P5 part 2 (optional) ----
  /** Hull insurance: the policy, or the quote when uninsured (owned aircraft only). */
  insurance: insuranceStateSchema.optional(),
});
export type FleetAircraft = z.infer<typeof fleetAircraftSchema>;

export const SELECTION_SOURCES = ["manual", "title", "single", "none"] as const;

/** `fleet` state domain. */
export const fleetDomainSchema = z.object({
  /** Active aircraft (sold, returned and repossessed ones are not listed). */
  aircraft: z.array(fleetAircraftSchema),
  /** Aircraft missions are loaded on. */
  selectedId: z.string().nullable(),
  selection: z.enum(SELECTION_SOURCES),
  /** The sim TITLE matches several aircraft: pick one with fleet.select. */
  ambiguous: z.boolean(),
  /** Sum of owned aircraft values, dollars. */
  value: finite().nonnegative(),
  /** P5 maintenance board: every queued or running order, by completion time. */
  maintenance: z.array(maintenanceOrderSchema).optional(),
});
export type FleetState = z.infer<typeof fleetDomainSchema>;

// ---- loans ----

export const LOAN_STATUSES = ["active", "paid_off", "defaulted"] as const;
export const loanStatusSchema = z.enum(LOAN_STATUSES);
export type LoanStatus = z.infer<typeof loanStatusSchema>;

export const COLLATERAL_TYPES = ["aircraft", "fbo"] as const;
export const collateralSchema = z.object({
  type: z.enum(COLLATERAL_TYPES),
  id: z.string().min(1),
});
export type Collateral = z.infer<typeof collateralSchema>;

export const loanSchema = z.object({
  id: z.string().min(1),
  lenderId: z.string().min(1),
  lenderName: z.string(),
  principal: finite().positive(),
  /** Annual percentage rate, percent (e.g. 9.5). */
  apr: finite().nonnegative(),
  termMonths: z.number().int().positive(),
  /** Standard amortisation monthly payment, dollars. */
  payment: finite().nonnegative(),
  /** Outstanding principal, dollars. */
  balance: finite().nonnegative(),
  collateral: collateralSchema,
  /** Company-clock time of the next auto-debit, ms. */
  nextDueGameMs: finite().nonnegative(),
  /** Consecutive missed payments (3 → repossession). */
  missedCount: z.number().int().nonnegative(),
  paymentsMade: z.number().int().nonnegative(),
  status: loanStatusSchema,
  takenAt: z.string(),
  takenGameMs: finite().nonnegative(),
});
export type LoanState = z.infer<typeof loanSchema>;

export const lenderSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  appetite: z.enum(["conservative", "balanced", "aggressive"]),
  minApr: finite(),
  maxApr: finite(),
  maxLtv: finite(),
  minTermMonths: z.number().int().positive(),
  maxTermMonths: z.number().int().positive(),
  minScore: z.number().int(),
  minTier: z.number().int(),
});
export type Lender = z.infer<typeof lenderSchema>;

export const lenderOfferSchema = z.object({
  lenderId: z.string(),
  lenderName: z.string(),
  eligible: z.boolean(),
  /** Why the lender declines (score, tier, default). */
  reason: z.string().optional(),
  apr: finite(),
  maxLtv: finite(),
  minTermMonths: z.number().int(),
  maxTermMonths: z.number().int(),
});
export type LenderOffer = z.infer<typeof lenderOfferSchema>;

/** `loans` state domain. */
export const loansDomainSchema = z.object({
  /** Active loans first, then the most recent closed ones. */
  loans: z.array(loanSchema),
  /** 0–850 (halved for 12 in-game months after a default). */
  creditScore: z.number().int().min(0).max(850),
  /** Company-clock time until which the default flag applies, ms. */
  defaultUntilGameMs: finite().nonnegative().nullable(),
  offers: z.array(lenderOfferSchema),
  /** Sum of active monthly payments, dollars. */
  monthlyDebtService: finite().nonnegative(),
  /** Average operating revenue of the last 3 in-game months, dollars. */
  monthlyIncome: finite().nonnegative(),
  /** monthlyDebtService / monthlyIncome (null when there is no income). */
  debtToIncome: finite().nonnegative().nullable(),
});
export type LoansState = z.infer<typeof loansDomainSchema>;

/** Company clock (in-game time). */
export const companyClockSchema = z.object({
  /** ms since the company was founded. */
  gameMs: finite().nonnegative(),
  /** 1-based in-game month and day (30-day months). */
  month: z.number().int().positive(),
  day: z.number().int().positive(),
});
export type CompanyClock = z.infer<typeof companyClockSchema>;

// ---- command arguments ----

const aircraftIdArgs = z.object({ aircraftId: z.string().min(1) }).strict();

export const fleetBuyArgsSchema = z
  .object({
    typeKey: z.string().min(1),
    /** Delivery airport; defaults to the selected aircraft's location, else the base. */
    airport: icao().optional(),
    financing: z
      .object({
        lenderId: z.string().min(1),
        termMonths: z.number().int().positive(),
        principal: z.number().finite().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const fleetSellArgsSchema = aircraftIdArgs;
export const fleetLeaseArgsSchema = z
  .object({
    typeKey: z.string().min(1),
    kind: z.enum(["dry", "wet"]),
    airport: icao().optional(),
  })
  .strict();
export const fleetReturnArgsSchema = aircraftIdArgs;
export const fleetRepairArgsSchema = aircraftIdArgs;
export const fleetSelectArgsSchema = z
  .object({ aircraftId: z.string().min(1).nullable() })
  .strict();
export const loanQuoteArgsSchema = z
  .object({
    lenderId: z.string().min(1).optional(),
    principal: z.number().finite().positive(),
    termMonths: z.number().int().positive(),
    /** Collateral value for a purchase quote; else the collateral's market value. */
    collateralValue: z.number().finite().positive().optional(),
    collateral: collateralSchema.optional(),
  })
  .strict();
export const loanTakeArgsSchema = z
  .object({
    lenderId: z.string().min(1),
    principal: z.number().finite().positive(),
    termMonths: z.number().int().positive(),
    collateral: collateralSchema,
  })
  .strict();
export const loanPayoffArgsSchema = z.object({ loanId: z.string().min(1) }).strict();

/** One lender's answer to loan.quote. */
export const loanQuoteSchema = z.object({
  lenderId: z.string(),
  lenderName: z.string(),
  ok: z.boolean(),
  code: z.string().optional(),
  message: z.string().optional(),
  principal: finite(),
  termMonths: z.number().int(),
  apr: finite(),
  payment: finite(),
  originationFee: finite(),
  totalInterest: finite(),
  ltv: finite().nullable(),
});
export type LoanQuote = z.infer<typeof loanQuoteSchema>;

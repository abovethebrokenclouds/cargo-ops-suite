// Milestones (plan §7.4): reached once, persisted with the in-game and wall-clock date.

import { MILESTONE_IDS, type Milestone, type MilestoneId } from "../../protocol/src/fbo";
import { MILESTONES } from "./fbo-constants";

export interface MilestoneRecord {
  id: MilestoneId;
  gameMs: number;
  /** Wall clock, ms. */
  at: number;
}

export const MILESTONE_TEXT: Record<MilestoneId, { title: string; description: string }> = {
  first_delivery: { title: "First delivery", description: "Deliver a mission and get paid" },
  hours_100: {
    title: `${MILESTONES.hours} flight hours`,
    description: `Fly ${MILESTONES.hours} hours with the company's aircraft`,
  },
  first_fbo: { title: "First FBO", description: "Buy or build a fixed-base operation" },
  debt_free: { title: "Debt-free", description: "Pay off every loan you have taken" },
  landing_streak: {
    title: "Perfect landing streak",
    description: `${MILESTONES.streak} deliveries in a row landed A or better`,
  },
  first_restoration: {
    title: "First restoration",
    description: "Repair every known defect of a used aircraft you bought",
  },
  fleet_three: {
    title: "Growing fleet",
    description: `Operate ${MILESTONES.fleet} aircraft at once`,
  },
  fbo_network: {
    title: "FBO network",
    description: `Own FBOs at ${MILESTONES.fboNetwork} airports`,
  },
};

/** Every milestone in display order, reached ones with their dates. */
export function milestoneList(reached: readonly MilestoneRecord[]): Milestone[] {
  const byId = new Map(reached.map((r) => [r.id, r]));
  return MILESTONE_IDS.map((id) => {
    const r = byId.get(id);
    return {
      id,
      ...MILESTONE_TEXT[id],
      reached: r !== undefined,
      ...(r ? { gameMs: r.gameMs, at: new Date(r.at).toISOString() } : {}),
    };
  });
}

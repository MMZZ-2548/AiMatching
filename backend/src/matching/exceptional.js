/**
 * Exceptional far match — V5 §19–§27, SCORING_SPEC §8.
 *
 * The rule exists so that a caregiver who fits almost perfectly but lives outside the normal
 * service radius is still surfaced — in a *separate* section, never as normal rank #1 (V5 §19),
 * and never at the cost of a safety filter (V5 §25).
 */

import { EXCEPTIONAL } from './config.js';
import { SOFT_FILTER } from './hardFilters.js';

/**
 * @param {object} args
 * @param {string[]} args.failed        hard filters this candidate failed
 * @param {number}  args.baseMutualFit  score BEFORE the distance penalty (V5 §20.3)
 * @param {number}  args.distanceKm
 * @returns {{exceptional:boolean, reasons:string[], blockers:string[]}}
 */
export function evaluateExceptional({
  failed,
  baseMutualFit,
  distanceKm,
  caregiver,
  careRequest,
  scheduleOk = true,
  travelFeasible = true,
}) {
  const blockers = [];
  const reasons = [];

  if (!EXCEPTIONAL.enabled) return { exceptional: false, reasons, blockers: ['disabled'] };

  // Every filter except distance is absolute. V5 §25: distance is the only soft exception,
  // so a candidate missing a mandatory skill can never be rescued here (V5 case 4 / V6 E05).
  const nonDistanceFailures = failed.filter((f) => f !== SOFT_FILTER);
  if (nonDistanceFailures.length) {
    blockers.push(`hard filter: ${nonDistanceFailures.join(', ')}`);
    return { exceptional: false, reasons, blockers };
  }
  if (!failed.includes(SOFT_FILTER)) {
    // inside the radius — a normal candidate, not an exceptional one
    return { exceptional: false, reasons, blockers: ['within service radius'] };
  }

  if (EXCEPTIONAL.mandatorySkillsRequired) reasons.push('mandatory skills complete');

  if (!(baseMutualFit >= EXCEPTIONAL.baseFitThreshold)) {
    blockers.push(
      `base mutual fit ${baseMutualFit.toFixed(1)} < ${EXCEPTIONAL.baseFitThreshold}`,
    );
  } else {
    reasons.push(`base mutual fit ${baseMutualFit.toFixed(1)} ≥ ${EXCEPTIONAL.baseFitThreshold}`);
  }

  if (distanceKm > EXCEPTIONAL.maxDistanceKm) {
    blockers.push(`${distanceKm.toFixed(0)}km > platform max ${EXCEPTIONAL.maxDistanceKm}km`);
  }

  if (EXCEPTIONAL.requireCaregiverOptIn && !caregiver.out_of_area_enabled) {
    blockers.push('caregiver has not opted in to out-of-area work');
  } else if (EXCEPTIONAL.requireCaregiverOptIn) {
    reasons.push('caregiver accepts out-of-area work');
  }

  const cgMax = Number(caregiver.max_out_of_area_distance_km ?? 0);
  if (caregiver.out_of_area_enabled && cgMax > 0 && distanceKm > cgMax) {
    blockers.push(`${distanceKm.toFixed(0)}km beyond caregiver limit ${cgMax}km`);
  }

  if (EXCEPTIONAL.requireFamilyOptIn && !careRequest.accept_out_of_area) {
    blockers.push('family has not opted in to out-of-area caregivers');
  } else if (EXCEPTIONAL.requireFamilyOptIn) {
    reasons.push('family accepts out-of-area caregivers');
  }

  if (!scheduleOk) blockers.push('schedule no longer satisfiable with travel');
  if (!travelFeasible) blockers.push('travel not feasible');

  return { exceptional: blockers.length === 0, reasons, blockers };
}

/**
 * V5 §21 — additional cost estimate. Always presented as an *estimate*, never a final price.
 */
export function estimateAdditionalCost(caregiver, distanceKm) {
  const perKm = Number(caregiver.travel_fee_per_km ?? 0);
  const travel = Math.round(distanceKm * 2 * perKm);

  const accomAfter = Number(caregiver.accommodation_required_after_km ?? Infinity);
  const needsAccommodation = distanceKm >= accomAfter;
  const accommodation = needsAccommodation
    ? Math.round(Number(caregiver.accommodation_minimum ?? 0))
    : 0;

  return {
    travel,
    accommodation,
    total_extra: travel + accommodation,
    accommodation_required: needsAccommodation,
    currency: 'THB',
    label: 'Estimated additional cost',
    is_final_price: false,
  };
}

/**
 * V5 §26 case 8 — an exceptional booking that needs accommodation cannot be finalised until
 * accommodation has actually been agreed.
 */
export function blocksFinalBooking(jobRequest, costEstimate) {
  return Boolean(costEstimate?.accommodation_required) && !jobRequest.accommodation_agreed;
}

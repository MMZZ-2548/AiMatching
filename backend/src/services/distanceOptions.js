/**
 * The two ways a family can answer "how far is too far", presented side by side.
 *
 * Matching already separates candidates into those inside the service radius and those who are an
 * exceptional fit further away (V5 §19). What the family actually has to decide is a trade-off with
 * money in it: take the nearest person at the price already agreed, or take the better fit and pay
 * for travel and possibly a night's accommodation on top.
 *
 * Presenting that as two priced options is the honest form of the question. A ranked list with a
 * far candidate quietly sitting in it does not tell anyone they are about to spend more.
 *
 * The same comparison is shown to the caregiver from the other side: a far job pays the same base
 * rate but costs them a longer trip, so the extra has to be agreed with the family before either
 * of them commits (V5 §21 — an estimate, never a final price).
 */

import { estimateAdditionalCost } from '../matching/exceptional.js';

/** Everything a viewer needs to compare one candidate as an option, cost included. */
function asOption(candidate, caregiver, budget) {
  const base = Number(budget ?? 0);
  const extra = candidate.exceptional_match && caregiver
    ? estimateAdditionalCost(caregiver, candidate.distance_km ?? 0)
    : null;

  return {
    caregiver_id: candidate.caregiver_id,
    name: caregiver?.display_name ?? candidate.caregiver_id,
    distance_km: candidate.distance_km,
    travel_minutes: candidate.travel_minutes,
    base_mutual_fit: candidate.base_mutual_fit,
    final_mutual_fit: candidate.final_mutual_fit,
    // The compatibility figure, before distance was allowed to drag it down — this is the number
    // that makes a far candidate worth considering at all.
    compatibility: candidate.base_mutual_fit,
    exceptional: Boolean(candidate.exceptional_match),
    cost: {
      base_rate: base,
      travel: extra?.travel ?? 0,
      accommodation: extra?.accommodation ?? 0,
      extra_total: extra?.total_extra ?? 0,
      estimated_total: base + (extra?.total_extra ?? 0),
      accommodation_required: Boolean(extra?.accommodation_required),
      currency: 'THB',
      is_final_price: false,
      label: extra ? 'ประมาณการ ยังไม่ใช่ราคาสุดท้าย' : 'ไม่มีค่าใช้จ่ายเพิ่ม',
    },
  };
}

/**
 * Build the comparison the family sees after matching.
 *
 * @param {object} result   engine output
 * @param {Map}    byId     caregiver_id -> caregiver row
 * @param {object} careRequest
 */
export function buildDistanceOptions(result, byId, careRequest) {
  const budget = Number(careRequest?.budget ?? 0);
  const radius = Number(careRequest?.search_radius_km ?? 25);

  const nearby = result.recommended_nearby.map((c) =>
    asOption(c, byId.get(c.caregiver_id), budget));

  // A far candidate the family would never actually consider is noise, not an option.
  const far = result.exceptional_matches
    .filter((c) => c.distance_km == null || c.distance_km <= radius * 4 || careRequest?.accept_out_of_area)
    .map((c) => asOption(c, byId.get(c.caregiver_id), budget));

  const bestNear = nearby[0] ?? null;
  const bestFar = [...far].sort((a, b) => b.compatibility - a.compatibility)[0] ?? null;

  let recommendation = null;
  if (bestNear && bestFar) {
    const gap = Math.round(bestFar.compatibility - bestNear.compatibility);
    const extra = bestFar.cost.extra_total;
    recommendation = {
      compatibility_gap: gap,
      extra_cost: extra,
      // Deliberately not a verdict. The family is told what the difference costs and decides;
      // nothing here picks for them.
      summary: gap > 0
        ? `คนที่อยู่ไกลเหมาะกว่า ${gap} คะแนน แต่มีค่าใช้จ่ายเพิ่มประมาณ ${extra.toLocaleString()} บาท`
        : `คนที่อยู่ใกล้เหมาะพอ ๆ กันหรือดีกว่า และไม่มีค่าใช้จ่ายเพิ่ม`,
    };
  }

  return {
    search_radius_km: radius,
    accept_out_of_area: Boolean(careRequest?.accept_out_of_area),
    nearest: {
      key: 'NEAREST',
      title: 'เลือกคนที่อยู่ใกล้',
      subtitle: 'อยู่ในระยะที่ตกลงไว้ ไม่มีค่าเดินทางหรือค่าที่พักเพิ่ม',
      count: nearby.length,
      best: bestNear,
      options: nearby.slice(0, 5),
    },
    best_fit_far: {
      key: 'BEST_FIT_FAR',
      title: 'เลือกคนที่เหมาะที่สุด แม้อยู่ไกล',
      subtitle: 'ความเข้ากันสูงกว่า แต่ต้องจ่ายค่าเดินทางและอาจมีค่าที่พัก และต้องตกลงกันทั้งสองฝ่าย',
      count: far.length,
      best: bestFar,
      options: far.slice(0, 5),
      requires_both_to_agree: true,
    },
    recommendation,
  };
}

/**
 * The caregiver's version of the same decision: a far job pays the same base rate, so the extra
 * travel has to be worth it and has to be agreed with the family first.
 */
export function caregiverDistanceNote(candidate, caregiver) {
  if (!candidate?.exceptional_match) return null;
  const extra = estimateAdditionalCost(caregiver, candidate.distance_km ?? 0);
  return {
    distance_km: candidate.distance_km,
    travel_minutes: candidate.travel_minutes,
    estimated_extra: extra.total_extra,
    travel: extra.travel,
    accommodation: extra.accommodation,
    accommodation_required: extra.accommodation_required,
    is_final_price: false,
    message:
      'งานนี้อยู่นอกพื้นที่ปกติของคุณ ค่าเดินทางและที่พักเป็นเพียงประมาณการ ' +
      'ต้องตกลงกับครอบครัวก่อนว่าจะจ่ายเพิ่มให้หรือไม่ จึงจะรับงานได้',
  };
}

"""
Independent verification of TrustCare's HHCRSP solutions.

V6 §3 lists "Validator Pass Rate" as a metric and singles out the repository's own Python
validator as the reason HHCRSP was chosen. This script runs *that* validator — code TrustCare did
not write — over the solutions our engine produced, so the constraint result does not rest on our
own audit alone.

The upstream validator asserts that every patient in an instance is served, so it can only judge
the instances our greedy pass covered completely. That subset is reported explicitly rather than
quietly dropped: coverage is a property of the greedy policy, and the point here is whether the
assignments we *did* make satisfy the published constraints.

    python scripts/run_hhcrsp_validator.py
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VALIDATOR_DIR = ROOT / "data" / "hhcrsp2" / "validator"
SOLUTIONS_DIR = ROOT / "reports" / "hhcrsp_solutions"
INSTANCE_FAMILIES = ("mankowska", "kummer", "Italian")

sys.path.insert(0, str(VALIDATOR_DIR))

try:
    from instance import Instance  # type: ignore
    from solution import Solution, validate_solution  # type: ignore
except ImportError as exc:  # pragma: no cover
    print(f"cannot import the upstream validator: {exc}")
    print("install its dependencies first:  pip install pyparsing numpy scipy click pandas")
    sys.exit(2)


def find_instance(name: str) -> Path | None:
    for fam in INSTANCE_FAMILIES:
        p = ROOT / "data" / "hhcrsp2" / "instances" / fam / name
        if p.exists():
            return p
    return None


def main() -> int:
    results = []
    passed = failed = skipped = 0

    for sol_path in sorted(SOLUTIONS_DIR.glob("*.json")):
        inst_path = find_instance(sol_path.name)
        if inst_path is None:
            continue

        instance_raw = inst_path.read_text(encoding="utf-8")
        solution_raw = sol_path.read_text(encoding="utf-8")

        # Instances the greedy did not fully cover cannot be judged: the validator requires
        # every patient to be served before it will look at any constraint.
        inst_json = json.loads(instance_raw)
        sol_json = json.loads(solution_raw)
        served = {loc["patient"] for r in sol_json["routes"] for loc in r["locations"]}
        needed = {p["id"] for p in inst_json["patients"]}
        if not served >= needed:
            skipped += 1
            results.append({
                "instance": sol_path.stem,
                "status": "SKIPPED_INCOMPLETE_COVERAGE",
                "unserved_patients": len(needed - served),
            })
            continue

        try:
            inst = Instance(instance_raw)
            sol = Solution(solution_raw, inst)
            cost = validate_solution(inst, sol)
            passed += 1
            results.append({
                "instance": sol_path.stem,
                "status": "VALID",
                "distance_traveled": round(float(cost.get("distance_traveled", 0)), 3),
            })
        except AssertionError as exc:
            failed += 1
            results.append({"instance": sol_path.stem, "status": "INVALID", "reason": str(exc)[:300]})
        except Exception as exc:  # noqa: BLE001 - report, never hide
            failed += 1
            results.append({
                "instance": sol_path.stem,
                "status": "ERROR",
                "reason": f"{type(exc).__name__}: {exc}"[:300],
                "trace": traceback.format_exc(limit=2)[:400],
            })

    judged = passed + failed
    summary = {
        "validator": "iolab-uniud/hhcrsp validator (upstream, MIT) — not written by TrustCare",
        "solutions_submitted": passed + failed + skipped,
        "judged": judged,
        "valid": passed,
        "invalid": failed,
        "skipped_incomplete_coverage": skipped,
        "validator_pass_rate_pct": round(passed / judged * 100, 2) if judged else None,
        "note": (
            "The upstream validator requires every patient in an instance to be served before it "
            "will assess constraints, so instances our greedy policy left partially covered cannot "
            "be judged. Coverage is a property of that policy; this figure is about whether the "
            "assignments actually made satisfy the published constraints."
        ),
    }

    out = ROOT / "reports" / "hhcrsp_validator_results.json"
    out.write_text(json.dumps({"summary": summary, "results": results}, indent=2), encoding="utf-8")

    print("\n=== HHCRSP upstream validator (independent) ===")
    print(f"Solutions submitted            {summary['solutions_submitted']}")
    print(f"Judged                         {judged}")
    print(f"  VALID                        {passed}")
    print(f"  INVALID                      {failed}")
    print(f"Skipped (partial coverage)     {skipped}")
    print(f"Validator pass rate            {summary['validator_pass_rate_pct']}%")

    if failed:
        print("\nfailures:")
        for r in results:
            if r["status"] in ("INVALID", "ERROR"):
                print(f"  {r['instance']}: {r.get('reason')}")

    print(f"\nWrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

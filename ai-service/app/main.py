"""
TrustCare Python AI Service — V4 §2, §37.

Scope discipline, straight from V4 §0 and §4: this service does language work only.
It never produces a Match Score, a hard-filter decision, a Trust Score or a realtime state.
Matching explanation receives an already-computed, deterministic breakdown and is allowed to
phrase it — nothing more (V4 §21).

Every route requires x-internal-api-key (V4 §37).
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, UploadFile, File, Form
from fastapi.responses import JSONResponse

from .schemas import (
    AdvisorChatRequest,
    AdvisorChatResponse,
    CareRequestExtraction,
    IntakeExtractRequest,
    IntakeExtractResponse,
    MatchingExplainRequest,
    MatchingExplainResponse,
    ReportStructureRequest,
    ReportStructureResponse,
    CarePlanRequest,
    CarePlanResponse,
    CarePlanItem,
)
from .prompts import (
    ADVISOR_SYSTEM_PROMPT,
    CARE_PLAN_SYSTEM_PROMPT,
    INTAKE_SYSTEM_PROMPT,
    MATCHING_EXPLAIN_SYSTEM_PROMPT,
    REPORT_SYSTEM_PROMPT,
)

app = FastAPI(title="TrustCare AI Service", version="1.0.0")

INTERNAL_KEY = os.getenv("PYTHON_AI_INTERNAL_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
TEXT_MODEL = os.getenv("OPENAI_TEXT_MODEL", "gpt-4o-mini")
STT_MODEL = os.getenv("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe")
OPENAI_BASE = "https://api.openai.com/v1"


def require_internal_key(x_internal_api_key: str = Header(default="")) -> None:
    """V4 §37 — the AI service is internal; the Node backend is its only caller."""
    if not INTERNAL_KEY:
        raise HTTPException(500, "PYTHON_AI_INTERNAL_KEY is not configured")
    if x_internal_api_key != INTERNAL_KEY:
        raise HTTPException(401, "invalid internal api key")


class OpenAIUnavailable(Exception):
    """Raised when the model cannot be reached. Never swallowed into a fake success (V4 §52)."""


async def chat_json(system: str, user: str, *, temperature: float = 0.2) -> dict[str, Any]:
    """One JSON-mode completion. Returns parsed JSON or raises OpenAIUnavailable."""
    if not OPENAI_API_KEY:
        raise OpenAIUnavailable("OPENAI_API_KEY is not set")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.post(
                f"{OPENAI_BASE}/chat/completions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                json={
                    "model": TEXT_MODEL,
                    "temperature": temperature,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                },
            )
    except httpx.HTTPError as exc:
        raise OpenAIUnavailable(str(exc)) from exc

    if res.status_code != 200:
        raise OpenAIUnavailable(f"openai {res.status_code}: {res.text[:200]}")
    try:
        return json.loads(res.json()["choices"][0]["message"]["content"])
    except (KeyError, ValueError) as exc:
        raise OpenAIUnavailable(f"unparseable model output: {exc}") from exc


async def chat_text(system: str, messages: list[dict[str, str]]) -> str:
    if not OPENAI_API_KEY:
        raise OpenAIUnavailable("OPENAI_API_KEY is not set")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.post(
                f"{OPENAI_BASE}/chat/completions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                json={
                    "model": TEXT_MODEL,
                    "temperature": 0.3,
                    "messages": [{"role": "system", "content": system}, *messages],
                },
            )
    except httpx.HTTPError as exc:
        raise OpenAIUnavailable(str(exc)) from exc
    if res.status_code != 200:
        raise OpenAIUnavailable(f"openai {res.status_code}: {res.text[:200]}")
    return res.json()["choices"][0]["message"]["content"]


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "up",
        "text_model": TEXT_MODEL,
        "stt_model": STT_MODEL,
        # presence only — never the value (V4 §5)
        "openai_key": "set" if OPENAI_API_KEY else "MISSING",
        "internal_key": "set" if INTERNAL_KEY else "MISSING",
        # Fingerprints of the loaded prompts, so a stale worker is visible rather than silent.
        "prompt_versions": {
            "intake": hashlib.sha256(INTAKE_SYSTEM_PROMPT.encode()).hexdigest()[:8],
            "advisor": hashlib.sha256(ADVISOR_SYSTEM_PROMPT.encode()).hexdigest()[:8],
            "explain": hashlib.sha256(MATCHING_EXPLAIN_SYSTEM_PROMPT.encode()).hexdigest()[:8],
            "report": hashlib.sha256(REPORT_SYSTEM_PROMPT.encode()).hexdigest()[:8],
        },
    }


# ───────────────────────────────────────────── smart intake (V4 §12, §13)

@app.post("/internal/ai/intake/extract", response_model=IntakeExtractResponse)
async def intake_extract(
    req: IntakeExtractRequest, _: None = Depends(require_internal_key)
) -> IntakeExtractResponse:
    user = json.dumps(
        {"utterance": req.text, "known_profile": req.profile_context}, ensure_ascii=False
    )
    try:
        # Temperature 0: structured extraction should give the same answer for the same sentence.
        # At 0.2 the same Thai utterance intermittently lost `conditions` and `mobility`.
        raw = await chat_json(INTAKE_SYSTEM_PROMPT, user, temperature=0.0)
    except OpenAIUnavailable as exc:
        # V4 §52 — say the call did not happen rather than inventing an extraction.
        return IntakeExtractResponse(
            ai_available=False, degraded_reason=str(exc), extracted=None, missing_fields=[],
            follow_up_questions=[],
        )

    extracted = CareRequestExtraction(**raw.get("extracted", {}))
    return IntakeExtractResponse(
        ai_available=True,
        extracted=extracted,
        missing_fields=raw.get("missing_fields", []),
        follow_up_questions=raw.get("follow_up_questions", [])[:3],  # V4 §12: at most 1–3
    )


# ───────────────────────────────────────────── matching explanation (V4 §21)

@app.post("/internal/ai/matching/explain", response_model=MatchingExplainResponse)
async def matching_explain(
    req: MatchingExplainRequest, _: None = Depends(require_internal_key)
) -> MatchingExplainResponse:
    """
    The scores arrive already computed and leave untouched. V4 §21 forbids GPT changing rank,
    score or eligibility, so those fields are echoed from the request rather than re-read from
    the model's reply.
    """
    payload = json.dumps(req.model_dump(), ensure_ascii=False, default=str)
    try:
        raw = await chat_json(MATCHING_EXPLAIN_SYSTEM_PROMPT, payload, temperature=0.3)
    except OpenAIUnavailable as exc:
        return MatchingExplainResponse(
            ai_available=False,
            degraded_reason=str(exc),
            mutual_fit_score=req.mutual_fit_score,
            reasons=[r.get("reason", "") for r in req.deterministic_reasons],
            tradeoffs=[],
            unknowns=[],
            warnings=[],
        )

    allowed = {r.get("reason", "") for r in req.deterministic_reasons}
    model_reasons = [str(x) for x in raw.get("reasons", [])][:6]

    return MatchingExplainResponse(
        ai_available=True,
        mutual_fit_score=req.mutual_fit_score,  # echoed, never taken from the model
        reasons=model_reasons or list(allowed),
        tradeoffs=[str(x) for x in raw.get("tradeoffs", [])][:4],
        unknowns=[str(x) for x in raw.get("unknowns", [])][:4],
        warnings=[str(x) for x in raw.get("warnings", [])][:4],
        grounded_in=sorted(allowed),
    )


# ───────────────────────────────────────────── care advisor (V4 §28, §29)

@app.post("/internal/ai/advisor/chat", response_model=AdvisorChatResponse)
async def advisor_chat(
    req: AdvisorChatRequest, _: None = Depends(require_internal_key)
) -> AdvisorChatResponse:
    context_note = (
        f"\n\nข้อมูลที่ระบบส่งให้ (ใช้เท่าที่มี ห้ามเดาเพิ่ม):\n"
        f"{json.dumps(req.context, ensure_ascii=False)}"
        if req.context
        else ""
    )
    try:
        reply = await chat_text(
            ADVISOR_SYSTEM_PROMPT + context_note,
            [{"role": m.role, "content": m.content} for m in req.messages][-12:],
        )
    except OpenAIUnavailable as exc:
        return AdvisorChatResponse(
            ai_available=False,
            degraded_reason=str(exc),
            reply="ขออภัย ระบบผู้ช่วย AI ไม่พร้อมใช้งานขณะนี้ กรุณาลองใหม่อีกครั้ง",
        )
    return AdvisorChatResponse(ai_available=True, reply=reply)


# ───────────────────────────────────────────── daily report (V4 §32)

@app.post("/internal/ai/report/structure", response_model=ReportStructureResponse)
async def report_structure(
    req: ReportStructureRequest, _: None = Depends(require_internal_key)
) -> ReportStructureResponse:
    try:
        raw = await chat_json(REPORT_SYSTEM_PROMPT, req.text)
    except OpenAIUnavailable as exc:
        return ReportStructureResponse(ai_available=False, degraded_reason=str(exc), structured=None)
    return ReportStructureResponse(ai_available=True, structured=raw)


# ───────────────────────────────────────────── speech to text (V4 §27)

@app.post("/internal/ai/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    context: str = Form("MATCHING_INTAKE"),
    _: None = Depends(require_internal_key),
) -> JSONResponse:
    """
    Returns a transcript for preview only. V4 §27 forbids saving a transcript as final data
    without the user confirming it, so the response is explicit that it is unconfirmed.
    """
    if not OPENAI_API_KEY:
        return JSONResponse(
            {"ai_available": False, "degraded_reason": "OPENAI_API_KEY is not set", "transcript": None},
            status_code=200,
        )
    data = await audio.read()
    if not data:
        raise HTTPException(400, "empty audio file")
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            res = await client.post(
                f"{OPENAI_BASE}/audio/transcriptions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                files={"file": (audio.filename or "audio.wav", data, audio.content_type or "audio/wav")},
                data={"model": STT_MODEL, "language": "th"},
            )
    except httpx.HTTPError as exc:
        return JSONResponse({"ai_available": False, "degraded_reason": str(exc), "transcript": None})

    if res.status_code != 200:
        return JSONResponse(
            {"ai_available": False, "degraded_reason": f"openai {res.status_code}", "transcript": None}
        )
    return JSONResponse(
        {
            "ai_available": True,
            "context": context,
            "transcript": res.json().get("text", ""),
            "confirmed": False,  # V4 §27 — never auto-save as final
        }
    )


# ───────────────────────────────────────────── daily care plan (V4 §26)

@app.post("/internal/ai/careplan/structure", response_model=CarePlanResponse)
async def careplan_structure(
    req: CarePlanRequest, _: None = Depends(require_internal_key)
) -> CarePlanResponse:
    """
    Turn what a family dictated into an ordered daily plan.

    Temperature 0: the same sentence must always produce the same schedule, because the caregiver
    is going to work from it. Time conversion is re-verified on the Node side against the original
    text (backend/src/lib/thaiTime.js) — this endpoint is not the last word on any time.
    """
    try:
        raw = await chat_json(CARE_PLAN_SYSTEM_PROMPT, req.text, temperature=0.0)
    except OpenAIUnavailable as exc:
        return CarePlanResponse(ai_available=False, degraded_reason=str(exc), items=[])

    items = []
    for it in raw.get("items", []) or []:
        if not isinstance(it, dict) or not it.get("title"):
            continue
        items.append(
            CarePlanItem(
                time=it.get("time"),
                raw_time=it.get("raw_time"),
                title=str(it["title"]),
                task_code=str(it.get("task_code") or "OTHER"),
                critical=bool(it.get("critical")),
            )
        )
    return CarePlanResponse(ai_available=True, items=items, notes=raw.get("notes"))

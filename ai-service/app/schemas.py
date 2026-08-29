"""Pydantic v2 schemas for the AI service (V4 §13)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class CareRequestExtraction(BaseModel):
    """V4 §13. Rules: never invent a value; mark vague times approximate; never overwrite
    confirmed data without an explicit user correction."""

    care_date: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    conditions: list[str] = Field(default_factory=list)
    mobility: str | None = None
    requested_tasks: list[str] = Field(default_factory=list)
    budget: float | None = None
    required_skills: list[str] = Field(default_factory=list)
    preferences: dict[str, Any] = Field(default_factory=dict)
    additional_notes: str | None = None
    uncertain_fields: list[str] = Field(default_factory=list)
    approximate_fields: list[str] = Field(default_factory=list)

    # The model legitimately has nothing to put in a collection field and writes `null` rather
    # than `[]` or `{}`. That is the same meaning, so coerce it instead of rejecting a response
    # whose scalar fields were extracted correctly.
    @field_validator(
        "conditions", "requested_tasks", "required_skills",
        "uncertain_fields", "approximate_fields", mode="before",
    )
    @classmethod
    def _none_to_empty_list(cls, v: Any) -> Any:
        return [] if v is None else v

    @field_validator("preferences", mode="before")
    @classmethod
    def _none_to_empty_dict(cls, v: Any) -> Any:
        return {} if v is None else v


class IntakeExtractRequest(BaseModel):
    text: str
    profile_context: dict[str, Any] = Field(default_factory=dict)


class IntakeExtractResponse(BaseModel):
    ai_available: bool
    degraded_reason: str | None = None
    extracted: CareRequestExtraction | None = None
    missing_fields: list[str] = Field(default_factory=list)
    follow_up_questions: list[str] = Field(default_factory=list)


class MatchingExplainRequest(BaseModel):
    mutual_fit_score: float | None = None
    base_mutual_fit: float | None = None
    family_fit: float | None = None
    job_fit: float | None = None
    distance_km: float | None = None
    feature_values: dict[str, Any] = Field(default_factory=dict)
    hard_filter_results: dict[str, Any] = Field(default_factory=dict)
    deterministic_reasons: list[dict[str, Any]] = Field(default_factory=list)


class MatchingExplainResponse(BaseModel):
    ai_available: bool
    degraded_reason: str | None = None
    mutual_fit_score: float | None = None
    reasons: list[str] = Field(default_factory=list)
    tradeoffs: list[str] = Field(default_factory=list)
    unknowns: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    grounded_in: list[str] = Field(default_factory=list)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class AdvisorChatRequest(BaseModel):
    messages: list[ChatMessage]
    context: dict[str, Any] = Field(default_factory=dict)


class AdvisorChatResponse(BaseModel):
    ai_available: bool
    degraded_reason: str | None = None
    reply: str


class ReportStructureRequest(BaseModel):
    text: str


class ReportStructureResponse(BaseModel):
    ai_available: bool
    degraded_reason: str | None = None
    structured: dict[str, Any] | None = None


class CarePlanItem(BaseModel):
    """One line of a daily care plan. `raw_time` keeps what the family actually said, so the
    Node side can re-check the conversion rather than trusting it."""

    time: str | None = None
    raw_time: str | None = None
    title: str
    task_code: str = "OTHER"
    critical: bool = False


class CarePlanRequest(BaseModel):
    text: str


class CarePlanResponse(BaseModel):
    ai_available: bool
    degraded_reason: str | None = None
    items: list[CarePlanItem] = Field(default_factory=list)
    notes: str | None = None

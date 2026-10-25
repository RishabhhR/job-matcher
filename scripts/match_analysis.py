#!/usr/bin/env python3
"""Deterministic, explainable job-match analysis for shadow evaluation.

Input and output are JSON over stdin/stdout. This process does not persist or log
candidate CVs, profiles, job descriptions, or any derived personal data.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any


SKILL_ALIASES: dict[str, tuple[str, ...]] = {
    "python": ("python",),
    "typescript": ("typescript", "ts"),
    "javascript": ("javascript", "js", "ecmascript"),
    "java": ("java",),
    "go": ("golang", "go language"),
    "rust": ("rust",),
    "sql": ("sql", "structured query language"),
    "postgresql": ("postgresql", "postgres", "psql"),
    "mysql": ("mysql",),
    "mongodb": ("mongodb", "mongo db"),
    "redis": ("redis",),
    "aws": ("aws", "amazon web services"),
    "gcp": ("gcp", "google cloud platform"),
    "azure": ("azure",),
    "kubernetes": ("kubernetes", "k8s"),
    "docker": ("docker",),
    "terraform": ("terraform",),
    "linux": ("linux",),
    "api design": ("api design", "rest api", "restful api", "graphql"),
    "system design": ("system design", "distributed systems"),
    "machine learning": ("machine learning", "ml", "deep learning"),
    "data analysis": ("data analysis", "data analytics", "business analytics"),
    "pandas": ("pandas",),
    "scikit-learn": ("scikit-learn", "sklearn"),
    "tensorflow": ("tensorflow",),
    "pytorch": ("pytorch",),
    "tableau": ("tableau",),
    "power bi": ("power bi", "powerbi"),
    "experimentation": ("experimentation", "a/b testing", "ab testing"),
    "product strategy": ("product strategy", "product vision", "roadmap strategy"),
    "product analytics": ("product analytics", "funnel analysis", "cohort analysis"),
    "roadmapping": ("roadmap", "roadmapping", "product roadmap"),
    "user research": ("user research", "customer research", "usability research"),
    "figma": ("figma",),
    "agile": ("agile", "scrum", "kanban"),
    "project management": ("project management", "program management"),
    "communication": ("stakeholder management", "cross-functional", "communication skills"),
    "salesforce": ("salesforce",),
    "hubspot": ("hubspot",),
    "excel": ("excel", "spreadsheets"),
    "security": ("security", "owasp", "application security"),
    "testing": ("testing", "quality assurance", "automated tests"),
}

ROLE_FAMILIES: dict[str, tuple[str, ...]] = {
    "product": ("product manager", "product owner", "product lead", "product management", "apm"),
    "software_engineering": ("software engineer", "software developer", "backend engineer", "frontend engineer", "full stack", "fullstack", "developer"),
    "data": ("data analyst", "data scientist", "analytics engineer", "business analyst", "machine learning engineer"),
    "design": ("product designer", "ux designer", "ui designer", "user experience designer"),
    "program_management": ("program manager", "project manager", "technical program manager"),
    "marketing": ("marketing manager", "growth marketer", "growth manager", "brand manager"),
    "sales": ("account executive", "sales manager", "business development", "sales representative"),
}

SENIOR_TERMS = {"senior", "sr", "staff", "lead", "principal", "group", "director", "vp", "head"}
JUNIOR_TERMS = {"intern", "trainee", "junior", "entry", "associate", "apm"}
INTERN_TERMS = {"intern", "internship", "trainee"}
# Same rule as enforceEarlyCareerSeniorityCap in src/match.ts (TASK-060/102).
EARLY_CAREER_YEARS = 3
SENIOR_CAP_FOR_EARLY_CAREER = 20
# Internships rarely fit someone who already has this much experience (TASK-102).
INTERN_OVERQUALIFIED_YEARS = 1.5
INTERN_CAP_FOR_EXPERIENCED = 35
# A different role family (e.g. engineering for a PM target) cannot rank as a good fit.
OTHER_FAMILY_CAP = 30


def normalized(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").lower()).strip()


def has_phrase(text: str, phrase: str) -> bool:
    return re.search(r"(?<![a-z0-9])" + re.escape(phrase) + r"(?![a-z0-9])", text) is not None


def extract_skills(text: str) -> set[str]:
    text = normalized(text)
    found: set[str] = set()
    for skill, aliases in SKILL_ALIASES.items():
        if any(has_phrase(text, alias) for alias in aliases):
            found.add(skill)
    return found


def role_family(title: str) -> str | None:
    text = normalized(title)
    for family, aliases in ROLE_FAMILIES.items():
        if any(has_phrase(text, alias) for alias in aliases):
            return family
    return None


def minimum_experience(text: str) -> float | None:
    patterns = (
        r"(?:minimum\s+of\s+|at\s+least\s+)?(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)(?:\s+of)?\s+(?:relevant\s+|professional\s+)?experience",
        r"experience\s+(?:of\s+)?(?:at\s+least\s+)?(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)",
    )
    matches = [float(m.group(1)) for pattern in patterns for m in re.finditer(pattern, text, re.I)]
    return min(matches) if matches else None


def candidate_experience(profile: dict[str, Any]) -> float | None:
    start = str(profile.get("careerStartDate") or "")
    match = re.match(r"^(\d{4})-(\d{2})", start)
    if not match:
        return None
    import datetime
    year, month = int(match.group(1)), int(match.group(2))
    today = datetime.date.today()
    return max(0.0, (today.year - year) + (today.month - month) / 12)


def seniority(title: str) -> str:
    words = set(re.findall(r"[a-z]+", normalized(title)))
    if words & SENIOR_TERMS:
        return "senior"
    if words & JUNIOR_TERMS:
        return "junior"
    return "mid"


def score_job(profile: dict[str, Any], cv_text: str, job: dict[str, Any]) -> dict[str, Any]:
    target = normalized(profile.get("targetDesignation"))
    job_title = normalized(job.get("title"))
    description = normalized(job.get("descriptionText"))
    location = normalized(job.get("location"))
    target_family = role_family(target)
    job_family = role_family(job_title)

    candidate_skills = {normalized(s) for s in profile.get("skills", []) if isinstance(s, str) and normalized(s)}
    candidate_skills |= extract_skills(cv_text)
    job_skills = extract_skills(job_title + " " + description)
    matched = sorted(candidate_skills & job_skills)
    missing = sorted(job_skills - candidate_skills)

    components: dict[str, float] = {}
    reasons: list[str] = []

    if not target:
        role_score = 0.0
    elif target == job_title:
        role_score = 35.0
        reasons.append("Job title exactly matches the target role.")
    elif target_family and job_family:
        role_score = 35.0 if target_family == job_family else 0.0
        reasons.append("Job is in the target role family." if role_score else "Job title maps to a different role family.")
    else:
        target_tokens = set(re.findall(r"[a-z0-9]+", target))
        job_tokens = set(re.findall(r"[a-z0-9]+", job_title))
        overlap = len(target_tokens & job_tokens) / max(1, len(target_tokens))
        role_score = round(35.0 * min(overlap, 1.0), 1)
        if role_score:
            reasons.append("Some target-role wording appears in the job title.")
    components["role"] = role_score

    if candidate_skills:
        skill_score = 40.0 * len(matched) / max(1, min(len(candidate_skills), 8))
        skill_score = min(40.0, skill_score)
    else:
        skill_score = 0.0
    components["skills"] = round(skill_score, 1)
    if matched:
        reasons.append("Skill overlap: " + ", ".join(matched[:5]) + ".")
    if not candidate_skills:
        reasons.append("No candidate skills were extracted; skill fit is uncertain.")

    years = candidate_experience(profile)
    required_years = minimum_experience(description)
    senior_job = seniority(job_title) == "senior"
    if years is None:
        seniority_score = 10.0
        reasons.append("Experience fit is uncertain because career start date is missing.")
    elif required_years is not None and years < required_years:
        gap = required_years - years
        seniority_score = max(0.0, 20.0 - 10.0 * gap)
        reasons.append(f"Experience gap: job asks for {required_years:g}+ years; profile indicates {years:.1f}.")
    elif senior_job and years < 3:
        seniority_score = 0.0
        reasons.append("Senior-level title is a stretch for under 3 years of experience.")
    else:
        seniority_score = 20.0
        reasons.append("No explicit experience mismatch was detected.")
    components["seniority"] = round(seniority_score, 1)

    preferred = [normalized(profile.get("preferredCity")), normalized(profile.get("preferredCountry"))]
    preferred = [item for item in preferred if item]
    if not preferred:
        location_score = 5.0
    elif any(item in location for item in preferred) or any(word in location for word in ("remote", "hybrid", "anywhere")):
        location_score = 5.0
        reasons.append("Location matches a saved preference or the role is remote/hybrid.")
    elif not location:
        location_score = 2.5
        reasons.append("Job location is missing, so location fit is uncertain.")
    else:
        location_score = 0.0
        reasons.append("Job location does not match a saved preference.")
    components["location"] = location_score

    score = max(0, min(100, round(sum(components.values()))))
    title_words = set(re.findall(r"[a-z]+", job_title))
    caps: list[str] = []
    if target_family and job_family and target_family != job_family and score > OTHER_FAMILY_CAP:
        score = OTHER_FAMILY_CAP
        caps.append("other_role_family")
    if senior_job and years is not None and years < EARLY_CAREER_YEARS and score > SENIOR_CAP_FOR_EARLY_CAREER:
        score = SENIOR_CAP_FOR_EARLY_CAREER
        caps.append("early_career_senior")
    if title_words & INTERN_TERMS and years is not None and years >= INTERN_OVERQUALIFIED_YEARS and score > INTERN_CAP_FOR_EXPERIENCED:
        score = INTERN_CAP_FOR_EXPERIENCED
        caps.append("overqualified_intern")
        reasons.append(f"Internship-level role; the profile already has {years:.1f} years of experience.")
    has_description = len(description) >= 160
    signal_coverage = 0.3 + (0.2 if target_family and job_family else 0.0) + (0.15 if candidate_skills else 0.0) + (0.15 if job_skills else 0.0) + (0.1 if has_description else 0.0) + (0.1 if years is not None else 0.0)
    signal_coverage = round(min(1.0, signal_coverage), 2)
    return {
        "index": job.get("index"),
        "score": score,
        "signalCoverage": signal_coverage,
        "components": components,
        "matchedSkills": matched,
        # These are skills mentioned in the posting, not asserted requirements.
        "unmatchedMentionedSkills": missing[:12],
        "reasons": reasons[:5],
        "caps": caps,
    }


def main() -> None:
    payload = json.load(sys.stdin)
    profile = payload.get("profile") or {}
    cv_text = str(payload.get("cvText") or "")
    jobs = payload.get("jobs") or []
    results = [score_job(profile, cv_text, job) for job in jobs if isinstance(job, dict)]
    json.dump({"version": 1, "results": results}, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()

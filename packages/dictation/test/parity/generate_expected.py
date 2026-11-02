"""Replay recorded cases through Writers Block's Python rules and store the outputs.

    ~/Documents/writers-block/.venv/bin/python generate_expected.py cases.jsonl expected.json
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / "Documents/writers-block/src"))
from scene_dictation import validation as v  # noqa: E402
from scene_dictation.models import Proposal  # noqa: E402


def diags(items):
    return [d.model_dump(mode="json") for d in items]


def safe(fn):
    try:
        return {"ok": fn()}
    except Exception as exc:  # the TypeScript side only has to fail too
        return {"error": type(exc).__name__}


def proposal_outputs(raw: dict, transcript: str) -> dict:
    try:
        proposal = Proposal.model_validate(raw)
    except Exception as exc:
        return {"invalid": type(exc).__name__}
    out = {
        "structure": diags(v.structure_diagnostics(proposal.elements)),
        "source_errors": v.source_errors(proposal, transcript),
        "audit": safe(lambda: diags(v.audit(proposal, transcript))),
        "shortcut_errors": safe(lambda: v.shortcut_errors(proposal, transcript)),
        "automatic": safe(lambda: v.automatic_insertion_errors(proposal, transcript)),
        "paste_notes": safe(lambda: v.paste_notes(proposal, transcript)),
        "dropped_speech": safe(lambda: dict(v.dropped_speech(proposal, transcript))),
        "drop_unanchored": safe(lambda: v.drop_unanchored_omissions(proposal, transcript).model_dump(mode="json")),
        "normalize": safe(lambda: v.normalize_proposal(proposal, transcript).model_dump(mode="json")),
    }
    if out["normalize"].get("ok"):
        normalized = Proposal.model_validate(out["normalize"]["ok"])
        out["normalized_audit"] = safe(lambda: diags(v.audit(normalized, transcript)))
        out["normalized_automatic"] = safe(lambda: v.automatic_insertion_errors(normalized, transcript))
        out["normalized_strict"] = safe(lambda: v.automatic_insertion_errors(normalized, transcript, strict=True))
        out["normalized_paste_notes"] = safe(lambda: v.paste_notes(normalized, transcript))
    return out


def main(source: str, target: str) -> None:
    cases = []
    for line in Path(source).read_text(encoding="utf-8").splitlines():
        case = json.loads(line)
        kind = case["kind"]
        if kind == "proposal":
            case["expected"] = proposal_outputs(case["proposal"], case["transcript"])
        elif kind == "heading":
            case["expected"] = v.spoken_heading(case["quote"])
        elif kind == "parse":
            case["expected"] = safe(lambda: v.parse_proposal(case["raw"]).model_dump(mode="json"))
        elif kind == "capitalize":
            proposal = Proposal.model_validate(case["proposal"])
            case["expected"] = v.capitalize_introductions(proposal, case["cast"], set(case["introduced"])).model_dump(mode="json")
        cases.append(case)
    Path(target).write_text(json.dumps(cases, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(len(cases), "cases")


if __name__ == "__main__":
    main(*sys.argv[1:3])

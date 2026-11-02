"""pytest plugin: record every input the Writers Block test suite feeds the formatting rules.

    cd ~/Documents/writers-block
    PARITY_OUT=/tmp/cases.jsonl .venv/bin/python -m pytest -q -p record_cases \
        --rootdir . -o pythonpath="src $PWD_OF_THIS_FOLDER"

Each line is {"kind": ..., ...inputs}. generate_expected.py replays them through
the Python rules to produce the expected outputs the TypeScript port must match.
"""
import json
import os

import scene_dictation.validation as v

OUT = os.environ.get("PARITY_OUT", "parity-cases.jsonl")
seen: set[str] = set()


def write(record: dict) -> None:
    line = json.dumps(record, sort_keys=True, ensure_ascii=False)
    if line not in seen:
        seen.add(line)
        with open(OUT, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")


def dump(proposal) -> dict:
    return proposal.model_dump(mode="json")


def wrap(name: str, record):
    original = getattr(v, name)

    def wrapper(*args, **kwargs):
        try:
            write(record(*args, **kwargs))
        except Exception:
            pass
        return original(*args, **kwargs)

    setattr(v, name, wrapper)


def pytest_configure(config):
    proposal_case = lambda proposal, transcript="", *a, **k: {
        "kind": "proposal", "proposal": dump(proposal), "transcript": transcript}
    for name in ("normalize_proposal", "audit", "shortcut_errors", "paste_notes", "source_errors",
                 "drop_unanchored_omissions", "correction_diagnostics", "missing_speech_diagnostics"):
        wrap(name, proposal_case)
    wrap("automatic_insertion_errors", lambda proposal, transcript, **k: {
        "kind": "proposal", "proposal": dump(proposal), "transcript": transcript})
    v.normalize_headings = v.normalize_proposal
    wrap("structure_diagnostics", lambda elements: {
        "kind": "proposal", "proposal": {"elements": [e.model_dump(mode="json") for e in elements],
                                         "omissions": [], "warnings": []}, "transcript": ""})
    wrap("spoken_heading", lambda quote: {"kind": "heading", "quote": quote})
    wrap("parse_proposal", lambda raw: {"kind": "parse", "raw": raw})
    wrap("capitalize_introductions", lambda proposal, cast, introduced: {
        "kind": "capitalize", "proposal": dump(proposal), "cast": list(cast), "introduced": sorted(introduced)})

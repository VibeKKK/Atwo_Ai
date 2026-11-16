#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Workflow Phase Extraction.

Extracts step-level content from .atw/workflow.md and optionally filters
platform-specific blocks.

Platform marker syntax in workflow.md:

    [Claude Code, Cursor, ...]
    agent-capable content
    [/Claude Code, Cursor, ...]

Provides:
    get_phase_index   - Extract the Phase Index section (no --step)
    get_step          - Extract a single step (#### X.X) section
    filter_platform   - Strip platform blocks that don't include the given name
    select_platform_blocks - Per-turn breadcrumbs: keep only the matching block,
                             or every block when none matches
    split_into_parts - Cut output too long to be read in one go into parts
"""

from __future__ import annotations

import re

from .paths import DIR_WORKFLOW, get_repo_root


def _workflow_md_path():
    return get_repo_root() / DIR_WORKFLOW / "workflow.md"

# Match a line that *is* a platform marker: "[A, B, C]" or "[/A, B, C]"
_MARKER_RE = re.compile(r"^\[(/?)([A-Za-z][^\[\]]*)\]\s*$")

# Step heading: "#### 1.0 Title" or "#### 1.0 ..."
_STEP_HEADING_RE = re.compile(r"^####\s+(\d+\.\d+)\b.*$")

# Phase Index starts here; Phase 1/2/3 step bodies follow; ends at Breadcrumbs.
_PHASE_INDEX_HEADING = "## Phase Index"


def _read_workflow() -> str:
    path = _workflow_md_path()
    if not path.exists():
        raise FileNotFoundError(f"workflow.md not found: {path}")
    return path.read_text(encoding="utf-8")


def _parse_marker(line: str) -> tuple[bool, list[str]] | None:
    """Parse a platform marker line.

    Returns:
        (is_closing, [platform_names]) if line is a marker, else None.
    """
    m = _MARKER_RE.match(line)
    if not m:
        return None
    is_closing = m.group(1) == "/"
    names = [p.strip() for p in m.group(2).split(",") if p.strip()]
    return is_closing, names


def get_phase_index() -> str:
    """Return the compact Phase Index summary from workflow.md.

    SessionStart and no-step phase context use this small summary as their
    orientation payload. Detailed Phase 1/2/3 instructions are loaded with
    ``get_step`` on demand. ``[workflow-state:STATUS]`` tag blocks are
    consumed by the per-turn hook, so they're stripped from this output.
    """
    text = _read_workflow()
    lines = text.splitlines()

    start: int | None = None
    end: int | None = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if start is None and stripped == _PHASE_INDEX_HEADING:
            start = i
            continue
        if start is not None and stripped == "## Phase 1: Plan":
            end = i
            break

    if start is None:
        return ""
    if end is None:
        end = len(lines)

    section = "\n".join(lines[start:end]).rstrip()
    # Strip [workflow-state:STATUS]...[/workflow-state:STATUS] blocks since
    # they're injected separately by inject-workflow-state.py per-turn.
    import re as _re
    tag_re = _re.compile(
        r"\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n.*?\n\s*\[/workflow-state:\1\]\n?",
        _re.DOTALL,
    )
    return tag_re.sub("", section).rstrip() + "\n"


def get_step(step_id: str) -> str:
    """Return the `#### X.X` section matching step_id (header + body).

    Body ends at the next `####` or `---` or `##` heading (whichever comes first).
    """
    text = _read_workflow()
    lines = text.splitlines()

    start: int | None = None
    for i, line in enumerate(lines):
        m = _STEP_HEADING_RE.match(line)
        if m and m.group(1) == step_id:
            start = i
            break
    if start is None:
        return ""

    end: int = len(lines)
    for j in range(start + 1, len(lines)):
        line = lines[j]
        if line.startswith("#### "):
            end = j
            break
        if line.startswith("## "):
            end = j
            break
        # Horizontal rule at column 0
        if line.strip() == "---":
            end = j
            break

    return "\n".join(lines[start:end]).rstrip() + "\n"


def _platform_matches(platform: str, block_names: list[str]) -> bool:
    """Case-insensitive fuzzy match: accept 'cursor', 'Cursor', 'claude-code', 'Claude Code'."""
    needle = platform.lower().replace("-", "").replace("_", "").replace(" ", "")
    for name in block_names:
        hay = name.lower().replace("-", "").replace("_", "").replace(" ", "")
        if needle == hay:
            return True
    return False


_PLATFORM_MARKER_LABELS: dict[str, str] = {
    # workflow.md marker blocks label platforms with their product names, but
    # every caller passes the stable id instead (`--platform {{CLI_FLAG}}` in
    # the start / continue commands). `_platform_matches` only strips
    # punctuation, so an id that is not its label-minus-spaces never matches and
    # `filter_platform` drops the block WITHOUT error — the section just comes
    # back empty. Four platforms shipped that way before this table existed.
    #
    # Add an entry whenever a platform's id is not its marker label with the
    # separators removed. `test/registry-invariants.test.ts` asserts every
    # registry id keeps a non-empty routing section, so a missing entry fails
    # there rather than silently blanking that platform's routing.
    "claude": "Claude Code",
    "kimi": "Kimi Code",
    "omp": "Oh My Pi",
    "dsh": "DeepSeek Harness",
}


def resolve_effective_platform(platform: str, config: dict) -> str:
    """Map ``codex`` to a dispatch-mode-namespaced virtual platform name.

    When ``--platform codex`` is passed, return ``"codex-sub-agent"`` by
    default or ``"codex-inline"`` when explicitly configured in
    ``.atw/config.yaml``. ``sub-agent`` remains an alias for ``auto``.
    ``filter_platform`` then surfaces blocks whose marker lists include the
    namespaced name (e.g. ``[codex-sub-agent, ...]`` or ``[codex-inline, Kilo,
    Antigravity, Devin]``).

    Native Codex context injection supports the ``auto`` default. Invalid
    explicit values fall back to ``inline`` safely; this renderer deliberately
    does not warn because it can run in normal CLI output flows.

    Platforms whose marker label differs from their id resolve through
    ``_PLATFORM_MARKER_LABELS``. Everything else is returned unchanged.
    """
    label = _PLATFORM_MARKER_LABELS.get(platform.strip().lower())
    if label:
        return label
    if platform == "codex":
        mode = "auto"
        codex_cfg = config.get("codex") if isinstance(config, dict) else None
        if codex_cfg is not None:
            if not isinstance(codex_cfg, dict):
                mode = "inline"
            else:
                cfg_mode = str(codex_cfg.get("dispatch_mode", mode)).strip().lower()
                if cfg_mode == "inline":
                    mode = "inline"
                elif cfg_mode in ("auto", "sub-agent"):
                    mode = "auto"
                else:
                    mode = "inline"
        return "codex-sub-agent" if mode == "auto" else "codex-inline"
    return platform


def _alternative_groups_without_match(lines: list[str], platform: str) -> set[int]:
    """Opening-marker line numbers whose block must be kept although it does not
    name ``platform``.

    Only a list of alternative forms counts: two or more adjacent blocks
    (separated by blank lines only) holding one line each, e.g. one input line
    per tool, every line naming its own tool. When none names the platform,
    every line is kept so the platform still sees each form — the same
    fallback the per-turn breadcrumb uses. Blocks with more than one line are
    rules for different kinds of platform (do this / skip this) and keeping
    them all would contradict itself, so they are still dropped, as is a lone
    block.
    """
    groups: list[list[tuple[int, bool, int]]] = []
    current: list[tuple[int, bool, int]] = []
    open_at: int | None = None
    open_match = False
    open_lines = 0
    for i, line in enumerate(lines):
        marker = _parse_marker(line)
        if marker is None:
            if open_at is not None:
                if line.strip():
                    open_lines += 1
            # Text between blocks ends the run of alternatives.
            elif line.strip() and current:
                groups.append(current)
                current = []
            continue
        is_closing, names = marker
        if not is_closing:
            open_at, open_match, open_lines = i, _platform_matches(platform, names), 0
        elif open_at is not None:
            current.append((open_at, open_match, open_lines))
            open_at = None
    if current:
        groups.append(current)

    keep: set[int] = set()
    for group in groups:
        if (
            len(group) >= 2
            and all(n == 1 for _, _, n in group)
            and not any(matched for _, matched, _ in group)
        ):
            keep.update(idx for idx, _, _ in group)
    return keep


def filter_platform(content: str, platform: str) -> str:
    """Keep lines outside any `[...]` block + lines inside blocks that include platform.

    A list of one-line alternatives none of which include platform is kept
    whole (see ``_alternative_groups_without_match``). Marker lines themselves are dropped
    from the output.
    """
    lines = content.splitlines()
    out: list[str] = []
    keep_anyway = _alternative_groups_without_match(lines, platform)

    in_block = False
    keep_block = False

    for i, line in enumerate(lines):
        marker = _parse_marker(line)
        if marker is not None:
            is_closing, names = marker
            if not is_closing:
                in_block = True
                keep_block = _platform_matches(platform, names) or i in keep_anyway
            else:
                in_block = False
                keep_block = False
            continue  # drop the marker line itself

        if in_block:
            if keep_block:
                out.append(line)
            continue
        out.append(line)

    # Collapse runs of 3+ blank lines that may arise from dropped markers
    collapsed: list[str] = []
    blank_run = 0
    for line in out:
        if line.strip() == "":
            blank_run += 1
            if blank_run <= 2:
                collapsed.append(line)
        else:
            blank_run = 0
            collapsed.append(line)

    return "\n".join(collapsed).rstrip() + "\n"


def strip_alternative_markers(content: str) -> str:
    """Rules read without ``--platform``: every list of one-line alternatives
    (one input per tool, each naming its tool) is given whole, without its
    marker lines. Other platform blocks keep their markers, so rules meant
    for different kinds of platform still say which is which.
    """
    lines = content.splitlines()
    # A name no block carries: every alternative list counts as "no match".
    alternatives = _alternative_groups_without_match(lines, "\0")
    out: list[str] = []
    stripping = False
    for i, line in enumerate(lines):
        marker = _parse_marker(line)
        if marker is not None:
            is_closing, _ = marker
            if not is_closing:
                stripping = i in alternatives
                if stripping:
                    continue
            elif stripping:
                stripping = False
                continue
        out.append(line)
    return "\n".join(out) + ("\n" if content.endswith("\n") else "")


# A step-rules command written in workflow text, ending at a backtick, a
# comment or the end of the line, not already naming a platform.
_STEP_COMMAND_RE = re.compile(
    r"(py -3 \./\.atw/scripts/get_context\.py --mode phase --step [^`\s]+)(?=`|[ \t]+#|[ \t]*$)",
    re.MULTILINE,
)


def name_platform_in_step_commands(content: str, platform: str | None) -> str:
    """Append ``--platform <platform>`` to every step-rules command in
    ``content``, so a step read from it keeps only this tool's forms. No
    platform leaves the commands as written. The per-turn hook carries the
    same function for breadcrumbs; pi and omp mirror it (``nameStepPlatform``).
    """
    if not platform:
        return content
    return _STEP_COMMAND_RE.sub(lambda m: f"{m.group(1)} --platform {platform}", content)


def select_platform_blocks(content: str, platform: str | None) -> str:
    """Per-turn breadcrumb variant of ``filter_platform``.

    Keeps only the platform blocks that include ``platform``; when no block
    matches (a platform the breadcrumb has no block for, or ``None``), keeps
    every block instead, so each line must name its own tool. Marker lines
    are always dropped. Content outside blocks is unchanged.
    """
    lines = content.splitlines()
    names_seen: list[list[str]] = []
    for line in lines:
        marker = _parse_marker(line)
        if marker is not None and not marker[0]:
            names_seen.append(marker[1])
    any_match = platform is not None and any(
        _platform_matches(platform, names) for names in names_seen
    )

    out: list[str] = []
    keep_block = True
    for line in lines:
        marker = _parse_marker(line)
        if marker is not None:
            is_closing, names = marker
            keep_block = True if is_closing or not any_match else _platform_matches(platform or "", names)
            continue
        if keep_block:
            out.append(line)
    return "\n".join(out)


# One part of `get_context.py --mode phase` output, header and end marker
# included. Claude Code inlines about 30,000 characters of command output and
# Codex 0.164.0 falls back to 10,000 bytes for a model it does not know; 8,000
# UTF-8 bytes fits both with room to spare (sources: the hook-context-budget
# task's research/step-rules-read-limits.md).
PART_BUDGET_BYTES = 8000


def _utf8_len(text: str) -> int:
    return len(text.encode("utf-8"))


def _part_header(label: str, index: int, total: int) -> str:
    return f"ATW {label} — part {index} of {total}. Read all {total} parts before acting on any of it."


def _part_footer(label: str, index: int, total: int, next_command: str) -> str:
    if index == total:
        return f"[End of {label}, part {total} of {total} — the last part; {label} has been read in full.]"
    return f"[End of {label}, part {index} of {total}. Next part: `{next_command} --part {index + 1}`]"


def _cut_long_line(line: str, budget: int) -> list[str]:
    pieces: list[str] = []
    piece = ""
    for ch in line:
        if _utf8_len(piece) + _utf8_len(ch) > budget:
            pieces.append(piece + "\n")
            piece = ""
        piece += ch
    if piece:
        pieces.append(piece)
    return pieces


def _chunk_lines(content: str, budget: int) -> list[str]:
    """Split content into chunks of at most ``budget`` bytes, at line breaks,
    preferring the last blank line outside a code fence once a chunk is at
    least half full."""
    lines: list[str] = []
    for line in content.splitlines(keepends=True):
        lines.extend(_cut_long_line(line, budget) if _utf8_len(line) > budget else [line])

    breakable: list[bool] = []
    in_fence = False
    for line in lines:
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        breakable.append(not in_fence and line.strip() == "")

    chunks: list[str] = []
    cur: list[int] = []
    size = 0
    for i, line in enumerate(lines):
        n = _utf8_len(line)
        while cur and size + n > budget:
            cut = len(cur)
            running = 0
            for k, j in enumerate(cur):
                running += _utf8_len(lines[j])
                if breakable[j] and running >= budget // 2:
                    cut = k + 1
            chunks.append("".join(lines[j] for j in cur[:cut]))
            cur = cur[cut:]
            size = sum(_utf8_len(lines[j]) for j in cur)
        cur.append(i)
        size += n
    if cur:
        chunks.append("".join(lines[j] for j in cur))
    return chunks


def _single_part_footer(label: str) -> str:
    return f"[End of {label} — all of it, in one part; {label} has been read in full.]"


def _even_chunks(content: str, budget: int) -> list[str]:
    """Chunk ``content`` into as few chunks as ``budget`` allows, sized as
    evenly as the break points let, so no part is a small remainder."""
    size = _utf8_len(content)
    fewest = -(-size // budget)
    for count in range(fewest, fewest + 3):
        for slack in (1.05, 1.1, 1.2, 1.3):
            target = min(budget, int(size / count * slack) + 1)
            chunks = _chunk_lines(content, target)
            if len(chunks) == count:
                return chunks
    return _chunk_lines(content, budget)


def split_into_parts(content: str, label: str, next_command: str) -> list[str]:
    """Return ``content`` as one or more parts of at most PART_BUDGET_BYTES.

    Every part closes with an end marker, so a reader can tell from the output
    alone that it has read everything. Content that fits is returned as written
    plus a one-part end marker. Otherwise each part opens with ``label`` and
    "part i of n", and its end marker gives the command for the next part, or
    says the last part has been read. The parts' bodies put back together are
    ``content``.
    """
    single = f"{content}{_single_part_footer(label)}\n"
    if _utf8_len(single) <= PART_BUDGET_BYTES:
        return [single]
    # Size the frame for up to 99 parts so the body budget holds for any count.
    frame = (
        _utf8_len(_part_header(label, 99, 99))
        + max(
            _utf8_len(_part_footer(label, 98, 99, next_command)),
            _utf8_len(_part_footer(label, 99, 99, next_command)),
        )
        + 4  # blank line after the header, newline after the body and the footer
    )
    bodies = _even_chunks(content, PART_BUDGET_BYTES - frame)
    total = len(bodies)
    parts = []
    for i, body in enumerate(bodies, start=1):
        if not body.endswith("\n"):
            body += "\n"
        parts.append(
            f"{_part_header(label, i, total)}\n\n{body}{_part_footer(label, i, total, next_command)}\n"
        )
    return parts

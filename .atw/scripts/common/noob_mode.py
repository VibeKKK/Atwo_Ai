"""Noob mode — a per-developer switch for plain-language replies.

While it is on, the hooks that already speak to the AI at session start and
on every turn append a short reminder, so the mode holds across long
conversations, compaction and new sessions instead of fading the way a skill
loaded once does.

Each developer is in one of three states. `noob_mode=on` or `noob_mode=off`
in `.atw/.developer` is a choice they made (the `atw-noob-mode` skill runs
`noob_mode.py on|off`) and always wins. No such line means they never chose,
and the project mode's default applies: on in a `general` project, off in a
`dev` one. A file written before the off line existed reads the same way —
an on line is a choice, no line is none.

`.atw/.developer` is gitignored and personal by design, so one developer's
choice never reaches a teammate, survives a change of project mode, and needs
no new ignore rule in existing projects.

The reminder text itself lives in workflow.md, in a
`[workflow-state:noob_mode]` block next to the per-status breadcrumbs — the
JS/TS hook ports already parse those blocks, so every platform reads one copy.
"""

from __future__ import annotations

import re
from pathlib import Path

from .config import get_project_mode
from .git import main_worktree_root
from .paths import DIR_WORKFLOW, FILE_DEVELOPER

FIELD = "noob_mode"
BREADCRUMB_TAG = "noob_mode"

# Used when workflow.md has no noob_mode block (a custom workflow template, or
# a workflow.md older than this feature): the mode still has to take effect.
FALLBACK_REMINDER = (
    "Noob mode is ON — this user is not an engineer. Hold to the "
    "`/atw-noob-mode` rules in every reply: plain words in the user's "
    "language, and every term, command or path explained where it appears."
)

_FIELD_RE = re.compile(rf"^{FIELD}=(.*)$", re.MULTILINE)
_TAG_RE = re.compile(
    rf"\[workflow-state:{BREADCRUMB_TAG}\]\s*\n(.*?)\n\s*\[/workflow-state:{BREADCRUMB_TAG}\]",
    re.DOTALL,
)


def _developer_file(repo_root: Path) -> Path | None:
    """The identity file this checkout uses, following get_developer():
    its own, else the main checkout's when this is a linked worktree."""
    local = repo_root / DIR_WORKFLOW / FILE_DEVELOPER
    if local.is_file():
        return local
    main_root = main_worktree_root(repo_root)
    if main_root is None:
        return None
    inherited = main_root / DIR_WORKFLOW / FILE_DEVELOPER
    return inherited if inherited.is_file() else None


def noob_mode_choice(repo_root: Path) -> bool | None:
    """What this developer said: True (on), False (off), or None — never chose."""
    dev_file = _developer_file(repo_root)
    if dev_file is None:
        return None
    try:
        match = _FIELD_RE.search(dev_file.read_text(encoding="utf-8"))
    except OSError:
        return None
    if match is None:
        return None
    return match.group(1).strip() == "on"


def is_noob_mode_on(repo_root: Path) -> bool:
    """The one place that decides. The developer's own choice wins; without
    one, the project mode's default applies — on for `general`, off for `dev`."""
    choice = noob_mode_choice(repo_root)
    if choice is not None:
        return choice
    return get_project_mode(repo_root) == "general"


def set_noob_mode(repo_root: Path, on: bool) -> bool:
    """Switch noob mode for this developer.

    Returns False when there is no identity file to record it in (run
    init_developer.py first); the file's other lines are left as they are.
    """
    dev_file = _developer_file(repo_root)
    if dev_file is None:
        return False
    lines = [
        line
        for line in dev_file.read_text(encoding="utf-8").splitlines()
        if not line.startswith(f"{FIELD}=")
    ]
    # Off is written down, not erased: a missing line means "never chose",
    # and that follows the project default.
    lines.append(f"{FIELD}={'on' if on else 'off'}")
    dev_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True


# 小白模式说明在每段注入里优先保留；只有它自己超过这个长度（UTF-8 字节，含
# 首尾标签）才截短，并写明当前工具读全文的命令（任务 hook-context-budget 工单 08）。
NOOB_MODE_BUDGET_BYTES = 2000
# 各工具调 skill 的写法；认不出的平台照 FALLBACK_REMINDER 写 `/atw-noob-mode`。
_SKILL_PREFIX = {"codex": "$", "pi": "/skill:", "omp": "/skill:"}


def _fit_noob_block(body: str, platform: str | None) -> str:
    block = f"<noob-mode>\n{body}\n</noob-mode>"
    if len(block.encode("utf-8")) <= NOOB_MODE_BUDGET_BYTES:
        return block
    command = f"{_SKILL_PREFIX.get(platform or '', '/')}atw-noob-mode"
    # 只有用户改过的那块会超长，被截的原文只在 workflow.md 里，技能里找不回（工单 13）。
    note = (
        f"[Noob-mode text cut here: it is over 2,000 bytes. The full rules: `{command}`; "
        "the rest of this customized text: the `[workflow-state:noob_mode]` block in `.atw/workflow.md`.]"
    )
    room = NOOB_MODE_BUDGET_BYTES - len(f"<noob-mode>\n\n{note}\n</noob-mode>".encode("utf-8"))
    head = body.encode("utf-8")[:room].decode("utf-8", errors="ignore").rstrip()
    return f"<noob-mode>\n{head}\n{note}\n</noob-mode>"


def noob_mode_reminder(repo_root: Path, platform: str | None = None) -> str:
    """The `<noob-mode>` block to hand the AI, or "" while the mode is off.

    A block over NOOB_MODE_BUDGET_BYTES (only a customized one can be) keeps
    its opening and names `platform`'s command for the full rules.
    """
    if not is_noob_mode_on(repo_root):
        return ""
    body = ""
    try:
        content = (repo_root / DIR_WORKFLOW / "workflow.md").read_text(
            encoding="utf-8"
        )
        match = _TAG_RE.search(content)
        if match:
            body = match.group(1).strip()
    except OSError:
        pass
    return _fit_noob_block(body or FALLBACK_REMINDER, platform)

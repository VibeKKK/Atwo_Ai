#!/usr/bin/env python3
"""
Commit message style: print this project's rules, or check a message.

Usage:
    py -3 commit_style.py rules          Print the style in effect, for the AI
    py -3 commit_style.py check [FILE]   Check a commit message line by line;
                                           reads stdin when FILE is absent or "-"

The style follows opencommit's defaults unless `commit_message` in
.atw/config.yaml switches something (see common/config.py). A project with its
own commitlint config takes precedence over all of it.

`check` exits 0 when the message passes and 1 with one `line N: reason` per
problem when it does not; 2 on a usage or read error; 3 when the project has
its own commitlint config: nothing was checked, use the project's commitlint
instead. 3 is not a pass.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from common.config import get_commit_message_style
from common.paths import get_repo_root

MAX_LINE_CHARS = 74
EXIT_NOT_CHECKED = 3
TYPES = ("fix", "feat", "build", "chore", "ci", "docs", "style", "refactor", "perf", "test")

# opencommit's GITMOJI_HELP (src/prompts.ts:20-30 at 0e23a7d), in its order:
# the list its prompt uses when emoji is on without `--fgm` (default false).
GITMOJI = (
    ("🐛", "Fix a bug"),
    ("✨", "Introduce new features"),
    ("📝", "Add or update documentation"),
    ("🚀", "Deploy stuff"),
    ("✅", "Add, update, or pass tests"),
    ("♻️", "Refactor code"),
    ("⬆️", "Upgrade dependencies"),
    ("🔧", "Add or update configuration files"),
    ("🌐", "Internationalization and localization"),
    ("💡", "Add or update comments in source code"),
)

LANGUAGE_NAMES = {
    "en": "English",
    "zh": "Simplified Chinese",
    "zh-cn": "Simplified Chinese",
    "zh-hans": "Simplified Chinese",
    "zh-tw": "Traditional Chinese",
    "zh-hant": "Traditional Chinese",
    "ja": "Japanese",
    "ko": "Korean",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
}


def language_name(language: str) -> str:
    """`en` → `English`; a code we do not know, or a name, stays as written."""
    return LANGUAGE_NAMES.get(language.strip().lower().replace("_", "-"), language)


TASK_SECTION = (
    "## Task and ticket",
    "",
    "- A commit for a ticket of an ATW task ends its first line with "
    "` (<task> #<ticket>)`: <task> is the task directory name without its "
    "date prefix (`10-27-atw-commit` -> `atw-commit`), <ticket> the ticket "
    "number (`01`).",
    f"- If that makes the first line longer than {MAX_LINE_CHARS} characters, "
    "leave it off and end the message with its own last line "
    "`Task: <task> #<ticket>`.",
    "- A commit for the task but no single ticket names only the task: "
    "` (<task>)` or `Task: <task>`. Outside any task, write neither.",
)

PRECEDENCE = (
    "Precedence, highest first: the task's standing orders > the project's "
    "commitlint rules > `commit_message` in `.atw/config.yaml` > ATW defaults."
)


def find_commitlint(repo_root: Path) -> list[str]:
    """The project's own commitlint config at the repo root, as display names.

    `commitlint.config.*`, `.commitlintrc*`, or a `commitlint` key in
    `package.json`. Only the root counts, like commitlint's own lookup from
    where `git commit` runs.
    """
    found = sorted(
        entry.name
        for entry in repo_root.iterdir()
        if entry.is_file()
        and (entry.name.startswith("commitlint.config.") or entry.name.startswith(".commitlintrc"))
    )
    package_json = repo_root / "package.json"
    if package_json.is_file():
        try:
            data = json.loads(package_json.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
        if isinstance(data, dict) and "commitlint" in data:
            found.append("package.json")
    return found


def render_commitlint_rules(found: list[str]) -> str:
    """The project's commitlint wins: say so and where it is configured."""
    names = ", ".join(
        "`package.json` (`commitlint` key)" if name == "package.json" else f"`{name}`"
        for name in found
    )
    lines = [
        "# Commit message style for this project",
        "",
        "This project has its own commitlint rules; follow them. The ATW style "
        "rules do not apply.",
        f"Commitlint config: {names}.",
        "",
        PRECEDENCE,
        "",
        "## Check before committing",
        "",
        "- Check the message with the project's commitlint when it can run "
        "here (for example `npx --no-install commitlint --edit <file>`) and "
        "fix what it reports. `commit_style.py check` does not apply.",
        "- A standing order about commit messages wins over everything else "
        "only as far as commitlint still passes: a failing commitlint blocks "
        "the commit.",
        "",
        *TASK_SECTION,
        "- Write these only where the commitlint rules allow them.",
    ]
    return "\n".join(lines) + "\n"


def title_shape(style: dict[str, object]) -> str:
    """The shape of one title line under these switches."""
    lead = "<gitmoji>" if style["emoji"] else "<type>"
    if style["omit_scope"]:
        return f"{lead} <subject>" if style["emoji"] else f"{lead}: <subject>"
    return f"{lead} (<scope>): <subject>" if style["emoji"] else f"{lead}(<scope>): <subject>"


def render_rules(style: dict[str, object]) -> str:
    """The style in effect, as instructions for the AI.

    The sentences in quotes are opencommit's own prompt wording
    (src/prompts.ts) for the same switch.
    """
    shape = title_shape(style)
    convention = "GitMoji convention" if style["emoji"] else "Conventional Commit Convention"
    lines = [
        "# Commit message style for this project",
        "",
        "Settings: `commit_message` in `.atw/config.yaml` ("
        + ", ".join(f"{key}: {str(value).lower() if isinstance(value, bool) else value}"
                    for key, value in style.items())
        + ").",
        "",
        PRECEDENCE,
        "",
        "## Rules",
        "",
    ]
    if style["one_line"]:
        lines.append(
            f"- Write a single title line as per the {convention}: `{shape}`. "
            "Craft a concise, single sentence, commit message that encapsulates "
            "all changes made, with an emphasis on the primary updates."
        )
    else:
        lines.append(
            f"- Write the commit message as per the {convention}, one line per "
            f"kind of change: `{shape}`. Changes of different kinds get one line "
            "each, stacked with no blank line between."
        )
    if style["emoji"]:
        lines.append(
            "- Use GitMoji convention to preface the commit. Here are some help "
            "to choose the right emoji (emoji, description):"
        )
        lines.extend(
            f"  {emoji}, {text}{'.' if i == len(GITMOJI) - 1 else ';'}"
            for i, (emoji, text) in enumerate(GITMOJI)
        )
        lines.append(
            "- Place the GitMoji at the start of the title line, instead of "
            "the type word."
        )
    else:
        lines.append(
            "- Do not preface the commit with anything, except for the "
            "conventional commit keywords: " + ", ".join(TYPES) + "."
        )
        lines.append("- Do not use emoji.")
    if style["omit_scope"]:
        lines.append(
            "- Do not include a scope in the commit message format. "
            f"Use the format: {shape}"
        )
    if style["description"]:
        lines.append(
            "- Add a short description of WHY the changes are done after the "
            "commit message. Don't start it with \"This commit\", just describe "
            "the changes. Put it below the title lines, after one blank line."
        )
    else:
        lines.append(
            "- Don't add any descriptions to the commit, only commit message."
        )
    lines += [
        "- Use the present tense.",
        f"- Lines must not be longer than {MAX_LINE_CHARS} characters.",
        "- The last `Task:` line is the one exception: it has no length limit, "
        "so a long task name is written in full.",
        f"- Use {language_name(str(style['language']))} for the commit message."
        + (
            ""
            if language_name(str(style["language"])) == "English"
            else " Type words, scopes and the `Task:` line stay as shown here."
        ),
        "",
        *TASK_SECTION,
        "",
        "## Check before committing",
        "",
        "- Run `py -3 ./.atw/scripts/commit_style.py check <file>` (or pipe "
        "the message on stdin) and fix every line it reports.",
        "- When a standing order about commit messages conflicts with these "
        "rules, follow the standing order and skip this check.",
    ]
    return "\n".join(lines) + "\n"


# 一行看着像 `Task:` 行（大小写、冒号前后空白都算），再用 TASK_RE 判格式
TASK_LIKE_RE = re.compile(r"^\s*task\s*:", re.IGNORECASE)
# 任务名是去掉日期前缀的任务目录名（task.py 生成的是不带空白的 slug）
TASK_RE = re.compile(r"^Task: [^\s#]+(?: #\d+)?$")
TYPED_TITLE_RE = re.compile(r"^([A-Za-z]+)(?:\(([^()]*)\))?(!)?: (\S.*)$")
SCOPE_AFTER_EMOJI_RE = re.compile(r"^\(([^()]*)\): (\S.*)$")
VARIATION_SELECTOR = "\ufe0f"
# 变体选择符（U+FE0F）写不写都认；长的先比，免得一个表情被另一个的前缀吃掉
GITMOJI_BARE = sorted(
    (emoji.replace(VARIATION_SELECTOR, "") for emoji, _ in GITMOJI),
    key=len,
    reverse=True,
)


def title_problem(line: str, style: dict[str, object]) -> str | None:
    """What is wrong with one title line, or None."""
    shape = title_shape(style)
    if style["emoji"]:
        bare = line.replace(VARIATION_SELECTOR, "")
        emoji = next((e for e in GITMOJI_BARE if bare.startswith(e + " ")), None)
        if emoji is None:
            return (
                "emoji is on: start the title line with a GitMoji "
                f"(`{shape}`; the list is in `commit_style.py rules`)"
            )
        rest = bare[len(emoji) + 1 :]
        scoped = SCOPE_AFTER_EMOJI_RE.match(rest)
        if style["omit_scope"] and (scoped or rest.startswith("(")):
            return f"omit_scope is on: no scope, write `{shape}`"
        if rest.startswith("(") and not (scoped and scoped.group(1).strip()):
            return f"not a title line in the form `{shape}`"
        if not rest.strip():
            return f"no subject: write `{shape}`"
        return None

    match = TYPED_TITLE_RE.match(line)
    if match is None or match.group(2) is not None and not match.group(2).strip():
        return f"not a title line in the form `{shape}`"
    if match.group(1) not in TYPES:
        return f"type `{match.group(1)}` is not one of: " + ", ".join(TYPES)
    if match.group(2) is not None and style["omit_scope"]:
        return f"omit_scope is on: no scope, write `{shape}`"
    return None


def check_message(text: str, style: dict[str, object]) -> list[tuple[int, str]]:
    """Every problem in a commit message as (line number, reason)."""
    lines = [line.rstrip("\r") for line in text.split("\n")]
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return [(1, "the message is empty")]

    last = len(lines) - 1
    problems: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        # 末尾格式合格的 Task: 行不限长：任务名截短就追不到任务目录
        if i == last and TASK_RE.match(line):
            continue
        if len(line) > MAX_LINE_CHARS:
            problems.append(
                (i + 1, f"{len(line)} characters, longer than {MAX_LINE_CHARS}")
            )

    task_lines = {i for i, line in enumerate(lines) if TASK_LIKE_RE.match(line)}
    for i in sorted(task_lines):
        if i != last:
            problems.append((i + 1, "the `Task:` line goes last"))
        elif not TASK_RE.match(lines[i]):
            problems.append(
                (i + 1, "write `Task: <task> #<ticket>` or `Task: <task>`")
            )

    content = lines[:last] if last in task_lines else list(lines)
    while content and not content[-1].strip():
        content.pop()
    if not content:
        return sorted(problems + [(1, "no title line")])
    if not content[0].strip():
        return sorted(problems + [(1, "the first line must be a title line, not blank")])

    blank = next((i for i, line in enumerate(content) if not line.strip()), len(content))
    for i in range(blank):
        if i in task_lines:
            continue
        if i > 0 and style["one_line"]:
            problems.append((i + 1, "one_line is on: write a single title line"))
            continue
        reason = title_problem(content[i], style)
        if reason:
            problems.append((i + 1, reason))

    if not style["description"]:
        # 正文按段报：每段只报第一行
        starts_paragraph = True
        for i in range(blank, len(content)):
            line = content[i]
            if not line.strip():
                starts_paragraph = True
                continue
            if starts_paragraph and i not in task_lines:
                if title_problem(line, style) is None:
                    problems.append(
                        (i + 1, "title lines go together at the top, with no blank line between them")
                    )
                else:
                    problems.append(
                        (i + 1, "body text, but description is off: only title lines and a last `Task:` line")
                    )
            starts_paragraph = False
    return sorted(problems)


def read_message(path: str | None) -> str:
    if path is None or path == "-":
        return sys.stdin.read()
    return Path(path).read_text(encoding="utf-8")


def cmd_check(path: str | None) -> int:
    repo_root = get_repo_root()
    try:
        text = read_message(path)
    except (OSError, UnicodeDecodeError) as e:
        print(f"Error: cannot read the message: {e}", file=sys.stderr)
        return 2

    found = find_commitlint(repo_root)
    if found:
        names = ", ".join(f"`{name}`" for name in found)
        print(
            "Not checked: this project has its own commitlint rules "
            f"({names}), which take precedence over the ATW style; use the "
            "project's commitlint to check the message instead. This is not "
            "a pass: if commitlint cannot run here, say so."
        )
        return EXIT_NOT_CHECKED

    problems = check_message(text, get_commit_message_style(repo_root))
    if not problems:
        print("Commit message OK.")
        return 0
    for number, reason in problems:
        print(f"line {number}: {reason}")
    return 1


def cmd_rules() -> int:
    repo_root = get_repo_root()
    found = find_commitlint(repo_root)
    if found:
        sys.stdout.write(render_commitlint_rules(found))
    else:
        sys.stdout.write(render_rules(get_commit_message_style(repo_root)))
    return 0


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in ("rules", "check"):
        print(f"Usage: {sys.argv[0]} rules | check [FILE]", file=sys.stderr)
        return 2
    if argv[0] == "rules":
        if len(argv) > 1:
            print(f"Usage: {sys.argv[0]} rules", file=sys.stderr)
            return 2
        return cmd_rules()
    if len(argv) > 2:
        print(f"Usage: {sys.argv[0]} check [FILE]", file=sys.stderr)
        return 2
    return cmd_check(argv[1] if len(argv) > 1 else None)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

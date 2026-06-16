# Margent Agent Skill

This folder is the shared agent instruction pack for Margent.

Claude Code and Codex can both use the same `SKILL.md`. The skill teaches an agent how to use the installed `margent` CLI, how to work with `.mdreview/` sidecars, and how to keep comments, replies, and revision proposals attached to Markdown passages.

Install it with:

```sh
margent install --agent-skills
```

That copies this skill into:

- `~/.claude/skills/margent`
- `~/.codex/skills/margent`

Use `--force` to replace an existing installed copy:

```sh
margent install --agent-skills --force
```

The skill contains no provider credentials. Codex and Claude authentication is handled by the user's own provider CLIs, not by Margent.

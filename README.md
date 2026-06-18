# JC AI Imagegen Codex Skill

This repository publishes the `jc-ai-imagegen` Codex skill.

## Install

Ask Codex to install from this repository path:

```text
Install this Codex skill from GitHub:
https://github.com/<owner>/<repo>/tree/main/skills/jc-ai-imagegen
```

After installation, restart Codex so it can load the new skill.

## Skill

The skill generates or edits images through the JC AI NewAPI gateway using `skills/jc-ai-imagegen/scripts/generate.mjs`.

Users should provide their own authentication through Codex auth, `JC_AI_API_KEY`, or `OPENAI_API_KEY`.

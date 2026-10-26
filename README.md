# Nutriq CLI

Read your Pancara Nutriq meals, nutrition trends, profile, family, plans, health measurements, and device status from your terminal or an AI assistant.

## Install

Requires Node.js 22 or later and npm. This repository contains the built CLI, ready to install:

```sh
npm install -g github:pancara-ai/cli
nutriq --version
nutriq login
```

Open the authorization link or scan the QR code with the Nutriq App. Choose the data you want to share and confirm access.

## Use

```sh
nutriq today
nutriq meals --date 2026-09-21
nutriq meal <meal_id>
nutriq trends
nutriq trends --period recent_7_days
nutriq profile
nutriq family
nutriq --help
```

Append `--json` for structured output. Run `nutriq <command> --help` for available options. Run `nutriq logout` to revoke this computer's CLI connection.

Trends default to this week. Use `--period recent_7_days` for the last seven days including today, or `--week YYYY-MM-DD` for a specific week (takes precedence over `--period`). Text output includes meal start time and duration, diet structure, and plan diners, groceries and reminder state.

## Agent skill

```sh
npx skills add pancara-ai/skills --skill nutriq -g -y
```

The skill provides installation, authorization, and data interpretation instructions. Account access requires your confirmation.

[Nutriq CLI](https://platform.pancara.ai/nutriq/cli/)

# Nutriq CLI

Read your Pancara Nutriq meals, nutrition trends, profile, family, plans, health measurements, and device status from your terminal or an AI assistant.

## Install

Requires Node.js 22 or later and npm. This repository contains the built CLI, ready to install:

```sh
npm install -g https://github.com/pancara-ai/cli/archive/refs/tags/v0.1.0.tar.gz
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
nutriq profile
nutriq family
nutriq --help
```

Append `--json` for structured output. Run `nutriq <command> --help` for available options. Run `nutriq logout` to revoke this computer's CLI connection.

## Agent skill

```sh
npx skills add pancara-ai/skills --skill nutriq -g -y
```

The skill provides installation, authorization, and data interpretation instructions. Account access requires your confirmation.

[Nutriq](https://platform.pancara.ai/nutriq)

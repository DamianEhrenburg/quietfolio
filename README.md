<p align="center">
  <img src="assets/branding/quietfolio-logo-mark-512.png" width="76" alt="Quietfolio logo">
</p>

<h1 align="center">Quietfolio</h1>

<p align="center">
  A calm desktop catalog for the books on your shelf.
</p>

<p align="center">
  <a href="https://github.com/DamianEhrenburg/quietfolio/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/DamianEhrenburg/quietfolio/check.yml?branch=main&style=flat-square&label=check" alt="check status"></a>
  <a href="https://github.com/DamianEhrenburg/quietfolio/tags"><img src="https://img.shields.io/github/v/tag/DamianEhrenburg/quietfolio?style=flat-square&label=version" alt="version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Electron-41-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/SQLite-local-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
</p>

<p align="center">
  <img src="docs/screenshots/home.png" width="1100" alt="Quietfolio home screen">
</p>

<p align="center"><sub>Home: continue reading, recent books, quick stats</sub></p>

<p align="center">
  <img src="docs/screenshots/library.png" width="1100" alt="Quietfolio library">
</p>

<p align="center"><sub>Library: cover grid, filters, book details</sub></p>

<p align="center">
  <img src="docs/screenshots/discover.png" width="1100" alt="Quietfolio catalog search">
</p>

<p align="center"><sub>Discover: FantLab, Wikidata, Open Library, Google Books, Gutendex, Hardcover, local INPX hints</sub></p>

## What It Does

Quietfolio keeps a personal home library on your computer: reading status, favorites, ratings, review notes, covers, editions, and online catalog search. It uses local SQLite storage and does not require an account.

## Features

- Personal library with reading statuses, favorites, ratings, notes, and metadata.
- Cover cache with local `quietfolio-cover://` URLs and graceful fallbacks.
- Catalog search across FantLab, Wikidata, Open Library, Google Books, Gutendex, optional Hardcover, and optional INPX metadata.
- Russian and English UI with a first-launch language picker.
- Local-first desktop app: no cloud account, no hosted backend.

Import/export is not implemented in `0.5.0`.

## Install

Requirements: Node.js 20+, npm 10+, Windows/macOS/Linux.

```bash
git clone https://github.com/DamianEhrenburg/quietfolio.git
cd quietfolio
npm install
npm run dev
```

Production build:

```bash
npm run build
npm start
```

Google Books is optional. Add an API key in **Settings** if you want keyed requests.

## Development

```bash
npm run check
```

The check script runs ESLint, TypeScript, a production build, asset verification, and search hint verification.

## Privacy

Library data is stored in the Electron `userData` directory as local SQLite files. Optional API keys are saved through Electron `safeStorage` when encryption is available.

## Roadmap

Import/export, EPUB/PDF reader, CBZ support, and packaged installers for Windows/macOS.

<details>
<summary>Русский</summary>

Quietfolio — спокойный каталог домашней библиотеки для компьютера: статусы чтения, избранное, оценки, заметки, обложки, издания и поиск по онлайн-каталогам. Данные хранятся локально в SQLite, аккаунт не нужен.

```bash
npm install
npm run dev
```

</details>

<p align="center">
  <sub>Damian Ehrenburg · <a href="https://github.com/DamianEhrenburg">GitHub</a> · <a href="https://damianehrenburg.neocities.org">site</a></sub>
</p>

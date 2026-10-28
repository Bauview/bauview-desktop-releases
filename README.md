# BauView Desktop – Updates

Dieses Repository enthält nur die veröffentlichten Installer der BauView-Desktop-App (Windows).
Die installierte App prüft beim Start und alle 4 Stunden hier auf eine neue Version (electron-updater, GitHub Releases)
und bietet das Update automatisch an.

Neueste Version: siehe „Releases".

## Neue Version veröffentlichen
`app/index.html` (Live-Build) ersetzen und `version` in `package.json` erhöhen → push auf `main`.
Der Workflow `.github/workflows/release.yml` baut den Installer auf einem Windows-Runner und veröffentlicht ihn als Release.

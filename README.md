# Oracle Fusion BIP VS Code Extension

This extension connects Visual Studio Code to Oracle Fusion BI Publisher so you can manage Fusion BIP connections, install the bundled report artifact, run SQL from the editor, page through results, and export full result sets to CSV or Excel.

It is designed around a fixed BIP report path:

- `/Custom/VS Code Extension/VS_CODE_EXTENSION.xdo`

The extension uses that report as the execution surface for SQL sent through the Fusion SOAP services.

## Features

- Manage multiple Oracle Fusion BIP connections from a dedicated Activity Bar view.
- Store connection metadata in workspace settings while keeping passwords in VS Code Secret Storage.
- Test connection reachability, credentials, and report availability before saving.
- Offer report installation when the required BIP object is missing.
- Run the current SQL statement or selected SQL directly from the editor.
- Page through large result sets in a dedicated Results panel.
- Export the full result set to CSV or XLSX.
- Stop an in-flight query.

## How It Works

The extension talks to Oracle Fusion using SOAP endpoints:

- Query execution: `.../xmlpserver/services/ExternalReportWSSService`
- Report upload and validation: `.../xmlpserver/services/v2/CatalogService`

When you run a query, the extension sends your SQL as the `p_sql` parameter to the bundled BI Publisher report. Results are returned as XML, parsed into rows, and shown in the Results panel.

## Requirements

You need all of the following:

- Access to an Oracle Fusion environment with BI Publisher enabled.
- A Fusion base URL such as `https://example.fa.us2.oraclecloud.com`.
- A Fusion username and password with permission to run the report and, if needed, upload BIP objects.
- Network access from your machine to the Fusion environment.

## Getting Started

1. Open the `Fusion BIP` view in the VS Code Activity Bar.
2. Run `BIP: Create Connection`.
3. Enter a connection name, Fusion base URL, username, and password.
4. Use `Test Connection` before saving.
5. If the report is missing, allow the extension to install it or run `BIP: Install Report` later.
6. Open a SQL file or any editor containing SQL.
7. Run `BIP: Run Query` or press `Shift+Enter`.

## Using the Extension

### Connections

The Connections view lets you:

- Create a new connection.
- Select the active connection.
- Edit an existing connection.
- Delete a connection.

Clicking a connection in the tree marks it as active.

### Running SQL

The extension uses the current selection when text is highlighted. If nothing is selected, it runs the full editor content.

Available entry points:

- `Shift+Enter`
- Editor title action
- Editor context menu
- Command Palette via `BIP: Run Query`

### Results Panel

Query results appear in the `Fusion BIP` panel with:

- Previous and next page navigation
- Page sizes of `5`, `10`, `50`, `100`, `200`, or `all`
- Query timing and row range metadata
- `Export CSV`
- `Export Excel`
- `Clear Output`

### Export Behavior

Exports always fetch the full result set, not just the current page shown in the panel.

- CSV export writes UTF-8 text.
- Excel export writes an `.xlsx` workbook.
- Default export targets are created in your Downloads folder.

## Commands

- `BIP: Configure Connection`
- `BIP: Create Connection`
- `BIP: Select Connection`
- `BIP: Edit Connection`
- `BIP: Set Active Connection`
- `BIP: Delete Connection`
- `BIP: Install Report`
- `BIP: Run Query`
- `BIP: Stop Query`
- `BIP: Export CSV`
- `BIP: Export Excel`
- `BIP: Clear Output`

## Extension Settings

This extension contributes the following workspace settings:

- `oracleFusionBIPVSCodeExtension.activeConnectionId`: The active saved connection id.
- `oracleFusionBIPVSCodeExtension.connections`: Saved connection metadata.

Passwords are not stored in workspace settings. They are stored in VS Code Secret Storage.

## Report Installation

The extension ships with a bundled Fusion BIP artifact in `fusion_report/VS Code Extension.zip`.

Installation uploads the report bundle to:

- `/Custom/VS Code Extension`

The fixed runtime report path is:

- `/Custom/VS Code Extension/VS_CODE_EXTENSION.xdo`

## Known Limitations

- Returned values are currently treated as strings in the parsed result set.
- If your SQL already ends with an Oracle `OFFSET ... FETCH ...` or `FETCH FIRST/NEXT ...` clause, the extension does not rewrite paging and uses the SQL as-is.
- The page size option `all` uses a larger fetch size for browsing, but exports still perform a complete refetch.
- The extension does not validate SQL syntax before submission to Fusion.

## Development

### Build

```bash
npm install
npm run watch
```

### Test

```bash
npm test
```

### Integration Tests

Integration tests can be enabled with a local `.env.test.local` file. Supported variables include:

- `BIP_E2E_ENABLED`
- `BIP_INSTALLED_URL`
- `BIP_NO_REPORT_URL`
- `BIP_USERNAME`
- `BIP_PASSWORD`
- `BIP_INVALID_URL`
- `BIP_QUERY_SQL`

These tests are intended for real Fusion environments and are skipped unless explicitly enabled.

### Publish from Git Tags

This repository is configured to publish to the Visual Studio Marketplace when you push a Git tag matching `v*` (for example, `v0.0.2`).

One-time setup:

1. Add `publisher` to `package.json` with your Marketplace publisher id.
2. Create a Personal Access Token in Visual Studio Marketplace.
3. In GitHub, add the token as repository secret `VSCE_PAT`.

Release flow:

```bash
# 1) Update package.json version and changelog
npm version patch

# 2) Push commit and tag
git push origin main --follow-tags
```

GitHub Actions workflow `.github/workflows/publish-vsce.yml` will build and run `vsce publish` automatically.

## Release Notes

### 0.0.1

Initial project version with connection management, bundled report installation, SQL execution, paging, and CSV/XLSX export.

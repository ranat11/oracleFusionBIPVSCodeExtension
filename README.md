# Oracle Fusion BIP VS Code Extension

Run Oracle Fusion BI Publisher SQL directly from VS Code with a workflow built for day-to-day query tasks.

## Features

- Create and manage multiple Fusion BIP connections in one place.
- Quickly test and save working connections.
- Run selected SQL or full editor SQL without leaving VS Code.
- View results in a dedicated panel with paging controls.
- Export complete result sets to CSV or Excel.
- Stop running queries when needed.

## What You Can Do

### Manage Connections

- Add, edit, select, and delete connections from the Fusion BIP side panel.
- Keep one connection active while switching between environments as needed.

### Run SQL Fast

- Execute highlighted SQL or the full SQL editor content.
- Launch queries from keyboard shortcut, context menu, editor action, or Command Palette.

### Work with Results

- Browse result pages in the results panel.
- Change page size based on how much data you want to inspect at once.
- Export full results to CSV or Excel for sharing and analysis.

## Requirements

- Oracle Fusion environment with BI Publisher access.
- Fusion URL, username, and password with query/report permissions.
- Network connectivity to the Fusion environment from your machine.

## Quick Start

1. Open the Fusion BIP view in the Activity Bar.
2. Create a connection and test it.
3. Open SQL in the editor.
4. Run the query.
5. Review results and export when needed.

---

## SQL Formatter

- **Automatic Formatting:** SQL and PLSQL documents are automatically formatted on save (configurable).
- **Manual Formatting:** Use the command palette or right-click to format SQL manually.
- **Configurable Options:**
	- `oracleFusionBIPVSCodeExtension.sqlFormatter.enabled`
	- `oracleFusionBIPVSCodeExtension.sqlFormatter.formatOnSave`
	- `oracleFusionBIPVSCodeExtension.sqlFormatter.keywordCase`
	- `oracleFusionBIPVSCodeExtension.sqlFormatter.identifierCase`
	- `oracleFusionBIPVSCodeExtension.sqlFormatter.indentSize`
	- `oracleFusionBIPVSCodeExtension.sqlFormatter.alignAliases`
	- `oracleFusionBIPVSCodeExtension.sqlFormatter.clauseBreaks`
	- `oracleFusionBIPVSCodeExtension.sqlFormatter.commaPlacement`
	- `oracleFusionBIPVSCodeExtension.sqlFormatter.compactParenthesesWordLimit`
- **Header Template:** Insert a customizable SQL header template with the command: `Insert SQL Header Template`.
- **Toggle:** Enable/disable the formatter with the command: `Toggle SQL Formatter`.

## Model Context Protocol (MCP) Tool

- **MCP Server:** The extension hosts an MCP server for tool execution and integration.
- **BIP Query Tool:** Exposes a tool named `bip_run_query` for executing SQL against Oracle Fusion BI Publisher and returning results as JSON.
- **Usage:** The MCP tool is used internally and can be integrated with other MCP-compatible clients or workflows.
- **Security:** Authenticated via a random token; only POST requests to `/mcp` are accepted.
- **Limitation:** Do not add row-limiting clauses (e.g., `FETCH FIRST`, `ROWNUM`)—the server limits results automatically.

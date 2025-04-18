# Documentation Context Provider MCP Server

This MCP server crawls documentation starting from a given URL, summarizes the combined text content using the Gemini API, and makes it available as context.

## Features

*   Crawls the starting URL and up to 10 linked pages within the same documentation section.
*   Uses Puppeteer for robust web page fetching.
*   Summarizes the combined text content using the Google Gemini API (`gemini-2.5-flash-preview-0417`).
*   Optionally reads a `package.json` file to provide dependency context (though this context isn't currently used in the summarization prompt).
*   Exposes a `get_doc_summary` tool for use with MCP clients like Cline or Claude Desktop.

## Prerequisites

*   [Node.js](https://nodejs.org/) (version 18 or later recommended)
*   npm (usually included with Node.js)
*   Git

## Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/godzilla675/doc-context-provider-mcp.git # Replace with your actual repo URL if different
    cd doc-context-provider-mcp # Or your chosen directory name
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Build the server:**
    ```bash
    npm run build
    ```
    This compiles the TypeScript code into JavaScript in the `build/` directory.

## Configuration

1.  **Get a Gemini API Key:**
    *   Go to [Google AI Studio](https://aistudio.google.com/).
    *   Sign in and create an API key.
    *   **Important:** Keep this key secure and do not share it publicly.

2.  **Configure your MCP Client:**
    You need to tell your MCP client (like Cline in VS Code or the Claude Desktop app) how to run this server. Find the appropriate settings file:
    *   **Cline (VS Code):** `C:\Users\Ahmed\AppData\Roaming\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
    *   **Claude Desktop (Windows):** Typically `C:\Users\YourUsername\AppData\Roaming\Claude\claude_desktop_config.json` (Replace `YourUsername`)
    *   **Claude Desktop (macOS):** Typically `~/Library/Application Support/Claude/claude_desktop_config.json`

    Open the JSON file and add the following configuration block inside the main `"mcpServers": { ... }` object. Make sure to replace `"YOUR_GEMINI_API_KEY"` with the key you obtained, and adjust the path in `"args"` if you cloned the repository to a different location.

    ```json
    "doc-context-provider": {
      "command": "node",
      "args": [
        // IMPORTANT: Update this path if you cloned the repo elsewhere!
        "C:\\Users\\Ahmed\\Documents\\Cline\\MCP\\doc-context-provider\\build\\index.js"
      ],
      "env": {
        // IMPORTANT: Replace with your actual API key
        "GEMINI_API_KEY": "YOUR_GEMINI_API_KEY"
      },
      "disabled": false,
      "autoApprove": [
          "get_doc_summary" // Optional: Auto-approve the tool if desired
      ],
      "timeout": 120, // Increased timeout due to crawling/puppeteer
      "transportType": "stdio"
    }
    ```
    *Ensure you add a comma (`,`) before this block if it's not the last entry in `mcpServers`.*

3.  **Restart your MCP Client:** Restart VS Code (if using Cline) or the Claude Desktop app for the changes to take effect. The server should now connect automatically.

## Usage

Once configured and connected, you can ask your AI assistant (like Cline) to use the tool:

`"Get a summary of the documentation at https://react.dev/learn"`

Or, if you have a relevant `package.json` on your Desktop:

`"Summarize https://nodejs.org/api/fs.html using package.json"`

## Limitations

*   **Crawl Depth:** Only crawls links found directly on the starting page (up to 10 relevant links). It does not perform a deep, recursive crawl of the entire site.
*   **Code Examples:** This version focuses on summarizing text and does not extract separate code examples due to the complexity of tracking them across multiple crawled pages.
*   **Speed:** Crawling multiple pages with Puppeteer can be slower than fetching a single page. Summarization time depends on the amount of text processed.
*   **Dynamic Content:** May struggle with sites heavily reliant on client-side JavaScript rendering if content isn't present in the initial HTML or rendered quickly.

#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import puppeteer, { Browser, Page } from 'puppeteer';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import * as fs from 'fs/promises';
import * as path from 'path';
import { URL } from 'url';

// --- Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('FATAL: GEMINI_API_KEY environment variable is required');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    // --- UPDATED MODEL NAME ---
    model: "gemini-2.5-flash-preview-04-17",
    // --- END UPDATE ---
    safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    ],
});

const MAX_TEXT_LENGTH_FOR_SUMMARY = 150000; // Increased limit slightly for multi-page content
const MAX_LINKS_TO_CRAWL = 10; // Limit the number of linked pages to crawl
const CRAWL_TIMEOUT = 30000; // Timeout for each page navigation in ms

// --- Helper Functions ---

// Extracts text content from a Puppeteer page
async function extractTextFromPage(page: Page): Promise<string> {
    try {
        return await page.evaluate(() => {
            // Remove common noise elements before extracting text
            document.querySelectorAll('script, style, nav, header, footer, .sidebar, #sidebar, noscript').forEach(el => el.remove());
            // Try specific content areas first
            const mainContent = document.querySelector('main, article, .main-content, .content, #main, #content, [role="main"]');
            let text = mainContent ? (mainContent as HTMLElement).innerText : document.body.innerText;
            // Basic cleanup
            return text.replace(/\s\s+/g, ' ').trim();
        });
    } catch (error: any) {
        console.warn(`Error extracting text from page ${page.url()}: ${error.message}`);
        return ""; // Return empty string on error
    }
}

// Crawls the initial URL and linked pages using Puppeteer
async function crawlAndExtractText(startUrl: string): Promise<string> {
    let browser: Browser | null = null;
    let combinedText = "";
    const visitedUrls = new Set<string>(); // Keep track of visited URLs

    try {
        console.log("Launching Puppeteer...");
        browser = await puppeteer.launch({ headless: true }); // Use headless: 'new' if issues arise
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'); // Set User-Agent

        const initialUrlObj = new URL(startUrl);
        const allowedOrigin = initialUrlObj.origin;
        // Define allowed path prefix (e.g., '/docs/') - adjust if needed
        const allowedPathPrefix = initialUrlObj.pathname.startsWith('/docs') ? '/docs' : '/'; // Basic heuristic

        console.log(`Navigating to initial URL: ${startUrl}`);
        await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: CRAWL_TIMEOUT });
        visitedUrls.add(page.url()); // Add final URL after redirects

        console.log("Extracting text from initial page...");
        combinedText += await extractTextFromPage(page) + "\n\n---\n\n"; // Add separator

        console.log("Extracting links from initial page...");
        const links = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a'), a => a.href)
        );

        const validLinksToCrawl: string[] = [];
        for (const link of links) {
            try {
                const linkUrlObj = new URL(link, startUrl); // Resolve relative links
                const absoluteLink = linkUrlObj.href.split('#')[0]; // Remove fragment

                // Filter links: same origin, allowed path, not visited, not an obvious file download
                if (linkUrlObj.origin === allowedOrigin &&
                    linkUrlObj.pathname.startsWith(allowedPathPrefix) &&
                    !visitedUrls.has(absoluteLink) &&
                    !/\.(pdf|zip|png|jpg|jpeg|gif|svg|css|js)$/i.test(linkUrlObj.pathname))
                 {
                    validLinksToCrawl.push(absoluteLink);
                    visitedUrls.add(absoluteLink); // Add to visited immediately to avoid duplicates in this list
                }
            } catch (e) {
                // Ignore invalid URLs
            }
        }

        console.log(`Found ${validLinksToCrawl.length} valid links to potentially crawl (max ${MAX_LINKS_TO_CRAWL}).`);

        let crawledCount = 0;
        for (const link of validLinksToCrawl) {
            if (crawledCount >= MAX_LINKS_TO_CRAWL) {
                console.log("Reached max links to crawl limit.");
                break;
            }
            crawledCount++;
            console.log(`Crawling linked page (${crawledCount}/${MAX_LINKS_TO_CRAWL}): ${link}`);
            try {
                await page.goto(link, { waitUntil: 'networkidle2', timeout: CRAWL_TIMEOUT });
                 // Check final URL after potential redirects, add if not already visited
                const finalUrl = page.url().split('#')[0];
                if (!visitedUrls.has(finalUrl)) {
                    visitedUrls.add(finalUrl);
                }
                combinedText += await extractTextFromPage(page) + "\n\n---\n\n"; // Add separator
            } catch (error: any) {
                console.warn(`Failed to navigate to or process ${link}: ${error.message}`);
            }
        }

        return combinedText;

    } catch (error: any) {
        console.error(`Puppeteer crawling failed: ${error.message}`);
        // Return whatever text was gathered, or throw error
        if (combinedText.length > 0) {
            return combinedText + "\n\n[Crawling interrupted due to error]";
        } else {
             throw new McpError(ErrorCode.InternalError, `Crawling failed for ${startUrl}: ${error.message}`);
        }
    } finally {
        if (browser) {
            console.log("Closing Puppeteer browser...");
            await browser.close();
        }
    }
}


async function summarizeText(text: string): Promise<string> {
    if (!text || text.trim().length === 0) {
        return "No textual content found to summarize.";
    }
    const truncatedText = text.length > MAX_TEXT_LENGTH_FOR_SUMMARY
        ? text.substring(0, MAX_TEXT_LENGTH_FOR_SUMMARY) + "\n[Content truncated due to length]"
        : text;

    const prompt = `Analyze the following technical documentation (combined from multiple pages) for [Library Name, e.g., Next.js App Router]. Extract the essential information required for an AI coding agent to *learn how to implement features* using this library/framework. Focus specifically on:

1.  **Key API Usage:** Identify core functions, components, hooks, or classes. For each, provide:
    *   A brief description of its purpose.
    *   Its basic signature or essential props/parameters.
    *   A concise, typical code example demonstrating its use in context.
2.  **Core Implementation Patterns:** Describe the standard sequence of steps or code structure for common tasks (e.g., defining a route, fetching data, handling state, applying configuration). Include minimal code snippets for illustration.
3.  **Essential Configuration:** Detail any necessary setup, configuration files, or options required to use key features.
4.  **Critical Gotchas/Best Practices (Code-Level):** Mention any common coding errors, important considerations, or specific best practices directly related to writing code with this library.

Avoid high-level conceptual explanations or introductory marketing language. Prioritize actionable details and code examples relevant for code generation.:\n\n---\n${truncatedText}\n---`;

    try {
        // The model object is already configured with the new model name
        const result = await model.generateContent(prompt);
        const response = result.response;
        if (response && response.text) {
             return response.text();
        } else {
            console.warn("Gemini response was empty or invalid.");
            // Check for specific finish reasons if available in the response structure
            const finishReason = response?.candidates?.[0]?.finishReason;
            const safetyReason = response?.promptFeedback?.blockReason;
            if (safetyReason) {
                 return `Summarization blocked due to safety settings: ${safetyReason}`;
            } else if (finishReason && finishReason !== 'STOP') {
                 return `Summarization failed: Model finished unexpectedly (${finishReason}).`;
            }
            return "Summarization failed: No valid response text from model.";
        }
    } catch (error: any) {
        console.error("Gemini API Error:", error);
        // Attempt to extract more specific error details if possible
        const message = error?.response?.candidates?.[0]?.finishReason || error.message || "Unknown error during summarization";
        const blockReason = error?.response?.promptFeedback?.blockReason;
        if (blockReason) {
             return `Summarization blocked due to safety settings: ${blockReason}`;
        }
        throw new McpError(ErrorCode.InternalError, `Failed to summarize text using Gemini: ${message}`);
    }
}


async function getPackageVersions(filePath: string): Promise<Record<string, string> | string> {
    try {
        const absolutePath = path.resolve(process.cwd(), filePath);
        if (!await fs.stat(absolutePath).then(s => s.isFile()).catch(() => false)) {
             return `Dependency file not found at: ${absolutePath}`;
        }
        const content = await fs.readFile(absolutePath, 'utf-8');
        const packageJson = JSON.parse(content);
        const versions: Record<string, string> = {};
        const dependencies = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}), ...(packageJson.peerDependencies || {}) };
        for (const [pkg, version] of Object.entries(dependencies)) {
            if (typeof version === 'string') { versions[pkg] = version.replace(/^[~^]/, ''); }
        }
        if (Object.keys(versions).length === 0) { return `No dependencies found in ${filePath}.`; }
        return versions;
    } catch (error: any) {
        console.error(`Failed to read or parse package file ${filePath}: ${error.message}`);
        if (error instanceof SyntaxError) { return `Error parsing JSON in ${filePath}: ${error.message}`; }
        else if (error.code === 'ENOENT') { return `Dependency file not found at resolved path: ${path.resolve(process.cwd(), filePath)}`; }
        return `Error processing dependency file ${filePath}: ${error.message}`;
    }
}


// --- MCP Server Implementation ---

interface GetDocSummaryArgs {
  url: string;
  dependencyFile?: string;
}

const isValidGetDocSummaryArgs = (args: any): args is GetDocSummaryArgs =>
  typeof args === 'object' && args !== null && typeof args.url === 'string' &&
  (args.dependencyFile === undefined || typeof args.dependencyFile === 'string');


class DocContextProviderServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: 'doc-context-provider', version: '0.2.1', description: 'Crawls and summarizes documentation context from a starting URL and its linked pages using Gemini.' }, // Incremented version slightly
      { capabilities: { resources: {}, tools: {} } }
    );
    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => { console.log("Shutting down server..."); await this.server.close(); process.exit(0); });
    process.on('SIGTERM', async () => { console.log("Shutting down server..."); await this.server.close(); process.exit(0); });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_doc_summary',
          description: 'Crawls documentation starting from a URL, summarizes combined text using Gemini, and optionally lists package versions.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', format: 'uri', description: 'The starting URL of the documentation to crawl and process.' },
              dependencyFile: { type: 'string', description: 'Optional path to package.json (relative to Desktop CWD).' },
            },
            required: ['url'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'get_doc_summary') {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
      if (!isValidGetDocSummaryArgs(request.params.arguments)) {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments. Requires "url" (string, valid URI) and optional "dependencyFile" (string).');
      }

      const { url, dependencyFile } = request.params.arguments;
      try { new URL(url); } catch (_) { throw new McpError(ErrorCode.InvalidParams, `Invalid URL format: ${url}`); }

      try {
        console.log(`Processing crawl request for URL: ${url}${dependencyFile ? ` with dependency file: ${dependencyFile}` : ''}`);

        // 1. Crawl and Extract Text
        console.log("Starting crawl and text extraction...");
        const combinedText = await crawlAndExtractText(url);
        console.log(`Crawling complete. Total text length: ${combinedText.length}`);

        // 2. Summarize text
        console.log("Summarizing combined text using gemini-2.5-flash-preview-04-17..."); // Log model used
        const summary = await summarizeText(combinedText);
        console.log("Summarization complete.");

        // 3. Handle dependency file (optional)
        let packageVersionsResult: Record<string, string> | string = "No dependency file provided.";
        if (dependencyFile) {
            console.log(`Processing dependency file: ${dependencyFile}`);
            packageVersionsResult = await getPackageVersions(dependencyFile);
            if (typeof packageVersionsResult === 'string') { console.warn(`Dependency file processing result: ${packageVersionsResult}`); }
            else { console.log(`Found ${Object.keys(packageVersionsResult).length} dependencies.`); }
        }

        // 4. Format and return result (No codeExamples)
        const result = {
          summary: summary,
          packageVersions: packageVersionsResult,
          originalUrl: url,
          // Note: codeExamples field is removed
        };

        const responseText = JSON.stringify(result, null, 2); // Create the JSON string first

        console.log("Request processed successfully.");
        return {
          // MCP content type should be 'text', even if the text contains JSON
          content: [{ type: 'text', text: responseText }], // Use the pre-created string
        };
      } catch (error: any) {
         console.error(`Error processing request for ${url}:`, error);
         if (error instanceof McpError) { throw error; }
         else { throw new McpError(ErrorCode.InternalError, `An unexpected error occurred: ${error.message}`); }
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Crawling Documentation Context Provider MCP server running on stdio');
  }
}

// --- Start the server ---
async function startServer() {
    try {
        console.error("Initializing DocContextProviderServer..."); // Log initialization start
        const server = new DocContextProviderServer();
        console.error("Server instance created. Starting run..."); // Log before run
        await server.run(); // Await the run method
        console.error("Server run method completed (should not happen in normal stdio operation)."); // Log if run completes unexpectedly
    } catch (error) {
        // Log any error during initialization or run setup
        console.error("Critical error during server startup:", error);
        process.exit(1); // Exit on critical startup error
    }
}

// Add unhandled rejection/exception listeners for broader catching
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optionally exit or log more details
});

process.on('uncaughtException', (err, origin) => {
  console.error(`Caught exception: ${err}\n` + `Exception origin: ${origin}`);
  // Optionally exit
  process.exit(1);
});


startServer(); // Call the async function to start

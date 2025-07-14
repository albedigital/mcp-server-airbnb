#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  McpError,
  ErrorCode,
  InitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { cleanObject, flattenArraysInObject, pickBySchema } from "./util.js";
import robotsParser from "robots-parser";
import express from "express";
import { createServer, IncomingMessage } from "node:http";

// Tool definitions
const AIRBNB_SEARCH_TOOL: Tool = {
  name: "airbnb_search",
  description:
    "Search for Airbnb listings with various filters and pagination. Provide direct links to the user",
  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "Location to search for (city, state, etc.)",
      },
      placeId: {
        type: "string",
        description: "Google Maps Place ID (overrides the location parameter)",
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)",
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)",
      },
      adults: {
        type: "number",
        description: "Number of adults",
      },
      children: {
        type: "number",
        description: "Number of children",
      },
      infants: {
        type: "number",
        description: "Number of infants",
      },
      pets: {
        type: "number",
        description: "Number of pets",
      },
      minPrice: {
        type: "number",
        description: "Minimum price for the stay",
      },
      maxPrice: {
        type: "number",
        description: "Maximum price for the stay",
      },
      cursor: {
        type: "string",
        description: "Base64-encoded string used for Pagination",
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request",
      },
    },
    required: ["location"],
  },
};

const AIRBNB_LISTING_DETAILS_TOOL: Tool = {
  name: "airbnb_listing_details",
  description:
    "Get detailed information about a specific Airbnb listing. Provide direct links to the user",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The Airbnb listing ID",
      },
      checkin: {
        type: "string",
        description: "Check-in date (YYYY-MM-DD)",
      },
      checkout: {
        type: "string",
        description: "Check-out date (YYYY-MM-DD)",
      },
      adults: {
        type: "number",
        description: "Number of adults",
      },
      children: {
        type: "number",
        description: "Number of children",
      },
      infants: {
        type: "number",
        description: "Number of infants",
      },
      pets: {
        type: "number",
        description: "Number of pets",
      },
      price: {
        type: "number",
        description: "Price for the stay",
      },
      ignoreRobotsText: {
        type: "boolean",
        description: "Ignore robots.txt rules for this request",
      },
    },
    required: ["id"],
  },
};

const AIRBNB_TOOLS = [AIRBNB_SEARCH_TOOL, AIRBNB_LISTING_DETAILS_TOOL] as const;

// Utility functions
const USER_AGENT =
  "ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)";
const BASE_URL = "https://www.airbnb.com";
const FETCH_TIMEOUT = 6000; // 6 seconds timeout

const args = process.argv.slice(2);
const IGNORE_ROBOTS_TXT = true; // args.includes("--ignore-robots-txt");

const robotsErrorMessage =
  "This path is disallowed by Airbnb's robots.txt to this User-agent. You may or may not want to run the server with '--ignore-robots-txt' args";
let robotsTxtContent = "";

// Simple robots.txt fetch
async function fetchRobotsTxt() {
  if (IGNORE_ROBOTS_TXT) {
    return;
  }

  try {
    const response = await fetchWithUserAgent(`${BASE_URL}/robots.txt`);
    robotsTxtContent = await response.text();
  } catch (error) {
    console.error("Error fetching robots.txt:", error);
    robotsTxtContent = ""; // Empty robots.txt means everything is allowed
  }
}

function isPathAllowed(path: string) {
  if (!robotsTxtContent) {
    return true; // If we couldn't fetch robots.txt, assume allowed
  }

  const robots = robotsParser(path, robotsTxtContent);
  if (!robots.isAllowed(path, USER_AGENT)) {
    console.error(robotsErrorMessage);
    return false;
  }

  return true;
}

async function fetchWithUserAgent(url: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Helper function to wait for page to be ready
async function waitForPageReady(
  html: string,
  maxRetries: number = 3
): Promise<boolean> {
  const $ = cheerio.load(html);
  const scriptElement = $("#data-deferred-state-0").first();

  if (scriptElement.length === 0) {
    console.warn("⚠️ No script element found with data-deferred-state-0");
    return false;
  }

  try {
    const scriptContent = $(scriptElement).text();
    if (!scriptContent || scriptContent.trim().length === 0) {
      console.warn("⚠️ Script element found but content is empty");
      return false;
    }

    // Try to parse the JSON to ensure it's valid
    const parsedData = JSON.parse(scriptContent);
    if (
      !parsedData.niobeClientData ||
      !parsedData.niobeClientData[0] ||
      !parsedData.niobeClientData[0][1]
    ) {
      console.warn("⚠️ Script element found but data structure is invalid");
      return false;
    }

    console.log("✅ Page data is ready and valid");
    return true;
  } catch (error) {
    console.warn("⚠️ Error parsing script content:", error);
    return false;
  }
}

// API handlers
async function handleAirbnbSearch(params: any) {
  console.log(
    "🔍 Starting Airbnb search with params:",
    JSON.stringify(params, null, 2)
  );

  const {
    location,
    placeId,
    checkin,
    checkout,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    minPrice,
    maxPrice,
    cursor,
    ignoreRobotsText = false,
  } = params;

  // Build search URL
  const searchUrl = new URL(
    `${BASE_URL}/s/${encodeURIComponent(location)}/homes`
  );
  console.log(`🌐 Built search URL: ${searchUrl.toString()}`);

  // Add placeId
  if (placeId) searchUrl.searchParams.append("place_id", placeId);

  // Add query parameters
  if (checkin) searchUrl.searchParams.append("checkin", checkin);
  if (checkout) searchUrl.searchParams.append("checkout", checkout);

  // Add guests
  const adults_int = parseInt(adults.toString());
  const children_int = parseInt(children.toString());
  const infants_int = parseInt(infants.toString());
  const pets_int = parseInt(pets.toString());

  const totalGuests = adults_int + children_int;
  if (totalGuests > 0) {
    searchUrl.searchParams.append("adults", adults_int.toString());
    searchUrl.searchParams.append("children", children_int.toString());
    searchUrl.searchParams.append("infants", infants_int.toString());
    searchUrl.searchParams.append("pets", pets_int.toString());
  }

  // Add price range
  if (minPrice) searchUrl.searchParams.append("price_min", minPrice.toString());
  if (maxPrice) searchUrl.searchParams.append("price_max", maxPrice.toString());

  // Add room type
  // if (roomType) {
  //   const roomTypeParam = roomType.toLowerCase().replace(/\s+/g, '_');
  //   searchUrl.searchParams.append("room_types[]", roomTypeParam);
  // }

  // Add cursor for pagination
  if (cursor) {
    searchUrl.searchParams.append("cursor", cursor);
  }

  // Check if path is allowed by robots.txt
  const path = searchUrl.pathname + searchUrl.search;
  console.log(`🤖 Checking robots.txt for path: ${path}`);
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    console.error(`❌ Path blocked by robots.txt: ${path}`);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: robotsErrorMessage,
              url: searchUrl.toString(),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  console.log(`✅ Path allowed by robots.txt: ${path}`);

  const allowSearchResultSchema: Record<string, any> = {
    demandStayListing: {
      id: true,
      description: true,
      location: true,
    },
    badges: {
      text: true,
    },
    structuredContent: {
      mapCategoryInfo: {
        body: true,
      },
      mapSecondaryLine: {
        body: true,
      },
      primaryLine: {
        body: true,
      },
      secondaryLine: {
        body: true,
      },
    },
    avgRatingA11yLabel: true,
    listingParamOverrides: true,
    structuredDisplayPrice: {
      primaryLine: {
        accessibilityLabel: true,
      },
      secondaryLine: {
        accessibilityLabel: true,
      },
      explanationData: {
        title: true,
        priceDetails: {
          items: {
            description: true,
            priceString: true,
          },
        },
      },
    },
    // contextualPictures: {
    //   picture: true
    // }
  };

  try {
    console.log(`📡 Fetching search results from: ${searchUrl.toString()}`);
    const response = await fetchWithUserAgent(searchUrl.toString());
    console.log(`📊 Response status: ${response.status}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    console.log(`📄 HTML content length: ${html.length} characters`);

    // Validate that the page is ready before parsing
    console.log("🔍 Validating page readiness...");
    const isPageReady = await waitForPageReady(html);
    if (!isPageReady) {
      console.error("❌ Page not ready or data not available");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error:
                  "Page not ready or data not available. The page may not have loaded completely or the data structure has changed.",
                searchUrl: searchUrl.toString(),
                htmlLength: html.length,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    const $ = cheerio.load(html);
    let staysSearchResults = {};

    try {
      console.log("🔍 Parsing search results from HTML...");
      const scriptElement = $("#data-deferred-state-0").first();
      console.log(`📜 Found script element: ${scriptElement.length > 0}`);

      const clientData = JSON.parse($(scriptElement).text())
        .niobeClientData[0][1];
      console.log("✅ Successfully parsed client data");

      const results = clientData.data.presentation.staysSearch.results;
      cleanObject(results);
      console.log(
        `🏠 Found ${results.searchResults?.length || 0} search results`
      );

      staysSearchResults = {
        searchResults: results.searchResults
          .map((result: any) =>
            flattenArraysInObject(pickBySchema(result, allowSearchResultSchema))
          )
          .map((result: any) => {
            const id = atob(result.demandStayListing.id).split(":")[1];
            return { id, url: `${BASE_URL}/rooms/${id}`, ...result };
          }),
        paginationInfo: results.paginationInfo,
      };
      console.log(
        `✅ Processed ${
          (staysSearchResults as any).searchResults?.length || 0
        } listings`
      );
    } catch (e) {
      console.error("❌ Error parsing search results:", e);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Failed to parse search results",
                details: e instanceof Error ? e.message : String(e),
                searchUrl: searchUrl.toString(),
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              searchUrl: searchUrl.toString(),
              ...staysSearchResults,
            },
            null,
            2
          ),
        },
      ],
      isError: false,
    };
  } catch (error) {
    console.error("❌ Error in handleAirbnbSearch:", error);

    let errorMessage = "Unknown error occurred";
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        errorMessage = `Request timed out after ${
          FETCH_TIMEOUT / 1000
        } seconds`;
      } else {
        errorMessage = error.message;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: errorMessage,
              searchUrl: searchUrl.toString(),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

async function handleAirbnbListingDetails(params: any) {
  console.log(
    "🏠 Starting Airbnb listing details with params:",
    JSON.stringify(params, null, 2)
  );

  const {
    id,
    checkin,
    checkout,
    adults = 1,
    children = 0,
    infants = 0,
    pets = 0,
    ignoreRobotsText = false,
  } = params;

  // Build listing URL
  const listingUrl = new URL(`${BASE_URL}/rooms/${id}`);
  console.log(`🌐 Built listing URL: ${listingUrl.toString()}`);

  // Add query parameters
  if (checkin) listingUrl.searchParams.append("check_in", checkin);
  if (checkout) listingUrl.searchParams.append("check_out", checkout);

  // Add guests
  const adults_int = parseInt(adults.toString());
  const children_int = parseInt(children.toString());
  const infants_int = parseInt(infants.toString());
  const pets_int = parseInt(pets.toString());

  const totalGuests = adults_int + children_int;
  if (totalGuests > 0) {
    listingUrl.searchParams.append("adults", adults_int.toString());
    listingUrl.searchParams.append("children", children_int.toString());
    listingUrl.searchParams.append("infants", infants_int.toString());
    listingUrl.searchParams.append("pets", pets_int.toString());
  }

  // Check if path is allowed by robots.txt
  const path = listingUrl.pathname + listingUrl.search;
  console.log(`🤖 Checking robots.txt for path: ${path}`);
  if (!ignoreRobotsText && !isPathAllowed(path)) {
    console.error(`❌ Path blocked by robots.txt: ${path}`);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: robotsErrorMessage,
              url: listingUrl.toString(),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  console.log(`✅ Path allowed by robots.txt: ${path}`);

  const allowSectionSchema: Record<string, any> = {
    LOCATION_DEFAULT: {
      lat: true,
      lng: true,
      subtitle: true,
      title: true,
    },
    POLICIES_DEFAULT: {
      title: true,
      houseRulesSections: {
        title: true,
        items: {
          title: true,
        },
      },
    },
    HIGHLIGHTS_DEFAULT: {
      highlights: {
        title: true,
      },
    },
    DESCRIPTION_DEFAULT: {
      htmlDescription: {
        htmlText: true,
      },
    },
    AMENITIES_DEFAULT: {
      title: true,
      seeAllAmenitiesGroups: {
        title: true,
        amenities: {
          title: true,
        },
      },
    },
    HERO_DEFAULT: true,
    BOOK_IT_SIDEBAR: true,
  };

  try {
    console.log(`📡 Fetching listing details from: ${listingUrl.toString()}`);
    const response = await fetchWithUserAgent(listingUrl.toString());
    console.log(`📊 Response status: ${response.status}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    console.log(`📄 HTML content length: ${html.length} characters`);

    // Validate that the page is ready before parsing
    console.log("🔍 Validating page readiness...");
    const isPageReady = await waitForPageReady(html);
    if (!isPageReady) {
      console.error("❌ Page not ready or data not available");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error:
                  "Page not ready or data not available. The page may not have loaded completely or the data structure has changed.",
                listingUrl: listingUrl.toString(),
                htmlLength: html.length,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    const $ = cheerio.load(html);
    let details = {};

    try {
      console.log("🔍 Parsing listing details from HTML...");
      const scriptElement = $("#data-deferred-state-0").first();
      console.log(`📜 Found script element: ${scriptElement.length > 0}`);

      const clientData = JSON.parse($(scriptElement).text())
        .niobeClientData[0][1];
      console.log("✅ Successfully parsed client data");

      const sections =
        clientData.data.presentation.stayProductDetailPage.sections.sections;
      console.log(`📋 Found ${sections?.length || 0} sections`);

      sections.forEach((section: any) => cleanObject(section));
      console.log("###SECTIONS", sections);
      details = sections
        .filter((section: any) =>
          allowSectionSchema.hasOwnProperty(section.sectionId)
        )
        .map((section: any) => {
          return {
            id: section.sectionId,
            ...flattenArraysInObject(
              pickBySchema(
                section.section,
                allowSectionSchema[section.sectionId]
              )
            ),
          };
        });
      console.log(`✅ Processed ${(details as any[]).length} sections`);
    } catch (e) {
      console.error("❌ Error parsing listing details:", e);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Failed to parse listing details",
                details: e instanceof Error ? e.message : String(e),
                listingUrl: listingUrl.toString(),
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              listingUrl: listingUrl.toString(),
              details: details,
            },
            null,
            2
          ),
        },
      ],
      isError: false,
    };
  } catch (error) {
    console.error("❌ Error in handleAirbnbListingDetails:", error);

    let errorMessage = "Unknown error occurred";
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        errorMessage = `Request timed out after ${
          FETCH_TIMEOUT / 1000
        } seconds`;
      } else {
        errorMessage = error.message;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: errorMessage,
              listingUrl: listingUrl.toString(),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

// Server setup
const server = new Server(
  {
    name: "airbnb",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

console.error(
  `Server started with options: ${
    IGNORE_ROBOTS_TXT ? "ignore-robots-txt" : "respect-robots-txt"
  }`
);

// Set up request handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.log("🔧 ListTools request received");
  return {
    tools: AIRBNB_TOOLS,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.log(`🛠️ CallTool request received - Tool: ${request.params.name}`);
  console.log(
    `📋 Arguments:`,
    JSON.stringify(request.params.arguments, null, 2)
  );

  try {
    // Ensure robots.txt is loaded
    if (!robotsTxtContent) {
      console.log("🤖 Loading robots.txt...");
      await fetchRobotsTxt();
      console.log("✅ robots.txt loaded");
    }

    let result;
    switch (request.params.name) {
      case "airbnb_search": {
        console.log("🔍 Handling airbnb_search request");
        result = await handleAirbnbSearch(request.params.arguments);
        break;
      }

      case "airbnb_listing_details": {
        console.log("🏠 Handling airbnb_listing_details request");
        result = await handleAirbnbListingDetails(request.params.arguments);
        break;
      }

      default:
        console.error(`❌ Unknown tool: ${request.params.name}`);
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
    }

    console.log(`✅ Tool execution completed - Success: ${!result.isError}`);
    return result;
  } catch (error) {
    console.error(`❌ Error in CallTool handler:`, error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
      isError: true,
    };
  }
});

// Map to store SSE transports by session ID
const sseTransports: { [sessionId: string]: SSEServerTransport } = {};

// Create Express app for HTTP server
const app = express();

// IMPORTANT: Do NOT apply any global body parsers. We'll handle manually per-route.

// Handle SSE connections (GET /mcp) - this remains unchanged
app.get("/mcp", (req, res) => {
  const sessionId = req.query.sessionId as string;
  console.log(`🔗 New SSE connection request - SessionId: ${sessionId}`);

  if (!sessionId) {
    console.error("❌ Missing sessionId parameter");
    res.status(400).send("Missing sessionId parameter");
    return;
  }

  console.log(`✅ Creating SSE transport for session: ${sessionId}`);
  const transport = new SSEServerTransport("/mcp", res);
  sseTransports[sessionId] = transport;
  console.log(
    `📊 Transport created, total sessions: ${Object.keys(sseTransports).length}`
  );

  // Clean up transport when closed
  transport.onclose = () => {
    console.log(`🔌 SSE transport closed for session: ${sessionId}`);
    delete sseTransports[sessionId];
    console.log(
      `📊 Session removed, remaining sessions: ${
        Object.keys(sseTransports).length
      }`
    );
  };

  // Connect to the MCP server
  console.log(
    `🔄 Connecting transport to MCP server for session: ${sessionId}`
  );
  server
    .connect(transport)
    .then(() => {
      console.log(
        `✅ Transport connected successfully for session: ${sessionId}`
      );
    })
    .catch((error) => {
      console.error(
        `❌ Error connecting transport for session ${sessionId}:`,
        error
      );
      res.status(500).send("Internal server error");
    });
});

// Handle POST messages to SSE transports (POST /mcp)
app.post("/mcp", (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  console.log(`📨 POST message received - SessionId: ${sessionId}`);
  console.log(`📋 Request headers:`, JSON.stringify(req.headers, null, 2));

  if (!sessionId || !sseTransports[sessionId]) {
    console.error(`❌ Invalid or missing session ID: ${sessionId}`);
    console.log(
      `📊 Available sessions: ${Object.keys(sseTransports).join(", ")}`
    );
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  console.log(`✅ Processing POST message for session: ${sessionId}`);
  const transport = sseTransports[sessionId];

  try {
    console.log(`🔄 Calling transport.handlePostMessage...`);
    // Let the transport handle the request directly - it will read the body itself
    transport
      .handlePostMessage(req, res)
      .then(() => {
        console.log(
          `✅ POST message processed successfully for session: ${sessionId}`
        );
      })
      .catch((error) => {
        console.error(
          `❌ Error processing POST message for session ${sessionId}:`,
          error
        );
        if (!res.headersSent) {
          res.status(500).send("Internal server error");
        }
      });
  } catch (error) {
    console.error(`❌ Error in POST handler for session ${sessionId}:`, error);
    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    }
  }
});

// Helper function to process MCP requests
async function processMcpRequest(
  req: any,
  res: any,
  sessionId: string,
  parsedBody: any
) {
  if (!sessionId || !sseTransports[sessionId]) {
    console.error(`❌ Invalid or missing session ID: ${sessionId}`);
    console.log(
      `📊 Available sessions: ${Object.keys(sseTransports).join(", ")}`
    );
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  console.log(`✅ Processing POST message for session: ${sessionId}`);
  const transport = sseTransports[sessionId];

  // Set proper headers for SSE
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    console.log(`🔄 Calling transport.handlePostMessage...`);
    console.log(`📊 Request readable: ${req.readable}`);
    console.log(`📊 Response writable: ${res.writable}`);

    // Create a mock request object with the parsed body
    const mockReq = {
      ...req,
      body: parsedBody,
      readable: true,
    };

    await transport.handlePostMessage(mockReq, res);
    console.log(
      `✅ POST message processed successfully for session: ${sessionId}`
    );
  } catch (error) {
    console.error(
      `❌ Error processing POST message for session ${sessionId}:`,
      error
    );
    console.error(
      `❌ Error details:`,
      error instanceof Error ? error.stack : error
    );

    // Don't send error response if headers already sent
    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    }
  }
}

async function runServer() {
  const args = process.argv.slice(2);
  const useHttp = args.includes("--http");
  const port = parseInt(
    args.find((arg) => arg.startsWith("--port="))?.split("=")[1] || "3000"
  );

  console.error(`🚀 Starting server with args: ${args.join(" ")}`);
  console.error(`🌐 HTTP mode: ${useHttp}, Port: ${port}`);

  if (useHttp) {
    // Run HTTP server
    console.log("🔧 Setting up HTTP server...");
    const httpServer = createServer(app);
    httpServer.listen(port, () => {
      console.error(`✅ Airbnb MCP Server running on HTTP port ${port}`);
      console.error(
        `🌐 Connect via SSE at: http://localhost:${port}/mcp?sessionId=<your-session-id>`
      );
      console.error(`📡 Server is ready to accept connections!`);
      console.log(`📊 Active sessions: ${Object.keys(sseTransports).length}`);
    });
  } else {
    // Run stdio server (default)
    console.log("🔧 Setting up stdio server...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("✅ Airbnb MCP Server running on stdio");
  }
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

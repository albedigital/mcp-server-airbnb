# Airbnb MCP Server
[![smithery badge](https://smithery.ai/badge/@openbnb-org/mcp-server-airbnb)](https://smithery.ai/server/@openbnb-org/mcp-server-airbnb)

MCP Server for searching Airbnb and get listing details.

## Tools

1. `airbnb_search`
   - Search for Airbnb listings
   - Required Input: `location` (string)
   - Optional Inputs:
     - `placeId` (string)
     - `checkin` (string, YYYY-MM-DD)
     - `checkout` (string, YYYY-MM-DD)
     - `adults` (number)
     - `children` (number)
     - `infants` (number)
     - `pets` (number)
     - `minPrice` (number)
     - `maxPrice` (number)
     - `cursor` (string)
     - `ignoreRobotsText` (boolean)
   - Returns: Array of listings with details like name, price, location, etc.

2. `airbnb_listing_details`
   - Get detailed information about a specific Airbnb listing
   - Required Input: `id` (string)
   - Optional Inputs:
     - `checkin` (string, YYYY-MM-DD)
     - `checkout` (string, YYYY-MM-DD)
     - `adults` (number)
     - `children` (number)
     - `infants` (number)
     - `pets` (number)
     - `ignoreRobotsText` (boolean)
   - Returns: Detailed listing information including description, host details, amenities, pricing, etc.

## Features

- Respects Airbnb's robots.txt rules
- Uses cheerio for HTML parsing
- No API key required
- Returns structured JSON data
- Reduces context load by flattening and picking data

## Setup

### Running the Server

The server supports two modes:

#### 1. Stdio Mode (Default)
```bash
# Run with stdio transport (for local MCP clients)
node dist/index.js

# Run with robots.txt ignored
node dist/index.js --ignore-robots-txt
```

#### 2. HTTP Mode (For Remote Connections)
```bash
# Run HTTP server on default port 3000
node dist/index.js --http

# Run HTTP server on custom port
node dist/index.js --http --port=8080

# Run HTTP server with robots.txt ignored
node dist/index.js --http --ignore-robots-txt
```

### Connecting from Another Server

When running in HTTP mode, you can connect from another server using the SSE transport:

**JavaScript/TypeScript:**
```javascript
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const transport = new SSEClientTransport({
  serverUrl: "http://your-server:3000/mcp",
  sessionId: "your-session-id"
});

const client = new Client({
  name: "airbnb-client",
  version: "1.0.0"
});

await client.connect(transport);
```

**Python:**
```python
from mcp import Client, SSEClientTransport

transport = SSEClientTransport(
    server_url="http://your-server:3000/mcp",
    session_id="your-session-id"
)

client = Client("airbnb-client", "1.0.0")
await client.connect(transport)
```

### Docker Deployment

#### Quick Start with Docker Compose
```bash
# Build and run with docker-compose
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the server
docker-compose down
```

#### Manual Docker Deployment
```bash
# Build the image
docker build -t airbnb-mcp-server .

# Run in HTTP mode (recommended for server deployment)
docker run -d -p 3000:3000 --name airbnb-mcp airbnb-mcp-server

# Run with custom port
docker run -d -p 8080:3000 --name airbnb-mcp airbnb-mcp-server node dist/index.js --http --port=3000

# Run with robots.txt ignored (for testing)
docker run -d -p 3000:3000 --name airbnb-mcp airbnb-mcp-server node dist/index.js --http --port=3000 --ignore-robots-txt
```

#### Environment Variables
- `NODE_ENV`: Set to `production` for production deployments
- `PORT`: Override the default port (3000)

### Installing on Claude Desktop
Before starting make sure [Node.js](https://nodejs.org/) is installed on your desktop for `npx` to work.
1. Go to: Settings > Developer > Edit Config

2. Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "airbnb": {
      "command": "npx",
      "args": [
        "-y",
        "@openbnb/mcp-server-airbnb"
      ]
    }
  }
}
```

To ignore robots.txt for all requests, use this version with `--ignore-robots-txt` args

```json
{
  "mcpServers": {
    "airbnb": {
      "command": "npx",
      "args": [
        "-y",
        "@openbnb/mcp-server-airbnb",
        "--ignore-robots-txt"
      ]
    }
  }
}
```
3. Restart Claude Desktop and plan your next trip that include Airbnbs!

### Other Option: Installing via Smithery

To install mcp-server-airbnb for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@openbnb-org/mcp-server-airbnb):

```bash
npx -y @smithery/cli install @openbnb-org/mcp-server-airbnb --client claude
```

## Build (for devs)

```bash
npm install
npm run build
```

## License

This MCP server is licensed under the MIT License.

## Disclaimer

Airbnb is a trademark of Airbnb, Inc.
OpenBnB is not related to Airbnb, Inc. or its subsidiaries

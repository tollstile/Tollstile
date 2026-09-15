import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './mcp-server';

// stdout carries MCP messages, so this process writes nothing else to it.
await createServer().connect(new StdioServerTransport());

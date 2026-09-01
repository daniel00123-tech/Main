import { createLogger } from "@business-mcp/core";
import { MCP_NAME } from "./constants";

const logger = createLogger(MCP_NAME);

export const log = logger.log.bind(logger);

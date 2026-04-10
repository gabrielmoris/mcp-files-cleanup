import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { COMMON_FILE_EXTENSIONS, MAX_DEPTH, MAX_FILES_TO_PROCESS } from "./utils/constants";
import { deleteFilesAndLogDeletions, findDuplicateFiles, findUselessFiles } from "./utils/file-utils";
import { formatBytes } from "./utils/format-utils";

export const server = new McpServer({
  name: "files-cleanup",
  version: "1.1.1",
});

// Find useless files
export const fileHashes: Map<string, string[]> = new Map();

server.tool(
  "find-useless-files",
  "Find useless files in a directory",
  {
    directory: z.string().describe("The directory to search"),
    maxDepth: z.number().default(5).describe("Maximum directory depth to search, max value is 10"),
    maxFiles: z.number().default(1000).describe("Maximum number of files to process"),
  },
  async ({ directory, maxDepth, maxFiles }) => {
    try {
      // Clear previous results
      fileHashes.clear();

      // Set limits
      const startTime = Date.now();
      let filesProcessed = 0;
      let totalSize = 0;

      const actualMaxDepth = Math.min(maxDepth, MAX_DEPTH);
      const actualMaxFiles = Math.min(maxFiles, MAX_FILES_TO_PROCESS);

      const result = await findUselessFiles(directory, 0, actualMaxDepth, startTime, actualMaxFiles, filesProcessed);
      const uselessFiles = result.items;
      totalSize = result.totalSize;

      const duplicates = findDuplicateFiles(COMMON_FILE_EXTENSIONS);
      if (uselessFiles.length === 0 && duplicates.length === 0) {
        throw new Error(`No useless files found in: ${directory}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${uselessFiles.length} potentially useless files/directories in: ${directory}.`,
          },
          { type: "text", text: `Found ${duplicates.length} duplicate files in: ${directory}` },
          { type: "text", text: `💾 Total size: ${formatBytes(totalSize)}` },
        ],
        structuredContent: {
          duplicates,
          uselessFiles,
        },
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new Error(`Error scanning directory: ${error.message}`);
      }
      throw new Error(String(error));
    }
  },
);

server.tool(
  "delete-files",
  "Delete array of files",
  {
    directories: z.string().array().describe("Array of directories to delete"),
  },
  async ({ directories }) => {
    try {
      // Clear previous results
      fileHashes.clear();

      if (directories.length === 0) {
        throw new Error(`Nothing to delete`);
      }

      const { numberOfDeletions } = deleteFilesAndLogDeletions(directories);

      return {
        content: [
          {
            type: "text",
            text: `Deleted ${numberOfDeletions} files. ${directories.length - numberOfDeletions} files copuldn't be deleted ${typeof directories} ${directories})}`,
          },
        ],
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new Error(`Error deleting directories: ${error.message}`);
      }
      throw new Error(String(error));
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

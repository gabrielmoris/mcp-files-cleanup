import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";
import fs from "node:fs";
import crypto from "crypto";

const MAX_FILES_TO_PROCESS = 1000;
const MAX_EXECUTION_TIME_MS = 5000;
const MAX_DEPTH = 10;
const MAX_ITEMS_PER_DIR = 100;
const COMMON_FILE_EXTENSIONS = [
  "txt",
  "js",
  "html",
  "css",
  "json",
  "xml",
  "md",
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "svg",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "mp4",
  "avi",
  "mkv",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
];

const server = new McpServer({
  name: "files-cleanup",
  version: "1.0.0",
});

// Store file hashes to detect duplicates
const fileHashes: Map<string, string[]> = new Map();

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
      const actualMaxDepth = Math.min(maxDepth, MAX_DEPTH);
      const actualMaxFiles = Math.min(maxFiles, MAX_FILES_TO_PROCESS);

      const uselessFiles = await findUselessFiles(directory, 0, actualMaxDepth, startTime, actualMaxFiles, filesProcessed); // Pass includeExtensions
      const duplicates = findDuplicateFiles(COMMON_FILE_EXTENSIONS);
      if (uselessFiles.length === 0 && duplicates.length === 0) {
        return { content: [{ type: "text", text: `No useless files found in: ${directory}` }] };
      }

      return {
        content: [
          { type: "text", text: `Found ${uselessFiles.length} potentially useless files/directories in: ${directory}` },
          { type: "text", text: uselessFiles.join("\n") },
          { type: "text", text: `Found ${duplicates.length} duplicate files in: ${directory}` },
          { type: "text", text: duplicates.join("\n") },
        ],
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        return { content: [{ type: "text", text: `Error scanning directory: ${error.message}` }] };
      }
      return { content: [{ type: "text", text: String(error) }] };
    }
  },
);

function findDuplicateFiles(includeExtensions: string[] = COMMON_FILE_EXTENSIONS): string[] {
  const duplicates: string[] = [];

  fileHashes.forEach((filePaths) => {
    if (filePaths.length > 1) {
      const original = filePaths[0];
      const dupes = filePaths.slice(1);

      dupes.forEach((dupe) => {
        const originalExtension = path.extname(original).slice(1).toLowerCase();
        const dupeExtension = path.extname(dupe).slice(1).toLowerCase();

        // Check if extensions should be included
        if (includeExtensions.length === 0 || (includeExtensions.includes(originalExtension) && includeExtensions.includes(dupeExtension))) {
          duplicates.push(`${dupe} (duplicate of ${original})`);
        }
      });
    }
  });

  return duplicates;
}

async function calculateFileHash(itemPath: string): Promise<string> {
  const stats = fs.lstatSync(itemPath);
  if (!stats.isFile()) {
    return ""; // Return empty string for non-files.
  }

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const fileStream = fs.createReadStream(itemPath);

    fileStream.on("data", (chunk) => {
      hash.update(chunk);
    });

    fileStream.on("end", () => {
      resolve(hash.digest("hex"));
    });

    fileStream.on("error", (err) => {
      reject(err);
    });
  });
}

async function findUselessFiles(
  dirPath: string,
  currentDepth = 0,
  maxDepth = 5,
  startTime = Date.now(),
  maxFiles = 1000,
  filesProcessed = 0,
): Promise<string[]> {
  const uselessFiles: string[] = [];

  if (dirPath.includes("node_modules") || dirPath.includes(".git")) {
    return uselessFiles;
  }

  // Check time limit
  if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
    uselessFiles.push(`${dirPath} (execution time limit reached)`);
    return uselessFiles;
  }

  // Check file count limit
  if (filesProcessed >= maxFiles) {
    uselessFiles.push(`${dirPath} (max files limit reached)`);
    return uselessFiles;
  }

  // Prevent excessive recursion
  if (currentDepth > maxDepth) {
    uselessFiles.push(`${dirPath} (max depth reached)`);
    return uselessFiles;
  }

  // Check if directory exists
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory does not exist: ${dirPath}`);
  }

  // Get all files and directories in the path
  let items: string[];
  try {
    items = fs.readdirSync(dirPath);
  } catch (error: unknown) {
    if (error instanceof Error) {
      return [`${dirPath} (error: ${error.message})`];
    }
    return [`${dirPath} (error: ${String(error)})`];
  }

  // Empty directory
  if (items.length === 0) {
    uselessFiles.push(`${dirPath} (empty directory)`);
    return uselessFiles;
  }

  // Process only a limited number of items per directory
  const itemsToProcess = items.slice(0, MAX_ITEMS_PER_DIR);

  if (items.length > MAX_ITEMS_PER_DIR) {
    uselessFiles.push(`${dirPath} (limited scan: ${MAX_ITEMS_PER_DIR}/${items.length} items)`);
  }

  for (const item of itemsToProcess) {
    const itemPath = path.join(dirPath, item);

    try {
      filesProcessed++;
      const stats = fs.lstatSync(itemPath);

      if (stats.isDirectory()) {
        // Recursively check subdirectories with updated limits
        const subDirResults = await findUselessFiles(itemPath, currentDepth + 1, maxDepth, startTime, maxFiles, filesProcessed); // Pass includeExtensions
        uselessFiles.push(...subDirResults);
      } else {
        // Logic to detect useless files (currently only empty ones)
        if (stats.size === 0) {
          uselessFiles.push(`${itemPath} (empty file)`);
        }

        // Add file to hash map for duplicate detection
        const fileExtension = path.extname(itemPath).slice(1).toLowerCase();
        if (COMMON_FILE_EXTENSIONS.includes(fileExtension)) {
          const fileHash = await calculateFileHash(itemPath);

          if (fileHash) {
            if (!fileHashes.has(fileHash)) {
              fileHashes.set(fileHash, [itemPath]);
            } else {
              fileHashes.get(fileHash)?.push(itemPath);
            }
          }
        }
      }

      // Check time limit again
      if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
        uselessFiles.push(`${dirPath} (execution time limit reached during processing)`);
        break;
      }

      // Check file count limit again
      if (filesProcessed >= maxFiles) {
        uselessFiles.push(`${dirPath} (max files limit reached during processing)`);
        break;
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        uselessFiles.push(`${itemPath} (error: ${error.message})`);
      } else {
        uselessFiles.push(`${itemPath} (error: ${String(error)})`);
      }
    }
  }

  return uselessFiles;
}

const transport = new StdioServerTransport();
await server.connect(transport);

import { PdfReader } from "pdfreader";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testPdfPath = path.join(__dirname, "..", "data", "cv.txt"); // Let's check if there is a pdf

console.log("pdfreader imported successfully!");

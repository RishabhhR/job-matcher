import "dotenv/config";
import { migrate } from "../src/db.js";

async function run() {
  console.log("Running migrations...");
  await migrate();
  console.log("Database migrated successfully!");
}

run().catch(console.error);

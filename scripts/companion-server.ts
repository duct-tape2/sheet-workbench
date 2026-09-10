import { createCompanionService } from "../packages/companion/src/index.ts";

const portArgument = process.argv.find((argument) =>
  argument.startsWith("--port="),
);
const port = portArgument ? Number(portArgument.slice("--port=".length)) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65_535)
  throw new Error("Use --port=0 through --port=65535.");

const cloudEndpoint = process.env.COMPANION_CLOUD_ENDPOINT;
const cloudApiKey = process.env.COMPANION_CLOUD_API_KEY;
const companion = await createCompanionService({
  port,
  cloud:
    cloudEndpoint && cloudApiKey
      ? {
          endpoint: cloudEndpoint,
          apiKey: cloudApiKey,
          model: process.env.COMPANION_CLOUD_MODEL,
        }
      : undefined,
  ollamaModel: process.env.COMPANION_OLLAMA_MODEL,
  doclingEnabled: process.env.COMPANION_DOCLING_ENABLED === "1",
});
const started = await companion.start();
console.log(`Sheet Workbench companion ready: ${started.url}`);
console.log(
  "This URL is one-use. Keep this terminal open while using the companion.",
);

const stop = async () => {
  await companion.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

import { PostHog } from "posthog-node";

const projectToken = process.env.POSTHOG_PROJECT_TOKEN;
const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";

// Keep telemetry optional and non-blocking when no monitoring project is configured.
// Never identify a person or attach request/CV/job data to these events.
const posthog = projectToken
  ? new PostHog(projectToken, { host, flushInterval: 0, disableGeoip: true, enableExceptionAutocapture: false })
  : null;

export type TelemetryProperties = Record<string, string | number | boolean | null>;

export async function captureTelemetryEvent(event: string, properties: TelemetryProperties = {}): Promise<void> {
  if (!posthog) return;
  try {
    await posthog.captureImmediate({
      distinctId: "job-matcher-service",
      event,
      properties: { ...properties, app: "job-matcher", environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development" },
      disableGeoip: true,
    });
  } catch (error) {
    console.warn("[telemetry] Event delivery failed:", error instanceof Error ? error.name : "Error");
  }
}

export async function captureTelemetryError(operation: string, error: unknown, properties: TelemetryProperties = {}): Promise<void> {
  if (!posthog) return;
  const errorType = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name) ? error.name : "Error";
  const errorCode = typeof (error as { code?: unknown } | null)?.code === "string"
    ? String((error as { code: string }).code).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)
    : undefined;
  // Use a synthetic message so raw provider responses, identifiers, URLs, and input data
  // cannot be included in the exception event. Stack frames remain useful for triage.
  try {
    const sanitizedError = new Error(`${operation} failed (${errorType})`);
    sanitizedError.name = errorType;
    if (error instanceof Error && error.stack) {
      const frames = error.stack.split("\n").slice(1).join("\n");
      if (frames) sanitizedError.stack = `${sanitizedError.name}: ${sanitizedError.message}\n${frames}`;
    }
    await posthog.captureExceptionImmediate(sanitizedError, "job-matcher-service", {
      ...properties,
      operation,
      error_type: errorType,
      ...(errorCode ? { error_code: errorCode } : {}),
      app: "job-matcher",
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    });
  } catch (captureError) {
    console.warn("[telemetry] Error delivery failed:", captureError instanceof Error ? captureError.name : "Error");
  }
}

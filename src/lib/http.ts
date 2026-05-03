import { NextResponse } from "next/server";

export function jsonError(error: unknown, status = 400) {
  return NextResponse.json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status });
}

export const handleRouteError = jsonError;

export async function parseRequestBody(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return request.json();
  }
  const formData = await request.formData();
  const data: Record<string, FormDataEntryValue | FormDataEntryValue[]> = Object.fromEntries(formData);
  for (const key of Array.from(new Set(formData.keys()))) {
    const values = formData.getAll(key);
    if (values.length > 1) {
      data[key] = values;
    }
  }
  return data;
}

export const getRequestBody = parseRequestBody;

export function minorUnitsFromInput(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("Amount must be a positive number.");
  }
  return Math.round(numeric * 100);
}

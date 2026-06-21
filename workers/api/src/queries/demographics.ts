import { eq } from "drizzle-orm";
import {
  GENDER_OPTIONS,
  SEXUAL_ORIENTATION_OPTIONS,
  type UserDemographics,
} from "@buildinternet/releases-api-types";
import type { AnyDb } from "../db.js";
import {
  userDemographics,
  type GenderOption,
  type SexualOrientationOption,
  type UserDemographicsRow,
} from "../db/schema-demographics.js";

function newDemographicsId(): string {
  return `udm_${crypto.randomUUID()}`;
}

function nowSeconds(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

const EMPTY: UserDemographics = {
  optedIn: false,
  birthYear: null,
  birthDate: null,
  gender: null,
  genderCustom: null,
  sexualOrientation: null,
  sexualOrientationCustom: null,
  countryCode: null,
};

function isEnumValue<T extends readonly string[]>(values: T, v: unknown): v is T[number] {
  return typeof v === "string" && (values as readonly string[]).includes(v);
}

function parseBirthYear(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  const year = new Date().getUTCFullYear();
  return v >= 1900 && v <= year ? v : null;
}

function parseBirthDate(v: unknown): string | null {
  if (v == null || typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return y! >= 1900 && y! <= new Date().getUTCFullYear() ? v : null;
}

function parseCountryCode(v: unknown): string | null {
  if (v == null || typeof v !== "string" || !/^[A-Z]{2}$/.test(v)) return null;
  return v;
}

function trimCustom(v: unknown, max: number): string | null {
  if (v == null || typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export type DemographicsInput = UserDemographics;
export type DemographicsValidationError = { field: string; message: string };

/** Validate and normalize a demographics PUT body. Returns null when valid. */
export function validateDemographicsInput(
  body: DemographicsInput,
): DemographicsValidationError | null {
  if (typeof body.optedIn !== "boolean") {
    return { field: "optedIn", message: "optedIn must be a boolean" };
  }

  const birthYear = parseBirthYear(body.birthYear);
  if (body.birthYear != null && birthYear === null) {
    return {
      field: "birthYear",
      message: "birthYear must be a year between 1900 and the current year",
    };
  }

  const birthDate = parseBirthDate(body.birthDate);
  if (body.birthDate != null && birthDate === null) {
    return { field: "birthDate", message: "birthDate must be YYYY-MM-DD" };
  }
  if (birthDate && birthYear && birthDate.slice(0, 4) !== String(birthYear)) {
    return { field: "birthDate", message: "birthDate year must match birthYear" };
  }
  if (birthDate && !birthYear) {
    return { field: "birthYear", message: "birthYear is required when birthDate is set" };
  }

  if (body.gender != null && !isEnumValue(GENDER_OPTIONS, body.gender)) {
    return { field: "gender", message: "gender is invalid" };
  }
  const genderCustom = trimCustom(body.genderCustom, 100);
  if (body.gender === "custom" && !genderCustom) {
    return { field: "genderCustom", message: "genderCustom is required when gender is custom" };
  }
  if (body.gender !== "custom" && genderCustom) {
    return { field: "genderCustom", message: "genderCustom is only allowed when gender is custom" };
  }

  if (
    body.sexualOrientation != null &&
    !isEnumValue(SEXUAL_ORIENTATION_OPTIONS, body.sexualOrientation)
  ) {
    return { field: "sexualOrientation", message: "sexualOrientation is invalid" };
  }
  const sexualOrientationCustom = trimCustom(body.sexualOrientationCustom, 100);
  if (body.sexualOrientation === "custom" && !sexualOrientationCustom) {
    return {
      field: "sexualOrientationCustom",
      message: "sexualOrientationCustom is required when sexualOrientation is custom",
    };
  }
  if (body.sexualOrientation !== "custom" && sexualOrientationCustom) {
    return {
      field: "sexualOrientationCustom",
      message: "sexualOrientationCustom is only allowed when sexualOrientation is custom",
    };
  }

  if (body.countryCode != null && parseCountryCode(body.countryCode) === null) {
    return { field: "countryCode", message: "countryCode must be a two-letter ISO code" };
  }

  return null;
}

function normalizeInput(body: DemographicsInput): UserDemographics {
  const birthDate = parseBirthDate(body.birthDate);
  const birthYear = birthDate ? Number(birthDate.slice(0, 4)) : parseBirthYear(body.birthYear);
  const gender = body.gender && isEnumValue(GENDER_OPTIONS, body.gender) ? body.gender : null;
  const sexualOrientation =
    body.sexualOrientation && isEnumValue(SEXUAL_ORIENTATION_OPTIONS, body.sexualOrientation)
      ? body.sexualOrientation
      : null;

  return {
    optedIn: body.optedIn,
    birthYear,
    birthDate,
    gender,
    genderCustom: gender === "custom" ? trimCustom(body.genderCustom, 100) : null,
    sexualOrientation,
    sexualOrientationCustom:
      sexualOrientation === "custom" ? trimCustom(body.sexualOrientationCustom, 100) : null,
    countryCode: parseCountryCode(body.countryCode),
  };
}

export function rowToDemographics(row: UserDemographicsRow | null): UserDemographics {
  if (!row) return { ...EMPTY };
  return {
    optedIn: row.optedIn,
    birthYear: row.birthYear ?? null,
    birthDate: row.birthDate ?? null,
    gender: (row.gender as GenderOption | null) ?? null,
    genderCustom: row.genderCustom ?? null,
    sexualOrientation: (row.sexualOrientation as SexualOrientationOption | null) ?? null,
    sexualOrientationCustom: row.sexualOrientationCustom ?? null,
    countryCode: row.countryCode ?? null,
  };
}

export async function getDemographics(db: AnyDb, userId: string): Promise<UserDemographics> {
  const row = await db
    .select()
    .from(userDemographics)
    .where(eq(userDemographics.userId, userId))
    .get();
  return rowToDemographics(row ?? null);
}

export async function setDemographics(
  db: AnyDb,
  userId: string,
  body: DemographicsInput,
): Promise<UserDemographics> {
  const normalized = normalizeInput(body);
  const now = nowSeconds();
  const existing = await db
    .select()
    .from(userDemographics)
    .where(eq(userDemographics.userId, userId))
    .get();

  const values = { ...normalized, updatedAt: now };

  if (!existing) {
    await db.insert(userDemographics).values({
      id: newDemographicsId(),
      userId,
      ...values,
      createdAt: now,
    });
    return normalized;
  }

  await db.update(userDemographics).set(values).where(eq(userDemographics.userId, userId));
  return normalized;
}
